import type { CID } from "multiformats/cid";
import type { BucketMath } from "../chain/types.js";
import type { VotesBundle } from "../schema/votes.js";
import type { BundleStore, LwwResolve, VoteCrdt } from "./types.js";

/**
 * The state-based grow-only CRDT: a last-write-wins element-set keyed by the voting wallet.
 * Each bundle is a standalone dag-cbor block; there are no parent links and no DAG to walk.
 * Aggregation is a monotonic union (a CRDT join) — combining two peers' sets can only add
 * bundles, never remove one — so a liar can omit a vote but cannot subtract one an honest
 * peer serves (see DESIGN.md "CRDT", "Can always-online peers drop votes?").
 *
 * Conflict resolution per wallet: highest `blockNumber` wins, tie broken by lowest bundle CID,
 * for determinism across clients. Bundles admitted here are assumed already validity-gated
 * (signature, gate, name) by the transport before merge — the CRDT is trust-neutral
 * storage, not a verifier.
 */

/** Byte-lexicographic compare of two CIDs (returns <0, 0, >0). */
function compareCid(a: CID, b: CID): number {
    const x = a.bytes;
    const y = b.bytes;
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
        const xi = x[i]!;
        const yi = y[i]!;
        if (xi !== yi) return xi - yi;
    }
    return x.length - y.length;
}

/** Highest `blockNumber` wins; tie broken by lowest bundle CID. */
export const lwwResolve: LwwResolve = (a, b) => {
    if (a.bundle.blockNumber !== b.bundle.blockNumber) {
        return a.bundle.blockNumber > b.bundle.blockNumber ? a.cid : b.cid;
    }
    return compareCid(a.cid, b.cid) <= 0 ? a.cid : b.cid;
};

export interface VoteCrdtDeps {
    store: BundleStore;
    /** Bucket math for `criteria.blocksPerBucket`, used by `prune` to age out expired bundles. */
    bucketMath: BucketMath;
    /** How many buckets a bundle stays valid after its blockNumber's bucket (`criteria.voteExpiryBuckets`). */
    voteExpiryBuckets: number;
    /** Conflict resolver; defaults to {@link lwwResolve}. */
    resolve?: LwwResolve;
    /**
     * True while a bundle's deferred chain/name checks are still pending (see
     * verify/background.ts). `prune` keeps a superseded bundle whose superseder is provisional —
     * the fallback winner if the provisional bundle is later evicted. Omitted ⇒ nothing is
     * provisional (prior behaviour).
     */
    isProvisional?: (cid: CID) => boolean;
}

export function makeVoteCrdt(deps: VoteCrdtDeps): VoteCrdt {
    const { store, bucketMath, voteExpiryBuckets } = deps;
    const resolve = deps.resolve ?? lwwResolve;
    const isProvisional = deps.isProvisional ?? (() => false);

    // The working set of integrated bundles, keyed by CID string, mirrored from the store for
    // fast reduction.
    const bundles = new Map<string, { cid: CID; bundle: VotesBundle }>();

    /**
     * A bundle has decayed once the current bucket is past its `blockNumber`'s bucket plus the
     * expiry window (see DESIGN.md "Passive expiry"). This is the read-time filter that keeps an
     * expired vote out of the tally and the checkpoint — the same predicate `prune` uses to
     * bound memory.
     */
    function isExpired(bundle: VotesBundle, currentBucket: number): boolean {
        return currentBucket > bucketMath.bucketForBlock(bundle.blockNumber) + voteExpiryBuckets;
    }

    /** Integrate one bundle CID from the store into the working set (idempotent). */
    async function integrate(cid: CID): Promise<void> {
        const key = cid.toString();
        if (bundles.has(key)) return;
        const bundle = await store.get(cid);
        if (!bundle) {
            throw new Error(`missing bundle ${key} during merge; fetch it into the store before merging`);
        }
        bundles.set(key, { cid, bundle });
    }

    /** LWW winner per wallet across the working set; `eligible` restricts the reduction. */
    function winnersByWallet(eligible?: (cid: CID) => boolean): Map<string, { cid: CID; bundle: VotesBundle }> {
        const winners = new Map<string, { cid: CID; bundle: VotesBundle }>();
        for (const entry of bundles.values()) {
            if (eligible && !eligible(entry.cid)) continue;
            const wallet = entry.bundle.address.toLowerCase();
            const prev = winners.get(wallet);
            if (!prev) {
                winners.set(wallet, entry);
                continue;
            }
            const winnerCid = resolve(
                { bundle: prev.bundle, cid: prev.cid },
                { bundle: entry.bundle, cid: entry.cid }
            );
            winners.set(wallet, winnerCid.equals(prev.cid) ? prev : entry);
        }
        return winners;
    }

    /**
     * One winner per wallet (LWW, optionally restricted to `eligible` bundles), minus expired
     * winners. A winning empty-votes bundle is the withdrawal form and is returned as-is; the
     * tally treats it as "no vote". A winner past its expiry window drops the wallet entirely —
     * the read-time filter that keeps a decayed vote out of the tally and the checkpoint.
     */
    function currentEntries(currentBucket: number, eligible?: (cid: CID) => boolean): Array<{ cid: CID; bundle: VotesBundle }> {
        return [...winnersByWallet(eligible).values()].filter((e) => !isExpired(e.bundle, currentBucket));
    }

    return {
        async add(bundle) {
            const cid = await store.put(bundle);
            bundles.set(cid.toString(), { cid, bundle });
            return cid;
        },

        async merge(cids: CID[]) {
            for (const cid of cids) await integrate(cid);
        },

        current(currentBucket) {
            return currentEntries(currentBucket).map((e) => e.bundle);
        },

        currentEntries,

        remove(cid: CID) {
            bundles.delete(cid.toString());
        },

        nodeCount() {
            return bundles.size;
        },

        async prune(currentBucket: number) {
            const winners = winnersByWallet();
            const removed: CID[] = [];
            for (const [key, entry] of bundles) {
                const wallet = entry.bundle.address.toLowerCase();
                const winner = winners.get(wallet);
                const isWinner = winner === entry;
                const bundleBucket = bucketMath.bucketForBlock(entry.bundle.blockNumber);
                const expired = currentBucket > bundleBucket + voteExpiryBuckets;
                // Drop superseded (non-winning) bundles and any bundle past its expiry window —
                // EXCEPT a superseded bundle whose superseder is still provisional: it is the
                // fallback winner if that bundle's deferred check evicts it.
                const shieldedByProvisionalWinner = !isWinner && !expired && winner !== undefined && isProvisional(winner.cid);
                if ((!isWinner || expired) && !shieldedByProvisionalWinner) {
                    bundles.delete(key);
                    removed.push(entry.cid);
                }
            }
            return removed;
        }
    };
}
