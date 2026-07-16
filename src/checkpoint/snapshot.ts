import * as dagCbor from "@ipld/dag-cbor";
import { encodeCanonical } from "../encoding/canonical.js";

/**
 * Checkpoint-snapshot container — the blob a voter persists per topic so its own last
 * fully-verified checkpoint survives a restart (see DESIGN.md "Persistent caches", checkpoint
 * snapshots). It wraps the two existing codecs rather than defining new state: `record` is the
 * fetch-protocol root record's exact wire bytes (`encodeRootRecord` — root CID, chunk index,
 * counts), and `blocks` are the checkpoint blocks those CIDs address (chunks + root manifest,
 * bytes only — CIDs are re-derived on load, so a corrupted block self-invalidates instead of
 * being trusted).
 *
 * This is a LOCAL format, not wire: nothing remote ever sees a snapshot blob, so a version bump
 * only invalidates on-disk snapshots (discarded gracefully at load) and needs no pinned vector.
 * Pure and network-free, like the rest of `src/checkpoint/`.
 */

/** Bumped on any layout change; a mismatched blob is discarded at load, never migrated. */
export const SNAPSHOT_VERSION = 1;

/** The decoded container: root-record wire bytes plus the checkpoint block bytes it references. */
export interface CheckpointSnapshot {
    record: Uint8Array;
    blocks: Uint8Array[];
}

/** Encode a snapshot blob (canonical dag-cbor, like every other byte layout in the library). */
export function encodeSnapshot(snapshot: CheckpointSnapshot): Uint8Array {
    return encodeCanonical({ v: SNAPSHOT_VERSION, record: snapshot.record, blocks: snapshot.blocks });
}

/** Decode and shape-check a snapshot blob; throws on garbage or a version mismatch. */
export function decodeSnapshot(bytes: Uint8Array): CheckpointSnapshot {
    const decoded = dagCbor.decode<unknown>(bytes);
    if (typeof decoded !== "object" || decoded === null) throw new Error("snapshot is not a map");
    const { v, record, blocks } = decoded as { v?: unknown; record?: unknown; blocks?: unknown };
    if (v !== SNAPSHOT_VERSION) throw new Error(`unsupported snapshot version ${String(v)}`);
    if (!(record instanceof Uint8Array)) throw new Error("snapshot record is not bytes");
    if (!Array.isArray(blocks) || blocks.some((block) => !(block instanceof Uint8Array))) {
        throw new Error("snapshot blocks are not a bytes array");
    }
    return { record, blocks };
}
