import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import type { BundleVerifier, BundleVerdict } from "./types.js";

/**
 * Per-CID verdict cache. A bundle is immutable and content-addressed, and its verdict
 * (signature + constraints + gate-at-bucket-block + name resolution) is deterministic,
 * so it is computed once and reused. This is the lever that keeps the forward-gate cheap:
 * steady-state gossip re-announces already-known heads, so the same bundle CID would
 * otherwise be re-verified once per gossiping peer. See DESIGN.md "Transport" ("verdict cache").
 */
export interface VerdictCache {
    get(cid: CID): BundleVerdict | undefined;
    set(cid: CID, verdict: BundleVerdict): void;
    has(cid: CID): boolean;
}

/** An in-memory verdict cache keyed by the CID's canonical string. */
export function makeVerdictCache(): VerdictCache {
    const byCid = new Map<string, BundleVerdict>();
    return {
        get: (cid) => byCid.get(cid.toString()),
        set: (cid, verdict) => {
            byCid.set(cid.toString(), verdict);
        },
        has: (cid) => byCid.has(cid.toString())
    };
}

/** A verifier addressed by CID, memoizing verdicts through a {@link VerdictCache}. */
export interface CachingBundleVerifier {
    verify(cid: CID, bundle: VotesBundle): Promise<BundleVerdict>;
}

/**
 * Wrap a {@link BundleVerifier} with a {@link VerdictCache}: a CID already seen returns its
 * cached verdict without touching the chain or the network; a new CID runs the full pipeline
 * once and stores the result (valid or invalid — a known-bad bundle is not re-fetched or
 * re-checked either).
 */
export function makeCachingVerifier(verifier: BundleVerifier, cache: VerdictCache): CachingBundleVerifier {
    return {
        async verify(cid: CID, bundle: VotesBundle): Promise<BundleVerdict> {
            const cached = cache.get(cid);
            if (cached) return cached;
            const verdict = await verifier.verify(bundle);
            cache.set(cid, verdict);
            return verdict;
        }
    };
}
