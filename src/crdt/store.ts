import type { CID } from "multiformats/cid";
import type { BundleStore } from "./types.js";
import type { VotesBundle } from "../schema/votes.js";
import { bundleCid } from "./codec.js";

/**
 * In-memory {@link BundleStore}, keyed by content address. Used by the engine's unit
 * tests and as a no-persistence default; the transport backs the same interface with the
 * host's Helia blockstore (put/get by CID, bitswap for unknown CIDs) — see DESIGN.md
 * "Transport". The store computes the CID on `put`, so callers never assign addresses.
 */
export function makeMemoryBundleStore(): BundleStore {
    const byCid = new Map<string, VotesBundle>();
    return {
        async put(bundle: VotesBundle): Promise<CID> {
            const cid = await bundleCid(bundle);
            byCid.set(cid.toString(), bundle);
            return cid;
        },
        async get(cid: CID): Promise<VotesBundle | undefined> {
            return byCid.get(cid.toString());
        },
        async has(cid: CID): Promise<boolean> {
            return byCid.has(cid.toString());
        }
    };
}
