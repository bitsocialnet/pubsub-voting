import { describe, it, expect } from "vitest";
import { makeVoteCrdt, lwwResolve } from "./crdt.js";
import { makeMemoryBundleStore } from "./store.js";
import { makeBucketMath } from "../chain/bucket.js";
import type { Vote, VotesBundle } from "../schema/votes.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

// The CRDT is trust-neutral storage; it never checks signatures, so a placeholder is fine.
function bundle(address: string, votes: Vote[], blockNumber: number): VotesBundle {
    return { address, votes, blockNumber, signature: { signature: "0xsig", type: "eip712" } };
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

describe("makeVoteCrdt — winner CIDs and monotonic union", () => {
    it("winnerCids() returns the LWW winner CID per wallet (the newer supersedes the older)", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 100));
        const second = await c.add(bundle(WALLET, [{ community: { publicKey: KEY_B }, vote: 1 }], 200));

        // One wallet -> one winner CID (the higher-blockNumber bundle), not both bundles.
        const winners = c.winnerCids(LIVE);
        expect(winners).toHaveLength(1);
        expect(winners[0].equals(second)).toBe(true);
    });

    it("unions two peers' state without subtracting, and merge is idempotent", async () => {
        // A shared content-addressed store stands in for the blockstore both peers put into.
        const store = makeMemoryBundleStore();
        const deps = { store, bucketMath: makeBucketMath(BLOCKS_PER_BUCKET), voteExpiryBuckets: 2 };
        const a = makeVoteCrdt(deps);
        const b = makeVoteCrdt(deps);

        await a.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 100));
        await b.add(bundle(OTHER, [{ community: { publicKey: KEY_B }, vote: 1 }], 100));

        await a.merge(b.winnerCids(LIVE));
        await a.merge(b.winnerCids(LIVE)); // idempotent: re-merging the same CIDs changes nothing

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

    it("winnerCids() drops an expired winner CID (nothing broadcast for a decayed vote)", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0)); // bucket 0

        expect(c.winnerCids(LIVE)).toHaveLength(1); // live: still a broadcastable winner
        expect(c.winnerCids(3)).toHaveLength(0); // expired: dropped from the broadcast winner CIDs
        expect(c.current(3)).toHaveLength(0); // and from the tally view
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

        // At bucket 4: A (bucket 0) is expired, B (bucket 3) is live. A must not pollute either view.
        const current = c.current(4);
        expect(current).toHaveLength(1);
        expect(current[0].address).toBe(OTHER);

        const winners = c.winnerCids(4);
        expect(winners).toHaveLength(1);
        expect(winners[0].equals(bCid)).toBe(true); // only the live winner is broadcast
    });

    it("filters an expired bundle a stale peer re-injects (gate does not check expiry)", async () => {
        const store = makeMemoryBundleStore();
        const deps = { store, bucketMath: makeBucketMath(BLOCKS_PER_BUCKET), voteExpiryBuckets: 2 };
        const producer = makeVoteCrdt(deps);
        const aCid = await producer.add(bundle(WALLET, [{ community: { publicKey: KEY_A }, vote: 1 }], 0)); // bucket 0

        const c = makeVoteCrdt(deps);
        await c.merge([aCid]); // a stale peer re-broadcasts the long-decayed bundle; merge admits it

        expect(c.winnerCids(4)).toHaveLength(0); // we neither re-broadcast it...
        expect(c.current(4)).toHaveLength(0); // ...nor count it
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
