import { describe, it, expect } from "vitest";
import { makeVoteCrdt, lwwResolve } from "./crdt.js";
import { makeMemoryDagNodeStore } from "./store.js";
import type { DagNode } from "./types.js";
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
function crdt() {
    return makeVoteCrdt({
        store: makeMemoryDagNodeStore(),
        bucketMath: makeBucketMath(BLOCKS_PER_BUCKET),
        voteExpiryBuckets: 2
    });
}

describe("makeVoteCrdt — LWW reduction", () => {
    it("keeps the highest-blockNumber bundle per wallet", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ board: { publicKey: KEY_A }, vote: 1 }], 100));
        await c.add(bundle(WALLET, [{ board: { publicKey: KEY_B }, vote: 1 }], 200));

        const current = c.current();
        expect(current).toHaveLength(1);
        expect(current[0].blockNumber).toBe(200);
        expect(current[0].votes[0].board.publicKey).toBe(KEY_B);
    });

    it("collapses same-wallet equivocation (same blockNumber) to one, tie-broken by lowest CID", async () => {
        const store = makeMemoryDagNodeStore();
        // Two conflicting bundles from one wallet at the same block, both linking no parents,
        // so this is a pure LWW tiebreak, not a DAG supersession.
        const nodeA: DagNode = { value: bundle(WALLET, [{ board: { publicKey: KEY_A }, vote: 1 }], 300), parents: [] };
        const nodeB: DagNode = { value: bundle(WALLET, [{ board: { publicKey: KEY_B }, vote: 1 }], 300), parents: [] };
        const cidA = await store.put(nodeA);
        const cidB = await store.put(nodeB);

        const c = makeVoteCrdt({ store, bucketMath: makeBucketMath(BLOCKS_PER_BUCKET), voteExpiryBuckets: 2 });
        await c.merge([cidA, cidB]);

        const current = c.current();
        expect(current).toHaveLength(1);
        // The winner is the one whose node CID the resolver picks as lowest.
        const winnerCid = lwwResolve({ bundle: nodeA.value, cid: cidA }, { bundle: nodeB.value, cid: cidB });
        const winnerKey = winnerCid.equals(cidA) ? KEY_A : KEY_B;
        expect(current[0].votes[0].board.publicKey).toBe(winnerKey);
    });

    it("supersedes an earlier vote with an empty withdrawal bundle", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ board: { publicKey: KEY_A }, vote: 1 }], 100));
        await c.add(bundle(WALLET, [], 200)); // withdrawal: newer, empty

        const current = c.current();
        expect(current).toHaveLength(1);
        expect(current[0].votes).toHaveLength(0); // resolves to the withdrawal
    });
});

describe("makeVoteCrdt — heads and monotonic union", () => {
    it("advances heads to the latest node on a linear chain", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ board: { publicKey: KEY_A }, vote: 1 }], 100));
        const second = await c.add(bundle(WALLET, [{ board: { publicKey: KEY_B }, vote: 1 }], 200));

        const heads = c.heads();
        expect(heads).toHaveLength(1);
        expect(heads[0].equals(second)).toBe(true);
    });

    it("unions two peers' state without subtracting, and merge is idempotent", async () => {
        // A shared content-addressed store stands in for the blockstore both peers put into.
        const store = makeMemoryDagNodeStore();
        const deps = { store, bucketMath: makeBucketMath(BLOCKS_PER_BUCKET), voteExpiryBuckets: 2 };
        const a = makeVoteCrdt(deps);
        const b = makeVoteCrdt(deps);

        await a.add(bundle(WALLET, [{ board: { publicKey: KEY_A }, vote: 1 }], 100));
        await b.add(bundle(OTHER, [{ board: { publicKey: KEY_B }, vote: 1 }], 100));

        await a.merge(b.heads());
        await a.merge(b.heads()); // idempotent: re-merging the same heads changes nothing

        const wallets = new Set(a.current().map((v) => v.address));
        expect(wallets).toEqual(new Set([WALLET, OTHER]));
        // Union only adds: a still has its own vote after merging b's.
        expect(a.current()).toHaveLength(2);
    });
});

describe("makeVoteCrdt — prune", () => {
    it("drops a bundle past its expiry window", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ board: { publicKey: KEY_A }, vote: 1 }], 0)); // bucket 0
        expect(c.current()).toHaveLength(1);

        // voteExpiryBuckets = 2, so bucket 0 expires once currentBucket > 2.
        await c.prune(3);
        expect(c.current()).toHaveLength(0);
    });

    it("keeps a still-live bundle and drops the superseded older one", async () => {
        const c = crdt();
        await c.add(bundle(WALLET, [{ board: { publicKey: KEY_A }, vote: 1 }], 0));
        await c.add(bundle(WALLET, [{ board: { publicKey: KEY_B }, vote: 1 }], BLOCKS_PER_BUCKET)); // bucket 1

        await c.prune(1); // bucket 1 still live (1 <= 1 + 2); bucket 0 superseded (not winner)
        const current = c.current();
        expect(current).toHaveLength(1);
        expect(current[0].blockNumber).toBe(BLOCKS_PER_BUCKET);
    });
});
