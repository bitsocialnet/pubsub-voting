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

    const root: CheckpointRoot = { chunks: chunkCids };
    const rootBlock = await blockFor(encodeCanonical(root));
    blocks.push(rootBlock);
    return { root: rootBlock.cid, blocks };
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
    getBlock: (cid: CID) => Promise<Uint8Array | undefined>
): Promise<VotesBundle[]> {
    const rootBytes = await getBlock(root);
    if (!rootBytes) throw new Error(`checkpoint root block ${root.toString()} is unavailable`);
    const manifest = dagCbor.decode<CheckpointRoot>(rootBytes);

    const winners: VotesBundle[] = [];
    for (const chunkCid of manifest.chunks) {
        const chunkBytes = await getBlock(chunkCid);
        if (!chunkBytes) throw new Error(`checkpoint chunk block ${chunkCid.toString()} is unavailable`);
        const wires = dagCbor.decode<unknown>(chunkBytes);
        if (!Array.isArray(wires)) throw new Error(`checkpoint chunk ${chunkCid.toString()} is not a bundle array`);
        for (const wire of wires) winners.push(fromWireBundle(wire));
    }
    return winners;
}
