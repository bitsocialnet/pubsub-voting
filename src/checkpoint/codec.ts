import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import { encodeCanonical, dagCborCode } from "../encoding/canonical.js";
import { encodeBundle, toWireBundle, fromWireBundle } from "../crdt/codec.js";
import type { VotesBundle } from "../schema/votes.js";

/**
 * Checkpoint codec — the compacted snapshot of a topic's current LWW winners (one bundle per
 * wallet), used for fast cold-start and storage compaction (see DESIGN.md "Checkpoints"). Pure and
 * network-free: it turns a winner set into content-addressed blocks and back, so it is unit-testable
 * offline. Fetching/publishing those blocks over libp2p is a separate, host-blocked concern.
 *
 * Format — a shallow depth-2 pagination DAG (NOT a history DAG: no parent links, regenerated fresh
 * each cut):
 *   - winners are sorted **ascending by `address`** (unique per wallet under LWW, so no tie);
 *   - the sorted bundles are packed, **full and inlined**, into chunk blocks by a size-cap fill:
 *     append bundles into a chunk until the next would push the chunk's inlined-bundle bytes over
 *     `maxChunkBytes`, then start a new chunk (a single oversized bundle still forms its own chunk);
 *   - a root block lists the chunk CIDs: `{ chunks: CID[] }`.
 *
 * Canonical dag-cbor + the address sort + the size-cap rule make the bytes a pure function of the
 * winner set, so any two seeders with the same view produce the **same root CID** and their blocks
 * dedupe. The byte layout is pinned by the fixed test vector in `codec.test.ts`.
 */

/** One content-addressed checkpoint block (a chunk, or the root manifest). */
export interface CheckpointBlock {
    cid: CID;
    bytes: Uint8Array;
}

/** The result of a checkpoint cut: the root CID plus every block to store (chunks + root). */
export interface EncodedCheckpoint {
    root: CID;
    /**
     * The chunk-CID index (the root manifest's contents), in root order. Exposed so the
     * root record can carry it (see DESIGN.md "Checkpoints", "Block pull"): a cold joiner
     * handed a verified chunk index skips the root-manifest bitswap round-trip and pulls
     * every chunk in parallel. `CID(encodeCanonical({ chunks })) === root`, so it is
     * self-verifying against the root and cannot be a new trust vector.
     */
    chunks: CID[];
    blocks: CheckpointBlock[];
}

/** The root manifest shape: an ordered list of chunk CIDs. */
interface CheckpointRoot {
    chunks: CID[];
}

/** Default chunk ceiling (bytes of inlined bundles per chunk), just under a 1 MiB block. */
export const DEFAULT_MAX_CHUNK_BYTES = 1 << 20;

async function blockFor(bytes: Uint8Array): Promise<CheckpointBlock> {
    const digest = await sha256.digest(bytes);
    return { cid: CID.createV1(dagCborCode, digest), bytes };
}

/**
 * The root-manifest block for a chunk-CID list: `{ chunks }` canonically encoded and hashed. Its
 * CID is the checkpoint root, so re-deriving it from a chunk list proves the list belongs to a
 * given root — the local check that lets a joiner trust a piggybacked chunk index (see
 * {@link decodeCheckpoint}) without fetching the manifest.
 */
async function checkpointRootBlock(chunks: CID[]): Promise<CheckpointBlock> {
    const root: CheckpointRoot = { chunks };
    return blockFor(encodeCanonical(root));
}

/**
 * Encode a winner set into checkpoint blocks. `winners` should be the CRDT's current (non-expired)
 * LWW winners; order does not matter (they are sorted here). Returns the root CID and every block to
 * persist. Deterministic: identical winners + `maxChunkBytes` ⇒ identical bytes and root CID.
 */
export async function encodeCheckpoint(
    winners: VotesBundle[],
    maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES
): Promise<EncodedCheckpoint> {
    // Lowercase before comparing so the sort equals raw byte order regardless of how a caller
    // cased an address — casing is presentation, the wire form is lowercase bytes.
    const sorted = [...winners]
        .map((bundle) => ({ bundle, key: bundle.address.toLowerCase() }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((entry) => entry.bundle);

    // Size-cap fill on the inlined-bundle byte total (a pure function of the bundles, so seeders
    // agree without encoding a partial chunk each step).
    const chunks: VotesBundle[][] = [];
    let current: VotesBundle[] = [];
    let currentBytes = 0;
    for (const bundle of sorted) {
        const size = encodeBundle(bundle).length;
        if (current.length > 0 && currentBytes + size > maxChunkBytes) {
            chunks.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(bundle);
        currentBytes += size;
    }
    if (current.length > 0) chunks.push(current);

    const blocks: CheckpointBlock[] = [];
    const chunkCids: CID[] = [];
    for (const chunk of chunks) {
        // Chunks inline the same binary wire objects the bundle block uses (see crdt/codec.ts),
        // so the binary-field byte saving multiplies across every inlined winner.
        const block = await blockFor(encodeCanonical(chunk.map(toWireBundle)));
        blocks.push(block);
        chunkCids.push(block.cid);
    }

    const rootBlock = await checkpointRootBlock(chunkCids);
    blocks.push(rootBlock);
    return { root: rootBlock.cid, chunks: chunkCids, blocks };
}

/**
 * Decode a checkpoint back into its inlined winner bundles, given a way to fetch each block by CID
 * (blockstore/bitswap). This is a *structural* decode — each bundle is schema-validated (wire shape,
 * B58 key, distinct communities) but NOT signature-verified; the caller re-verifies each through the
 * same verifier the gate uses before merging (a single seeder cannot forge or hide a vote — see
 * DESIGN.md "Checkpoints"). Throws if a referenced block is unavailable or malformed.
 */
export async function decodeCheckpoint(
    root: CID,
    getBlock: (cid: CID) => Promise<Uint8Array | undefined>,
    knownChunks?: CID[]
): Promise<VotesBundle[]> {
    // If the caller supplies a chunk index (piggybacked on the root record — see DESIGN.md
    // "Block pull"), trust it only after re-deriving the manifest and checking its CID equals
    // `root`: a lie fails this local check and falls back to the manifest fetch, so the index is
    // an optimization, never a new trust vector. When it verifies, the root-manifest bitswap
    // round-trip is skipped entirely.
    let chunks: CID[];
    if (knownChunks !== undefined && (await checkpointRootBlock(knownChunks)).cid.equals(root)) {
        chunks = knownChunks;
    } else {
        const rootBytes = await getBlock(root);
        if (!rootBytes) throw new Error(`checkpoint root block ${root.toString()} is unavailable`);
        chunks = dagCbor.decode<CheckpointRoot>(rootBytes).chunks;
    }

    // The chunks are independent blocks, so pull them concurrently (one bitswap round-trip for
    // the whole set, not one per chunk); decode preserves root order for a deterministic result.
    const perChunk = await Promise.all(
        chunks.map(async (chunkCid): Promise<VotesBundle[]> => {
            const chunkBytes = await getBlock(chunkCid);
            if (!chunkBytes) throw new Error(`checkpoint chunk block ${chunkCid.toString()} is unavailable`);
            const wires = dagCbor.decode<unknown>(chunkBytes);
            if (!Array.isArray(wires)) throw new Error(`checkpoint chunk ${chunkCid.toString()} is not a bundle array`);
            return wires.map(fromWireBundle);
        })
    );
    return perChunk.flat();
}
