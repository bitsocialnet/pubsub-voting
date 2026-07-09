import { describe, it, expect } from "vitest";
import { makeVoteCrdt, lwwResolve } from "./crdt.js";
import { makeMemoryBundleStore } from "./store.js";
import { makeBucketMath } from "../chain/bucket.js";
import type { Vote, VotesBundle } from "../schema/votes.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

// The CRDT is trust-neutral storage; it never checks signatures, so a well-formed placeholder
// (the binary codec requires exactly 65 bytes) is fine.
function bundle(address: string, votes: Vote[], blockNumber: number): VotesBundle {
    return { address, votes, blockNumber, signature: { signature: `0x${"11".repeat(65)}`, type: "eip712" } };
}

const BLOCKS_PER_BUCKET = 43200;
// Any bucket where nothing added below has expired (all test bundles sit in buckets 0..1).
const LIVE = 0;
function crdt() {
    return makeVoteCrdt({
        store: makeMemoryBundleStore(),
        bucketMath: makeBucketMath(BLOCKS_PER_BUCKET),
        voteExpiryBuckets: 2
    });
}

describe("makeVoteCrdt — LWW reduction", () => {
    it("keeps the highest-blockNumber bundle per wallet", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 100));
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], 200));

        const current = c.current(LIVE);
        expect(current).toHaveLength(1);
        expect(current[0].blockNumber).toBe(200);
        expect(current[0].votes[0].community.publicKey).toBe(KEY_B);
    });

    it("collapses same-wallet equivocation (same blockNumber) to one, tie-broken by lowest CID", async () => {
        const store = makeMemoryBundleStore();
        // Two conflicting bundles from one wallet at the same block, so this is a pure LWW
        // tiebreak on bundle CID.
        const bundleA = bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 300);
        const bundleB = bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], 300);
        const cidA = await store.put(bundleA);
        const cidB = await store.put(bundleB);

        const c = makeVoteCrdt({ store, bucketMath: makeBucketMath(BLOCKS_PER_BUCKET), voteExpiryBuckets: 2 });
        await c.merge([cidA, cidB]);

        const current = c.current(LIVE);
        expect(current).toHaveLength(1);
        // The winner is the one whose bundle CID the resolver picks as lowest.
        const winnerCid = lwwResolve({ bundle: bundleA, cid: cidA }, { bundle: bundleB, cid: cidB });
        const winnerKey = winnerCid.equals(cidA) ? KEY_A : KEY_B;
        expect(current[0].votes[0].community.publicKey).toBe(winnerKey);
    });

    it("supersedes an earlier vote with an empty withdrawal bundle", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 100));
        await c.add(bundle(WALLET, [], 200)); // withdrawal: newer, empty

        const current = c.current(LIVE);
        expect(current).toHaveLength(1);
        expect(current[0].votes).toHaveLength(0); // resolves to the withdrawal
    });
});

describe("makeVoteCrdt — LWW winners and monotonic union", () => {
    it("resolves one winner per wallet (the newer bundle supersedes the older)", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 100));
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], 200));

        // One wallet -> one winner (the higher-blockNumber bundle), not both bundles.
        const winners = c.current(LIVE);
        expect(winners).toHaveLength(1);
        expect(winners[0].votes[0].community.publicKey).toBe(KEY_B);
    });

    it("unions two peers' state without subtracting, and merge is idempotent", async () => {
        // A shared content-addressed store stands in for the blockstore both peers put into.
        const store = makeMemoryBundleStore();
        const deps = { store, bucketMath: makeBucketMath(BLOCKS_PER_BUCKET), voteExpiryBuckets: 2 };
        const a = makeVoteCrdt(deps);
        const b = makeVoteCrdt(deps);

        await a.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 100));
        const bCid = await b.add(bundle(OTHER, [{ community: { publicKey: KEY_B }, vote: 1 }], 100));

        await a.merge([bCid]);
        await a.merge([bCid]); // idempotent: re-merging the same CIDs changes nothing

        const wallets = new Set(a.current(LIVE).map((v) => v.address));
        expect(wallets).toEqual(new Set([WALLET, OTHER]));
        // Union only adds: a still has its own vote after merging b's.
        expect(a.current(LIVE)).toHaveLength(2);
    });
});

describe("makeVoteCrdt — read-time expiry filter", () => {
    it("current() drops an expired winner but keeps a still-live one", async () => {
        const c = crdt(); // voteExpiryBuckets = 2
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0)); // bucket 0, expires past 2
        await c.add(bundle(OTHER, [{ community: { publicKey: KEY_B }, vote: 1 }], 3 * BLOCKS_PER_BUCKET)); // bucket 3

        // At bucket 4: WALLET (bucket 0) is expired (4 > 0 + 2), OTHER (bucket 3) is live (4 <= 3 + 2).
        const current = c.current(4);
        expect(current).toHaveLength(1);
        expect(current[0].address).toBe(OTHER);
    });

    it("filters an expired bundle out of a merged set, keeping the live one", async () => {
        // Shared store = the blockstore both peers read/write. Peer C cold-starts by merging
        // the winner CIDs a peer serves — each an independent, standalone bundle CID.
        const store = makeMemoryBundleStore();
        const deps = { store, bucketMath: makeBucketMath(BLOCKS_PER_BUCKET), voteExpiryBuckets: 2 };
        const producer = makeVoteCrdt(deps);

        const aCid = await producer.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0)); // A, bucket 0
        const bCid = await producer.add(bundle(OTHER, [{ community: { publicKey: KEY_B }, vote: 1 }], 3 * BLOCKS_PER_BUCKET)); // B, bucket 3

        const c = makeVoteCrdt(deps);
        await c.merge([aCid, bCid]); // integrate both standalone bundles

        // At bucket 4: A (bucket 0) is expired, B (bucket 3) is live. A must not pollute the view.
        const current = c.current(4);
        expect(current).toHaveLength(1);
        expect(current[0].address).toBe(OTHER);
        expect((await store.get(bCid))?.address).toBe(OTHER); // the live winner's block is intact
    });

    it("filters an expired bundle a stale peer re-injects (gate does not check expiry)", async () => {
        const store = makeMemoryBundleStore();
        const deps = { store, bucketMath: makeBucketMath(BLOCKS_PER_BUCKET), voteExpiryBuckets: 2 };
        const producer = makeVoteCrdt(deps);
        const aCid = await producer.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0)); // bucket 0

        const c = makeVoteCrdt(deps);
        await c.merge([aCid]); // a stale peer re-publishes the long-decayed bundle; merge admits it

        expect(c.current(4)).toHaveLength(0); // it is never counted (nor re-served in a checkpoint)
    });
});

describe("makeVoteCrdt — prune bounds the working set", () => {
    it("drops expired and superseded nodes from memory while the tally view is unchanged", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0)); // superseded below
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], BLOCKS_PER_BUCKET)); // bucket 1, winner
        await c.add(bundle(OTHER, [{ community: { publicKey: KEY_A }, vote: 1 }], 0)); // bucket 0, expires past 2
        expect(c.nodeCount()).toBe(3);

        // At bucket 3: OTHER's node is expired; WALLET's bucket-0 node is superseded (not a winner).
        await c.prune(3);
        expect(c.nodeCount()).toBe(1); // only WALLET's winning bucket-1 node survives in memory

        // The read-time view at a live bucket is unaffected by prune — prune is memory-only.
        const current = c.current(1);
        expect(current).toHaveLength(1);
        expect(current[0].blockNumber).toBe(BLOCKS_PER_BUCKET);
    });

    it("keeps a still-live winner and drops the superseded older one", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0));
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], BLOCKS_PER_BUCKET)); // bucket 1

        await c.prune(1); // bucket 1 still live (1 <= 1 + 2); bucket 0 superseded (not winner)
        expect(c.nodeCount()).toBe(1);
        const current = c.current(1);
        expect(current).toHaveLength(1);
        expect(current[0].blockNumber).toBe(BLOCKS_PER_BUCKET);
    });
});

describe("makeVoteCrdt — provisional admits (deferred verification)", () => {
    function crdtWithProvisional(provisional: Set<string>) {
        return makeVoteCrdt({
            store: makeMemoryBundleStore(),
            bucketMath: makeBucketMath(BLOCKS_PER_BUCKET),
            voteExpiryBuckets: 2,
            isProvisional: (cid) => provisional.has(cid.toString())
        });
    }

    it("currentEntries with an eligibility filter falls back to the newest ELIGIBLE bundle per wallet", async () => {
        const c = crdt();
        const verifiedCid = await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0));
        const pendingCid = await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], BLOCKS_PER_BUCKET));

        // Unfiltered (the tally view): the newest bundle wins regardless of verification state.
        const all = c.currentEntries(1);
        expect(all).toHaveLength(1);
        expect(all[0].cid.equals(pendingCid)).toBe(true);

        // Filtered (the checkpoint view): with the pending winner ineligible, the wallet's newest
        // VERIFIED bundle is served instead of the wallet vanishing from the checkpoint.
        const verifiedOnly = c.currentEntries(1, (cid) => cid.equals(verifiedCid));
        expect(verifiedOnly).toHaveLength(1);
        expect(verifiedOnly[0].cid.equals(verifiedCid)).toBe(true);
    });

    it("remove() evicts a failed provisional bundle and its verified predecessor wins again", async () => {
        const c = crdt();
        const oldCid = await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0));
        const newCid = await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], BLOCKS_PER_BUCKET));
        expect(c.currentEntries(1)[0].cid.equals(newCid)).toBe(true);

        c.remove(newCid); // the deferred gate read failed — evict
        const current = c.currentEntries(1);
        expect(current).toHaveLength(1);
        expect(current[0].cid.equals(oldCid)).toBe(true);
    });

    it("prune keeps a superseded bundle while its superseder is provisional, drops it once settled", async () => {
        const provisional = new Set<string>();
        const c = crdtWithProvisional(provisional);
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0));
        const pendingCid = await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], BLOCKS_PER_BUCKET));
        provisional.add(pendingCid.toString());

        // While the winner is provisional, its superseded predecessor is shielded from prune —
        // it is the fallback if the deferred check evicts the winner.
        expect(await c.prune(1)).toHaveLength(0);
        expect(c.nodeCount()).toBe(2);

        // Once the winner settles, the predecessor is prunable again (and reported as removed).
        provisional.delete(pendingCid.toString());
        const removed = await c.prune(1);
        expect(removed).toHaveLength(1);
        expect(c.nodeCount()).toBe(1);
        expect(c.currentEntries(1)[0].cid.equals(pendingCid)).toBe(true);
    });

    it("prune still drops an EXPIRED superseded bundle even under a provisional winner", async () => {
        const provisional = new Set<string>();
        const c = crdtWithProvisional(provisional);
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0)); // bucket 0
        const pendingCid = await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], 4 * BLOCKS_PER_BUCKET));
        provisional.add(pendingCid.toString());

        // At bucket 4 the bucket-0 bundle is past expiry (0 + 2 < 4): an expired fallback is
        // useless (current() would filter it anyway), so the shield does not apply.
        const removed = await c.prune(4);
        expect(removed).toHaveLength(1);
        expect(c.nodeCount()).toBe(1);
    });
});
