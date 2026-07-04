import type { CID } from "multiformats/cid";
import type { DagNode, DagNodeStore } from "./types.js";
import { dagNodeCid } from "./codec.js";

/**
 * In-memory {@link DagNodeStore}, keyed by content address. Used by the engine's unit
 * tests and as a no-persistence default; the transport backs the same interface with the
 * host's Helia blockstore (put/get by CID, bitswap for unknown CIDs) — see DESIGN.md
 * "Transport". The store computes the CID on `put`, so callers never assign addresses.
 */
export function makeMemoryDagNodeStore(): DagNodeStore {
    const byCid = new Map<string, DagNode>();
    return {
        async put(node: DagNode): Promise<CID> {
            const cid = await dagNodeCid(node);
            byCid.set(cid.toString(), node);
            return cid;
        },
        async get(cid: CID): Promise<DagNode | undefined> {
            return byCid.get(cid.toString());
        },
        async has(cid: CID): Promise<boolean> {
            return byCid.has(cid.toString());
        }
    };
}
