import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import type { BundleVerifier, BundleVerdict } from "./types.js";

/**
 * Per-CID verdict cache. A bundle is immutable and content-addressed, and its verdict
 * (signature + constraints + gate-at-bucket-block + name resolution) is deterministic,
 * so it is computed once and reused. This is the lever that keeps the forward-gate cheap:
 * steady-state gossip re-announces already-known bundle CIDs, so the same bundle CID would
 * otherwise be re-verified once per gossiping peer. See DESIGN.md "Transport" ("verdict cache").
 */
export interface VerdictCache {
    get(cid: CID): BundleVerdict | undefined;
    set(cid: CID, verdict: BundleVerdict): void;
    has(cid: CID): boolean;
}

/**
 * Only *terminal* verdicts may be cached: an `accept`, or a `reject` that is a pure function
 * of the bundle bytes + pinned historical chain state (bad signature, gate miss, ...). A
 * transient `ignore` (name resolved at head during a re-point window, a `blockNumber` bucket
 * ahead of this verifier's head) is view-/clock-dependent and can change as heads/records
 * converge, so caching it would wrongly pin a stale verdict. See DESIGN.md "Transport"
 * ("verdict cache") and verify/types.ts `VerdictDisposition`.
 */
export function isCacheableVerdict(verdict: BundleVerdict): boolean {
    return verdict.valid || verdict.disposition === "reject";
}

/**
 * An in-memory verdict cache keyed by the CID's canonical string, bounded to `maxEntries` with
 * FIFO eviction (same pattern as `makeGateResultCache` / `makeAcceptedDedup`). Without a bound the
 * `Map` grows one entry per novel CID forever: an ineligible wallet (or a flood of fresh wallets)
 * minting fresh-signed bundles yields a distinct provable-`reject` per CID, so an unbounded cache is
 * a memory-exhaustion vector (see DESIGN.md "Can valid votes clog the topic?"). Eviction is safe
 * because a cached verdict is *terminal* and deterministic — an evicted entry only costs a re-fetch
 * + re-verify on the next re-announce, never a wrong answer, and the `(wallet, sampleBlock)`
 * gate-result cache still short-circuits the chain read so that recomputation stays cheap.
 */
export function makeVerdictCache(maxEntries = 4096): VerdictCache {
    const byCid = new Map<string, BundleVerdict>();
    const order: string[] = [];
    return {
        get: (cid) => byCid.get(cid.toString()),
        set: (cid, verdict) => {
            const k = cid.toString();
            if (byCid.has(k)) return; // idempotent: a terminal verdict never changes, so keep FIFO position
            byCid.set(k, verdict);
            order.push(k);
            if (order.length > maxEntries) {
                const evicted = order.shift();
                if (evicted !== undefined) byCid.delete(evicted);
            }
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
 * once and stores the result — but only if it is terminal ({@link isCacheableVerdict}): a
 * valid bundle or a provable `reject` is remembered (a known-bad bundle is not re-fetched or
 * re-checked), while a transient `ignore` is re-evaluated next time so a stale head/record
 * cannot pin it.
 */
export function makeCachingVerifier(verifier: BundleVerifier, cache: VerdictCache): CachingBundleVerifier {
    return {
        async verify(cid: CID, bundle: VotesBundle): Promise<BundleVerdict> {
            const cached = cache.get(cid);
            if (cached) return cached;
            const verdict = await verifier.verify(bundle);
            if (isCacheableVerdict(verdict)) cache.set(cid, verdict);
            return verdict;
        }
    };
}
