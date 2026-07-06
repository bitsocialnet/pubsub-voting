import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import { isCacheableVerdict, type VerdictCache } from "../verify/cache.js";
import type { BundleVerifier } from "../verify/types.js";
import type { AcceptedDedup } from "./accepted-dedup.js";

/**
 * The forward-gate: the async gossipsub topic validator's decision core, written as a pure
 * function over injected seams (no libp2p import) so it is fully unit-testable. It runs the
 * FULL validity pipeline for a received bundle-CID announcement BEFORE the message is
 * re-forwarded, so an invalid bundle never crosses an honest hop and gossipsub's `reject`
 * scores the sender for semantic — not just byte-level — badness. See DESIGN.md "Transport".
 *
 * Each gossiped CID is a standalone bundle (no parent links, no ancestor walk): the gate
 * fetches it by CID, verifies it, and LWW-merges it on its own.
 *
 * Verdicts (who gets blamed):
 *   - "accept": every referenced bundle verified — deliver, merge, forward.
 *   - "reject": something is PROVABLY invalid (malformed message, a bundle that fails
 *     verification, a known-bad referenced CID) — drop, do not forward, penalize the sender.
 *   - "ignore": no verdict reachable through no provable fault of the sender — either a
 *     transient/local condition (unfetchable within the timeout, over the per-peer rate,
 *     internal error) or a view-/clock-dependent verdict two honest peers can disagree on
 *     right now: a bundle bucketed ahead of our chain head (`isEvaluableNow`), or a
 *     `community.name` resolved at head during a re-point window. Drop, do not forward, do NOT
 *     penalize, and do NOT cache (it can change) — using `reject` here would punish honest
 *     relayers for transient conditions and hand attackers a grief vector.
 *
 * Cheap-to-expensive with early exit: size/rate/decode first, then per-bundle fetch + verify,
 * de-duplicated through the verdict cache so a re-announced known bundle costs zero network.
 */

export type MessageVerdict = "accept" | "reject" | "ignore";

export interface GossipGateBounds {
    /** Max bundle CIDs per message (layer-1 cap). */
    maxWinnerCidsPerMessage: number;
    /** Max message payload bytes (layer-1 cap). */
    maxMessageBytes: number;
}

export interface GossipGateDeps {
    /** Decode a payload to bundle CIDs; throws on malformed (see transport/winner-cids.ts). */
    decodeWinnerCids: (data: Uint8Array) => CID[];
    /**
     * Fetch a bundle by CID (blockstore + bitswap); `undefined` if unfetchable. `signal` aborts
     * an in-flight fetch when the gate's per-fetch timeout fires (see `fetchTimeoutMs`).
     */
    fetchNode: (cid: CID, signal?: AbortSignal) => Promise<VotesBundle | undefined>;
    /** The full validity pipeline for one bundle (see verify/bundle.ts). */
    verifier: BundleVerifier;
    /**
     * Clock-aware freshness guard, kept OUT of the pure (cacheable) verifier: is this bundle's
     * bucket sample block already reachable from our chain head? A bundle dated to a future
     * bucket (the voter's head ahead of ours, clock skew, or an absurd `blockNumber`) is not
     * yet evaluable — transient, so the gate `ignore`s it (no penalty, uncached) until our head
     * catches up. Omitted ⇒ no freshness check (prior behaviour). Steady-state votes resolve
     * `true` with no chain read; only a look-ahead bundle costs a (memoized) head read.
     */
    isEvaluableNow?: (bundle: VotesBundle) => Promise<boolean>;
    /** Per-CID verdict cache — dedups re-announced bundles and known-bad CIDs. */
    cache: VerdictCache;
    /**
     * Optional dedup of already-accepted votes by `(wallet, bucket, votes)`. A same-bucket,
     * same-choice re-sign under a fresh CID is dropped as "redundant" — not verified, not merged,
     * and never the reason a message is forwarded — so a re-sign flood costs no gate read and is
     * not re-broadcast. Omitted ⇒ every fresh CID is verified on its own (prior behaviour).
     */
    acceptedDedup?: AcceptedDedup;
    /** Admit a validated bundle-CID set into the CRDT (idempotent; reads fetched bundles from the store). */
    merge: (cids: CID[]) => Promise<void>;
    /** Concurrency limiter (p-limit) shared across in-flight validations. */
    limit: <T>(fn: () => Promise<T>) => Promise<T>;
    /** Per-peer rate gate; `false` means the peer is over its rate this window. */
    allowPeer: (peer: string) => boolean;
    /** Called after a message is accepted and merged (drives tally-update notifications). */
    onAccept?: (cids: CID[], from: string) => void;
    bounds: GossipGateBounds;
    /** Hard per-message validation deadline; on expiry the verdict is `ignore`. */
    timeoutMs: number;
    /**
     * Per-fetch deadline (ms), shorter than `timeoutMs`. A single unfetchable CID cannot hold its
     * `limit` (p-limit) slot for the whole message budget: at this deadline the fetch is aborted (its
     * bitswap want cancelled) and the slot released, so a flood of unfetchable CIDs cannot starve the
     * shared fetch pool. See DESIGN.md "Transport", resource-exhaustion residual.
     */
    fetchTimeoutMs: number;
}

export interface GossipGate {
    /** Validate one received message; the returned verdict maps to gossipsub accept/reject/ignore. */
    validate(data: Uint8Array, from: string): Promise<MessageVerdict>;
}

/** Resolve `p`, or `onTimeout` if it does not settle within `ms`; a rejection also yields `onTimeout`. */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
    return new Promise<T>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(onTimeout);
            }
        }, ms);
        p.then(
            (v) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(v);
                }
            },
            () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(onTimeout);
                }
            }
        );
    });
}

/**
 * One referenced-CID outcome:
 *   - "ok":        a fresh-verified valid bundle, or a re-announced known winner — forward + merge.
 *   - "redundant": a same-bucket, same-choice re-sign of an already-accepted vote — inert, dropped
 *                  without verifying or merging; never the reason a message is forwarded.
 *   - "reject" / "ignore": terminal message verdicts (see `MessageVerdict`).
 */
type BundleResult = "ok" | "redundant" | "reject" | "ignore";

export function makeGossipGate(deps: GossipGateDeps): GossipGate {
    const { decodeWinnerCids, fetchNode, verifier, isEvaluableNow, cache, acceptedDedup, merge, limit, allowPeer, onAccept, bounds, timeoutMs, fetchTimeoutMs } =
        deps;

    /**
     * Fetch one bundle under a per-fetch deadline. On timeout the `AbortSignal` cancels the bitswap
     * want AND `withDeadline` resolves `undefined` regardless of whether the underlying fetch honours
     * the abort — so the `limit` slot is always freed at `fetchTimeoutMs`, never leaked to a hung fetch.
     */
    async function fetchWithTimeout(cid: CID): Promise<VotesBundle | undefined> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
        try {
            return await withDeadline(fetchNode(cid, controller.signal), fetchTimeoutMs, undefined);
        } finally {
            clearTimeout(timer);
        }
    }

    async function doValidate(data: Uint8Array, from: string): Promise<MessageVerdict> {
        // Layer 1: size, rate, decode — all pre-fetch.
        if (data.length > bounds.maxMessageBytes) return "reject";
        if (!allowPeer(from)) return "ignore";

        let cids: CID[];
        try {
            cids = decodeWinnerCids(data);
        } catch {
            return "reject"; // malformed bytes / not a bounded CID list — provable layer-1 badness
        }
        if (cids.length === 0) return "ignore"; // useless announcement
        if (cids.length > bounds.maxWinnerCidsPerMessage) return "reject";

        // Verify each referenced bundle independently, de-duplicated through the verdict cache.
        const seen = new Set<string>();

        const check = async (cid: CID): Promise<{ result: BundleResult; bundle?: VotesBundle }> => {
            const key = cid.toString();
            if (seen.has(key)) return { result: "ok" }; // already handled earlier in this message
            seen.add(key);

            const cached = cache.get(cid);
            if (cached) return { result: cached.valid ? "ok" : cached.disposition };

            const bundle = await limit(() => fetchWithTimeout(cid));
            if (!bundle) return { result: "ignore" }; // unfetchable/timeout — not provably the sender's fault

            // Freshness guard (transient, so it runs here — not in the cacheable verifier — and
            // its verdict is never cached): a bundle bucketed ahead of our head is not yet
            // evaluable, so `ignore` it without penalty until our head advances. Also defuses an
            // absurd-future `blockNumber` (e.g. uint256.max) — it never merges into the set.
            if (isEvaluableNow && !(await isEvaluableNow(bundle))) return { result: "ignore" };

            // Re-sign flood guard: a same-bucket, same-choice re-sign of a vote we already accepted
            // is inert under LWW, so drop it WITHOUT verifying (no gate read) or merging (it is
            // unverified — merging would bypass the gate). Safe on the untrusted `address` because a
            // hit only ever suppresses forwarding of something an honest peer already has.
            if (acceptedDedup?.isResignDuplicate(bundle)) return { result: "redundant" };

            const verdict = await verifier.verify(bundle);
            if (isCacheableVerdict(verdict)) cache.set(cid, verdict); // only terminal verdicts (accept / provable reject)
            return { result: verdict.valid ? "ok" : verdict.disposition, bundle };
        };

        let sawIgnore = false;
        let sawForward = false; // at least one CID worth forwarding (fresh-valid or known winner)
        const toMerge: CID[] = [];
        const toRecord: VotesBundle[] = [];
        for (const cid of cids) {
            const { result, bundle } = await check(cid);
            if (result === "reject") return "reject"; // reject takes precedence (penalize)
            if (result === "ignore") {
                sawIgnore = true;
                continue;
            }
            if (result === "redundant") continue; // inert; never merged, never a reason to forward
            sawForward = true;
            toMerge.push(cid);
            if (bundle) toRecord.push(bundle); // only fresh-verified valid bundles carry a bundle
        }
        if (sawIgnore) return "ignore";
        // A message whose only fresh content was re-sign duplicates carries nothing new, so it is
        // not re-flooded (drop, no penalty) — the anti-amplification win.
        if (!sawForward) return "ignore";

        await merge(toMerge);
        for (const b of toRecord) acceptedDedup?.record(b);
        onAccept?.(toMerge, from);
        return "accept";
    }

    return {
        validate(data: Uint8Array, from: string): Promise<MessageVerdict> {
            // Whole-message deadline: an internal hang or slow fetch yields `ignore`, never a
            // stuck validator (which would strand the message in gossipsub's mcache).
            return withDeadline(doValidate(data, from), timeoutMs, "ignore");
        }
    };
}
