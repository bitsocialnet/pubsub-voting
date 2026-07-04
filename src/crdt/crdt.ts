import type { CID } from "multiformats/cid";
import type { BucketMath } from "../chain/types.js";
import type { VotesBundle } from "../schema/votes.js";
import type { DagNode, DagNodeStore, LwwResolve, VoteCrdt } from "./types.js";

/**
 * The Merkle-CRDT: a last-write-wins element-set keyed by the voting wallet, carried in a
 * Merkle-DAG. Aggregation is a monotonic union (a CRDT join) — combining two peers' sets can
 * only add nodes, never remove one — so a liar can omit a vote but cannot subtract one an
 * honest peer serves (see DESIGN.md "CRDT", "Can always-online peers drop votes?").
 *
 * Conflict resolution per wallet: highest `blockNumber` wins, tie broken by lowest node CID,
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

/** Highest `blockNumber` wins; tie broken by lowest node CID. */
export const lwwResolve: LwwResolve = (a, b) => {
    if (a.bundle.blockNumber !== b.bundle.blockNumber) {
        return a.bundle.blockNumber > b.bundle.blockNumber ? a.cid : b.cid;
    }
    return compareCid(a.cid, b.cid) <= 0 ? a.cid : b.cid;
};

export interface VoteCrdtDeps {
    store: DagNodeStore;
    /** Bucket math for `criteria.blocksPerBucket`, used by `prune` to age out expired bundles. */
    bucketMath: BucketMath;
    /** How many buckets a bundle stays valid after its blockNumber's bucket (`criteria.voteExpiryBuckets`). */
    voteExpiryBuckets: number;
    /** Conflict resolver; defaults to {@link lwwResolve}. */
    resolve?: LwwResolve;
}

export function makeVoteCrdt(deps: VoteCrdtDeps): VoteCrdt {
    const { store, bucketMath, voteExpiryBuckets } = deps;
    const resolve = deps.resolve ?? lwwResolve;

    // The working set of integrated nodes, mirrored from the store for fast reduction.
    const nodes = new Map<string, { cid: CID; node: DagNode }>();

    /**
     * A bundle has decayed once the current bucket is past its `blockNumber`'s bucket plus the
     * expiry window (see DESIGN.md "Passive expiry"). This is the read-time filter that keeps an
     * expired vote out of the tally and the broadcast heads *even when a merge re-materializes it
     * as a DAG ancestor* — the same predicate `prune` uses to bound memory. Identical to the check
     * in {@link prune}.
     */
    function isExpired(bundle: VotesBundle, currentBucket: number): boolean {
        return currentBucket > bucketMath.bucketForBlock(bundle.blockNumber) + voteExpiryBuckets;
    }

    /**
     * The current DAG tips: integrated nodes no other integrated node links as a parent.
     * Unfiltered — used for `add`'s parent links so the Merkle history stays walkable; the public
     * {@link VoteCrdt.heads} filters expired tips on top of this.
     */
    function computeHeads(): CID[] {
        const parents = new Set<string>();
        for (const { node } of nodes.values()) {
            for (const p of node.parents) parents.add(p.toString());
        }
        const heads: CID[] = [];
        for (const { cid } of nodes.values()) {
            if (!parents.has(cid.toString())) heads.push(cid);
        }
        return heads;
    }

    /** Depth-first integrate a CID and all its ancestors from the store into the working set. */
    async function integrate(cid: CID): Promise<void> {
        const key = cid.toString();
        if (nodes.has(key)) return;
        const node = await store.get(cid);
        if (!node) {
            throw new Error(`missing DAG node ${key} during merge; fetch it into the store before merging`);
        }
        nodes.set(key, { cid, node });
        for (const p of node.parents) await integrate(p);
    }

    /** LWW winner per wallet across the working set. */
    function winnersByWallet(): Map<string, { cid: CID; node: DagNode }> {
        const winners = new Map<string, { cid: CID; node: DagNode }>();
        for (const entry of nodes.values()) {
            const wallet = entry.node.value.address.toLowerCase();
            const prev = winners.get(wallet);
            if (!prev) {
                winners.set(wallet, entry);
                continue;
            }
            const winnerCid = resolve(
                { bundle: prev.node.value, cid: prev.cid },
                { bundle: entry.node.value, cid: entry.cid }
            );
            winners.set(wallet, winnerCid.equals(prev.cid) ? prev : entry);
        }
        return winners;
    }

    return {
        async add(bundle) {
            const node: DagNode = { value: bundle, parents: computeHeads() };
            const cid = await store.put(node);
            nodes.set(cid.toString(), { cid, node });
            return cid;
        },

        async merge(heads: CID[]) {
            for (const h of heads) await integrate(h);
        },

        heads(currentBucket) {
            // Drop expired tips so an expired standalone (or re-injected) tip is never
            // broadcast or linked; ancestors below a live tip stay walkable.
            return computeHeads().filter((cid) => {
                const entry = nodes.get(cid.toString())!;
                return !isExpired(entry.node.value, currentBucket);
            });
        },

        current(currentBucket) {
            // One bundle per wallet (LWW). A winning empty-votes bundle is the withdrawal
            // form and is returned as-is; the tally treats it as "no vote". A winner past its
            // expiry window drops the wallet entirely — the read-time filter that keeps a
            // decayed vote (even one a merge re-materialized) out of the tally.
            return [...winnersByWallet().values()]
                .filter((e) => !isExpired(e.node.value, currentBucket))
                .map((e) => e.node.value);
        },

        nodeCount() {
            return nodes.size;
        },

        async prune(currentBucket: number) {
            const winners = winnersByWallet();
            for (const [key, entry] of nodes) {
                const wallet = entry.node.value.address.toLowerCase();
                const isWinner = winners.get(wallet) === entry;
                const bundleBucket = bucketMath.bucketForBlock(entry.node.value.blockNumber);
                const expired = currentBucket > bundleBucket + voteExpiryBuckets;
                // Drop superseded (non-winning) nodes and any node past its expiry window.
                if (!isWinner || expired) nodes.delete(key);
            }
        }
    };
}
