import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import { isCacheableVerdict, type VerdictCache } from "../verify/cache.js";
import type { BundleVerifier } from "../verify/types.js";
import type { AcceptedDedup } from "./accepted-dedup.js";
import type { RootRecord, VoteMessage } from "./messages.js";

/**
 * The forward-gate: the async gossipsub topic validator's decision core, written as a pure
 * function over injected seams (no libp2p import) so it is fully unit-testable. It runs the
 * FULL validity pipeline on the bundle INLINED in a received message BEFORE the message is
 * re-forwarded, so an invalid bundle never crosses an honest hop and gossipsub's `reject`
 * scores the sender for semantic — not just byte-level — badness. See DESIGN.md "Transport".
 *
 * The payload is a two-kind discriminated union (see transport/messages.ts):
 *   - a **bundle delta** — the wallet's own bundle as exact block bytes, validated straight
 *     from the message (no fetch toward the publisher exists on this path);
 *   - a **root record** — the checkpoint heartbeat, a fixed-shape unverifiable *hint* that
 *     short-circuits at layer 1: forwarded within its own per-peer rate and handed to the
 *     chase logic, never verified here (only equality with our own root is checkable) and
 *     never trusted.
 *
 * Verdicts (who gets blamed):
 *   - "accept": the inlined bundle verified (or is a known-valid re-publish), or a
 *     well-formed within-rate root record — deliver, merge (bundles), forward.
 *   - "reject": something is PROVABLY invalid (malformed message, over the derived size cap,
 *     a bundle that fails verification) — drop, do not forward, penalize the sender.
 *   - "ignore": no verdict reachable through no provable fault of the sender — either a
 *     transient/local condition (over the per-peer rate, internal error, deadline) or a
 *     view-/clock-dependent verdict two honest peers can disagree on right now: a bundle
 *     bucketed ahead of our chain head (`isEvaluableNow`), or a `community.name` resolved at
 *     head during a re-point window. Drop, do not forward, do NOT penalize, and do NOT cache
 *     (it can change) — using `reject` here would punish honest relayers for transient
 *     conditions and hand attackers a grief vector.
 *
 * Cheap-to-expensive with early exit: size/decode/rate first, then hash + caches, then the
 * verify pipeline — so a re-published known bundle costs one hash and zero chain work.
 */

export type MessageVerdict = "accept" | "reject" | "ignore";

export interface GossipGateDeps {
    /** Decode a payload to its message kind; throws on malformed (see transport/messages.ts). */
    decodeMessage: (data: Uint8Array) => VoteMessage;
    /**
     * Decode inlined bundle-block bytes and hash them to the bundle CID (the verdict-cache
     * key). Throws on malformed block bytes — provable layer-1 badness.
     */
    parseBundle: (blockBytes: Uint8Array) => Promise<{ cid: CID; bundle: VotesBundle }>;
    /** The full validity pipeline for one bundle (see verify/bundle.ts). */
    verifier: BundleVerifier;
    /**
     * Clock-aware freshness guard, kept OUT of the pure (cacheable) verifier: is this bundle's
     * bucket sample block already reachable from our chain head? A bundle dated to a future
     * bucket (the voter's head ahead of ours, clock skew, or an absurd `blockNumber`) is not
     * yet evaluable — transient, so the gate `ignore`s it (no penalty, uncached) until our head
     * catches up. Omitted ⇒ no freshness check. Steady-state votes resolve `true` with no chain
     * read; only a look-ahead bundle costs a (memoized) head read.
     */
    isEvaluableNow?: (bundle: VotesBundle) => Promise<boolean>;
    /** Per-CID verdict cache — dedups re-published bundles and known-bad blocks. */
    cache: VerdictCache;
    /**
     * Optional dedup of already-accepted votes by `(wallet, bucket, votes)`. A same-bucket,
     * same-choice re-sign under fresh bytes is dropped — not verified, not merged, not
     * forwarded — so a re-sign flood costs no gate read and does not amplify. Omitted ⇒ every
     * fresh bundle is verified on its own.
     */
    acceptedDedup?: AcceptedDedup;
    /**
     * Store the verified bundle's exact block bytes and admit its CID into the CRDT
     * (idempotent). Exact bytes preserve byte-identity with the sender's block.
     */
    admit: (args: { cid: CID; bytes: Uint8Array; bundle: VotesBundle }) => Promise<void>;
    /**
     * Concurrency limiter (p-limit) shared across in-flight verifications — the gate chain
     * read and name resolution are network calls, so concurrent RPC work stays bounded.
     */
    limit: <T>(fn: () => Promise<T>) => Promise<T>;
    /** Per-peer rate gate for bundle-kind messages; `false` means over-rate this window. */
    allowBundlePeer: (peer: string) => boolean;
    /** Per-peer rate gate for root-kind messages (heartbeats are ~1 per 10 min when honest). */
    allowRootPeer: (peer: string) => boolean;
    /** Called after a fresh bundle is verified and merged (drives tally-update notifications). */
    onAccept?: (cid: CID, bundle: VotesBundle, from: string) => void;
    /**
     * Called with every well-formed, within-rate root record (an unverifiable hint). NOT
     * awaited — acting on a hint (the directed-bitswap chase) is lazy and bounded elsewhere,
     * never on the validator's critical path.
     */
    onRootRecord?: (record: RootRecord, from: string) => void;
    /** The criteria-derived cap for a bundle-kind message (see messages.ts). Over ⇒ reject. */
    maxBundleMessageBytes: number;
    /** The fixed cap for a root-kind message (~100 B record). Over ⇒ reject. */
    maxRootMessageBytes: number;
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

export function makeGossipGate(deps: GossipGateDeps): GossipGate {
    const {
        decodeMessage,
        parseBundle,
        verifier,
        isEvaluableNow,
        cache,
        acceptedDedup,
        admit,
        limit,
        allowBundlePeer,
        allowRootPeer,
        onAccept,
        onRootRecord,
        maxBundleMessageBytes,
        maxRootMessageBytes,
        timeoutMs
    } = deps;

    async function doValidate(data: Uint8Array, from: string): Promise<MessageVerdict> {
        // Layer 1: size and decode — the cheapest, pre-verify checks.
        if (data.length > Math.max(maxBundleMessageBytes, maxRootMessageBytes)) return "reject";

        let message: VoteMessage;
        try {
            message = decodeMessage(data);
        } catch {
            return "reject"; // malformed bytes / not one of the two kinds — provable layer-1 badness
        }

        if (message.kind === "root") {
            if (data.length > maxRootMessageBytes) return "reject";
            if (!allowRootPeer(from)) return "ignore";
            // An unverifiable hint: forward within rate, hand to the (lazy, bounded) chase.
            // Never `reject`ed on content — only equality with our own root is checkable.
            onRootRecord?.(message.record, from);
            return "accept";
        }

        if (data.length > maxBundleMessageBytes) return "reject";
        if (!allowBundlePeer(from)) return "ignore";

        let cid: CID;
        let bundle: VotesBundle;
        try {
            ({ cid, bundle } = await parseBundle(message.bundle));
        } catch {
            return "reject"; // malformed bundle block bytes — provable
        }

        // A known bundle short-circuits on the verdict cache for the cost of one hash: a
        // re-published valid bundle (e.g. a client refreshing its vote or re-announcing a
        // withdrawal) is forwarded so late peers converge, without re-verifying or re-merging;
        // a known-bad one rejects without work.
        const cached = cache.get(cid);
        if (cached) return cached.valid ? "accept" : cached.disposition;

        // Freshness guard (transient, so it runs here — not in the cacheable verifier — and
        // its verdict is never cached): a bundle bucketed ahead of our head is not yet
        // evaluable, so `ignore` it without penalty until our head advances. Also defuses an
        // absurd-future `blockNumber` (e.g. uint256.max) — it never merges into the set.
        if (isEvaluableNow && !(await isEvaluableNow(bundle))) return "ignore";

        // Re-sign flood guard: a same-bucket, same-choice re-sign of a vote we already accepted
        // is inert under LWW, so drop it WITHOUT verifying (no gate read), merging, or
        // forwarding — the anti-amplification win. Safe on the untrusted `address` because a
        // hit only ever suppresses something an honest peer already forwarded.
        if (acceptedDedup?.isResignDuplicate(bundle)) return "ignore";

        const verdict = await limit(() => verifier.verify(bundle));
        if (isCacheableVerdict(verdict)) cache.set(cid, verdict); // only terminal verdicts (accept / provable reject)
        if (!verdict.valid) return verdict.disposition;

        await admit({ cid, bytes: message.bundle, bundle });
        acceptedDedup?.record(bundle);
        onAccept?.(cid, bundle, from);
        return "accept";
    }

    return {
        validate(data: Uint8Array, from: string): Promise<MessageVerdict> {
            // Whole-message deadline: an internal hang or slow RPC/name resolution yields
            // `ignore`, never a stuck validator (which would strand the message in gossipsub's
            // mcache).
            return withDeadline(doValidate(data, from), timeoutMs, "ignore");
        }
    };
}
