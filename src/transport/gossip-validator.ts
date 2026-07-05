import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import type { VerdictCache } from "../verify/cache.js";
import type { BundleVerifier } from "../verify/types.js";

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
 *   - "ignore": no verdict reachable through no provable fault of the sender (unfetchable
 *     within the timeout, over the per-peer rate, too many CIDs, internal error) — drop,
 *     do not forward, do NOT penalize. Using `reject` here would punish honest relayers for
 *     transient conditions and hand attackers a grief vector.
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
    /** Fetch a bundle by CID (blockstore + bitswap); `undefined` if unfetchable. */
    fetchNode: (cid: CID) => Promise<VotesBundle | undefined>;
    /** The full validity pipeline for one bundle (see verify/bundle.ts). */
    verifier: BundleVerifier;
    /** Per-CID verdict cache — dedups re-announced bundles and known-bad CIDs. */
    cache: VerdictCache;
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

/** One bundle-verify outcome: "ok" (verified), or a terminal message verdict. */
type BundleResult = "ok" | "reject" | "ignore";

export function makeGossipGate(deps: GossipGateDeps): GossipGate {
    const { decodeWinnerCids, fetchNode, verifier, cache, merge, limit, allowPeer, onAccept, bounds, timeoutMs } = deps;

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

        const check = async (cid: CID): Promise<BundleResult> => {
            const key = cid.toString();
            if (seen.has(key)) return "ok";
            seen.add(key);

            const cached = cache.get(cid);
            if (cached) return cached.valid ? "ok" : "reject";

            const bundle = await limit(() => fetchNode(cid));
            if (!bundle) return "ignore"; // unfetchable/timeout — not provably the sender's fault

            const verdict = await verifier.verify(bundle);
            cache.set(cid, verdict);
            return verdict.valid ? "ok" : "reject";
        };

        let sawIgnore = false;
        for (const cid of cids) {
            const result = await check(cid);
            if (result === "reject") return "reject"; // reject takes precedence (penalize)
            if (result === "ignore") sawIgnore = true;
        }
        if (sawIgnore) return "ignore";

        await merge(cids);
        onAccept?.(cids, from);
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
