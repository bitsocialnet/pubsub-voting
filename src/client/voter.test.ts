import { describe, it, expect } from "vitest";
import { PubsubVoter, republishIntervalBuckets } from "./voter.js";
import { MemoryVoteStore } from "../store/memory.js";
import { selectVoteStore } from "../store/select.js";
import { MissingBlockstoreError, MissingPubsubError, NotImplementedError, ReadOnlyError } from "../errors.js";
import { topicFor } from "../topic.js";
import {
    bizCriteria,
    fakeHelia,
    fakeHeliaWithoutPubsub,
    fakeHeliaWithoutBlockstore,
    fakeChains,
    stubChains,
    fakeSigner
} from "../test-fixtures.js";

/** A valid base58btc IPNS board key (VotesBundleSchema rejects non-keys, so castVotes needs a real one). */
const VALID_KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

/** A minimal directory manifest deriving one contest (the /biz/ slot) from the shared fixture. */
function bizManifest(): unknown {
    const { name, contest, ...defaults } = bizCriteria();
    return { name: "test-directory", defaults, contests: [{ contest, name }] };
}

describe("PubsubVoter construction + read-only", () => {
    it("is read-only without a signer", () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        expect(voter.readOnly).toBe(true);
    });

    it("throws MissingPubsubError when the node's libp2p has no gossipsub service", () => {
        expect(() => new PubsubVoter({ helia: fakeHeliaWithoutPubsub(), chains: fakeChains() })).toThrow(
            MissingPubsubError
        );
    });

    it("throws MissingBlockstoreError when the node has no blockstore", () => {
        expect(() => new PubsubVoter({ helia: fakeHeliaWithoutBlockstore(), chains: fakeChains() })).toThrow(
            MissingBlockstoreError
        );
    });

    it("is writable with a signer", () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), signer: fakeSigner() });
        expect(voter.readOnly).toBe(false);
    });
});

describe("PubsubVoter.contest", () => {
    it("derives the correct topic and propagates read-only", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.contest(bizCriteria());
        expect(contest.topic).toBe(await topicFor(bizCriteria()));
        expect(contest.criteria.contest).toBe("biz");
        expect(contest.readOnly).toBe(true);
    });

    it("caches one network per topic", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        const a = await voter.contest(bizCriteria());
        const b = await voter.contest(bizCriteria());
        expect(a).toBe(b);
    });

    it("rejects an invalid criteria document", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        // @ts-expect-error intentionally invalid for the test
        await expect(voter.contest({ contest: "x" })).rejects.toThrow();
    });
});

describe("write path gating", () => {
    it("castVotes throws ReadOnlyError without a signer", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.contest(bizCriteria());
        await expect(contest.castVotes([{ board: { publicKey: "b" }, vote: 1 }])).rejects.toBeInstanceOf(ReadOnlyError);
    });

    it("castVotes signs and returns a bundle when a signer is present", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: stubChains(), signer: fakeSigner() });
        const contest = await voter.contest(bizCriteria());
        const bundle = await contest.castVotes([{ board: { publicKey: VALID_KEY }, vote: 1 }]);
        expect(bundle.address).toBe("0x0000000000000000000000000000000000000001");
        // blockNumber is the bucket boundary: bucketForBlock(43200)=1, sampleBlockForBucket(1)=43200.
        expect(bundle.blockNumber).toBe(43200);
        expect(bundle.votes[0].board.publicKey).toBe(VALID_KEY);
    });
});

describe("getTally", () => {
    it("returns an empty ranking for a contest with no votes (no chain reads)", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.contest(bizCriteria());
        expect(await contest.getTally()).toEqual({ contest: "biz", ranking: [] });
    });

    it("reflects a cast vote end-to-end (cast -> CRDT -> tally)", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: stubChains(), signer: fakeSigner() });
        const contest = await voter.contest(bizCriteria());
        await contest.castVotes([{ board: { publicKey: VALID_KEY }, vote: 1 }]);

        const tally = await contest.getTally();
        expect(tally.ranking).toHaveLength(1);
        expect(tally.ranking[0].board.publicKey).toBe(VALID_KEY);
        expect(tally.ranking[0].weight).toBe(1n); // constant weight, 1 pass = 1 vote
    });
});

describe("network lifecycle", () => {
    it("start and stop resolve, wiring the real forward-gate over the host node", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.contest(bizCriteria());
        await expect(contest.start()).resolves.toBeUndefined();
        await expect(contest.stop()).resolves.toBeUndefined();
    });
});

describe("republish cadence", () => {
    it("republishes at half the expiry window, rounded up", () => {
        expect(republishIntervalBuckets(bizCriteria())).toBe(15); // voteExpiryBuckets: 30
        expect(republishIntervalBuckets({ ...bizCriteria(), voteExpiryBuckets: 7 })).toBe(4);
        expect(republishIntervalBuckets({ ...bizCriteria(), voteExpiryBuckets: 1 })).toBe(1);
    });
});

describe("selectVoteStore", () => {
    it("returns an in-memory store until the Node/browser backends land", () => {
        expect(selectVoteStore("./data")).toBeInstanceOf(MemoryVoteStore);
        expect(selectVoteStore(undefined)).toBeInstanceOf(MemoryVoteStore);
    });
});

describe("MemoryVoteStore", () => {
    it("round-trips put / get / list / delete", async () => {
        const store = new MemoryVoteStore();
        expect(await store.list()).toEqual([]);
        const intent = { topic: "bitsocial-votes/x", address: "0xabc", votes: [], lastBucket: 42 };
        await store.put(intent);
        expect(await store.get("bitsocial-votes/x")).toEqual(intent);
        expect(await store.list()).toEqual([intent]);
        // put replaces by topic (last write wins, mirroring the CRDT).
        await store.put({ ...intent, lastBucket: 43 });
        expect((await store.get("bitsocial-votes/x"))?.lastBucket).toBe(43);
        await store.delete("bitsocial-votes/x");
        expect(await store.get("bitsocial-votes/x")).toBeUndefined();
        expect(await store.list()).toEqual([]);
    });
});

describe("PubsubVoter lifecycle", () => {
    it("accepts a manifest and a dataPath at construction (Node persistence)", () => {
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: fakeChains(),
            signer: fakeSigner(),
            manifest: bizManifest(),
            dataPath: "./.votes-test"
        });
        expect(voter.readOnly).toBe(false);
    });

    it("start() reaches the (unbuilt) engine", async () => {
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: fakeChains(),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        await expect(voter.start()).rejects.toBeInstanceOf(NotImplementedError);
    });

    it("destroy() is a safe teardown, even before start()", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        await expect(voter.destroy()).resolves.toBeUndefined();
    });

    it("stop() leaves topics and stays reusable", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() });
        await voter.contest(bizCriteria());
        await expect(voter.stop()).resolves.toBeUndefined();
    });
});
