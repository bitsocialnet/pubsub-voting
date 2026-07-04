import type { CID } from "multiformats/cid";
import type { DagNode } from "../crdt/types.js";
import type { VerdictCache } from "../verify/cache.js";
import type { BundleVerifier } from "../verify/types.js";

/**
 * The forward-gate: the async gossipsub topic validator's decision core, written as a pure
 * function over injected seams (no libp2p import) so it is fully unit-testable. It runs the
 * FULL validity pipeline for a received head announcement BEFORE the message is re-forwarded,
 * so an invalid bundle never crosses an honest hop and gossipsub's `reject` scores the
 * sender for semantic — not just byte-level — badness. See DESIGN.md "Transport".
 *
 * Verdicts (who gets blamed):
 *   - "accept": the whole new closure verified — deliver, merge, forward.
 *   - "reject": something is PROVABLY invalid (malformed message, a bundle that fails
 *     verification, a known-bad referenced CID) — drop, do not forward, penalize the sender.
 *   - "ignore": no verdict reachable through no provable fault of the sender (unfetchable
 *     within the timeout, over the per-peer rate, closure too large, internal error) — drop,
 *     do not forward, do NOT penalize. Using `reject` here would punish honest relayers for
 *     transient conditions and hand attackers a grief vector.
 *
 * Cheap-to-expensive with early exit: size/rate/decode first, then per-node fetch + verify,
 * de-duplicated through the verdict cache so a re-announced known head costs zero network.
 */

export type MessageVerdict = "accept" | "reject" | "ignore";

export interface GossipGateBounds {
    /** Max head CIDs per message (layer-1 cap). */
    maxHeadsPerMessage: number;
    /** Max message payload bytes (layer-1 cap). */
    maxMessageBytes: number;
    /** Max new nodes fetched+verified per message (bounds the closure walk). */
    maxClosureNodes: number;
}

export interface GossipGateDeps {
    /** Decode a payload to head CIDs; throws on malformed (see transport/heads.ts). */
    decodeHeads: (data: Uint8Array) => CID[];
    /** Fetch a bundle DagNode by CID (blockstore + bitswap); `undefined` if unfetchable. */
    fetchNode: (cid: CID) => Promise<DagNode | undefined>;
    /** The full validity pipeline for one bundle (see verify/bundle.ts). */
    verifier: BundleVerifier;
    /** Per-CID verdict cache — dedups re-announced heads and known-bad CIDs. */
    cache: VerdictCache;
    /** Admit a validated head set into the CRDT (idempotent; reads fetched nodes from the store). */
    merge: (heads: CID[]) => Promise<void>;
    /** Concurrency limiter (p-limit) shared across in-flight validations. */
    limit: <T>(fn: () => Promise<T>) => Promise<T>;
    /** Per-peer rate gate; `false` means the peer is over its rate this window. */
    allowPeer: (peer: string) => boolean;
    /** Called after a message is accepted and merged (drives tally-update notifications). */
    onAccept?: (heads: CID[], from: string) => void;
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

/** One node-walk outcome: "ok" (verified), or a terminal message verdict. */
type WalkResult = "ok" | "reject" | "ignore";

export function makeGossipGate(deps: GossipGateDeps): GossipGate {
    const { decodeHeads, fetchNode, verifier, cache, merge, limit, allowPeer, onAccept, bounds, timeoutMs } = deps;

    async function doValidate(data: Uint8Array, from: string): Promise<MessageVerdict> {
        // Layer 1: size, rate, decode — all pre-fetch.
        if (data.length > bounds.maxMessageBytes) return "reject";
        if (!allowPeer(from)) return "ignore";

        let heads: CID[];
        try {
            heads = decodeHeads(data);
        } catch {
            return "reject"; // malformed bytes / not a bounded CID list — provable layer-1 badness
        }
        if (heads.length === 0) return "ignore"; // useless announcement
        if (heads.length > bounds.maxHeadsPerMessage) return "reject";

        // Walk the new closure, verifying each unknown node, bounded and de-duplicated.
        const visited = new Set<string>();

        const walk = async (cid: CID): Promise<WalkResult> => {
            const key = cid.toString();
            if (visited.has(key)) return "ok";

            const cached = cache.get(cid);
            if (cached) return cached.valid ? "ok" : "reject";
            if (visited.size >= bounds.maxClosureNodes) return "ignore";

            const node = await limit(() => fetchNode(cid));
            if (!node) return "ignore"; // unfetchable/timeout — not provably the sender's fault

            const verdict = await verifier.verify(node.value);
            cache.set(cid, verdict);
            if (!verdict.valid) return "reject";

            visited.add(key);
            for (const parent of node.parents) {
                const result = await walk(parent);
                if (result !== "ok") return result;
            }
            return "ok";
        };

        let sawIgnore = false;
        for (const head of heads) {
            const result = await walk(head);
            if (result === "reject") return "reject"; // reject takes precedence (penalize)
            if (result === "ignore") sawIgnore = true;
        }
        if (sawIgnore) return "ignore";

        await merge(heads);
        onAccept?.(heads, from);
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
