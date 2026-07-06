import type { BucketMath } from "../chain/types.js";
import type { VotesBundle } from "../schema/votes.js";
import { encodeCanonical } from "../encoding/canonical.js";

/**
 * A bounded set of already-accepted votes, keyed by `(wallet, bucket, votes)`, used by the forward
 * gate to drop a **re-sign flood**: an eligible wallet re-signing the same choice with fresh
 * signature nonces (or a bumped `blockNumber` inside the same bucket) mints a new bundle CID each
 * time, so the per-CID verdict cache never hits. Each such bundle is inert under LWW (same wallet)
 * and shares the same expiry bucket and the same tally choice as the one already accepted, so
 * re-forwarding it is pure amplification (see DESIGN.md "Transport", resource-exhaustion residual).
 *
 * Keyed on the *bucket* (not the raw `blockNumber`) and the canonical `votes` bytes, so a genuine
 * heartbeat re-sign — which lands in a *later* bucket on the liveness cadence — is NOT a duplicate,
 * and a genuine vote *change* (different `votes`) is NOT a duplicate. Only a same-bucket, same-choice
 * re-sign matches.
 *
 * Safety: `isResignDuplicate` may be consulted on the *untrusted* claimed `bundle.address` (before
 * the signature is verified), because a hit only ever yields "drop, do not forward" — never accept
 * or store. A hit means an equivalent vote was already verified and forwarded, so dropping an
 * attacker's matching-key garbage suppresses nothing an honest peer lacks; a non-hit falls through
 * to the full verifier, where a bad signature is `reject`ed. `record` is therefore only ever called
 * for a bundle that has passed the full gate.
 */
export interface AcceptedDedup {
    /** Is `bundle` a same-bucket, same-choice re-sign of a vote already accepted from its wallet? */
    isResignDuplicate(bundle: VotesBundle): boolean;
    /** Record a fully-verified, accepted bundle so later re-signs of it are recognised as duplicates. */
    record(bundle: VotesBundle): void;
}

function toHex(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

/** An in-memory {@link AcceptedDedup} bounded to `maxEntries` with FIFO eviction. */
export function makeAcceptedDedup(bucketMath: BucketMath, maxEntries = 4096): AcceptedDedup {
    const keys = new Set<string>();
    const order: string[] = [];
    const keyFor = (bundle: VotesBundle): string => {
        const bucket = bucketMath.bucketForBlock(bundle.blockNumber);
        // `votes` is canonically dag-cbor encoded (sorted keys), so the same choice always yields
        // the same key regardless of authoring order. Votes are tiny in v1, so raw hex is a cheap,
        // sync key — no hashing needed.
        return `${bundle.address.toLowerCase()}:${bucket}:${toHex(encodeCanonical(bundle.votes))}`;
    };
    return {
        isResignDuplicate: (bundle) => keys.has(keyFor(bundle)),
        record: (bundle) => {
            const k = keyFor(bundle);
            if (keys.has(k)) return;
            keys.add(k);
            order.push(k);
            if (order.length > maxEntries) {
                const evicted = order.shift();
                if (evicted !== undefined) keys.delete(evicted);
            }
        }
    };
}
