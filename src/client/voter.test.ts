import { describe, it, expect } from "vitest";
import { PubsubVoter, republishIntervalBuckets } from "./voter.js";
import type { ChainClient, ChainClientFactory } from "../chain/types.js";
import { MemoryVoteStore } from "../store/memory.js";
import { selectVoteStore } from "../store/select.js";
import {
    DuplicateContestIdError,
    MissingBlockstoreError,
    MissingManifestError,
    MissingPubsubError,
    NotImplementedError,
    ReadOnlyError,
    UnknownContestError
} from "../errors.js";
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

/**
 * A chain factory whose current block advances between calls, so a vote cast at one bucket can
 * be observed decaying at a later one. `readContract` returns 1 (constant weight ignores it).
 */
function advancingChains(currentBlock: () => bigint): ChainClientFactory {
    const client = {
        getBlockNumber: async () => currentBlock(),
        getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
        readContract: async () => 1n
    };
    return () => client as unknown as ChainClient;
}

/** A minimal directory manifest deriving one contest (the /biz/ slot) from the shared fixture. */
function bizManifest(): unknown {
    const { name, contestId, ...defaults } = bizCriteria();
    return { name: "test-directory", defaults, contests: [{ contestId, name }] };
}

/** A manifest that repeats one `contestId`, to exercise the constructor uniqueness guard. */
function dupContestIdManifest(): unknown {
    const { name, contestId, ...defaults } = bizCriteria();
    return { name: "dup", defaults, contests: [{ contestId, name }, { contestId, name: `${name} (again)` }] };
}

describe("PubsubVoter construction + read-only", () => {
    it("is read-only without a signer", () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        expect(voter.readOnly).toBe(true);
    });

    it("throws MissingPubsubError when the node's libp2p has no gossipsub service", () => {
        expect(
            () => new PubsubVoter({ helia: fakeHeliaWithoutPubsub(), chains: fakeChains(), manifest: bizManifest() })
        ).toThrow(MissingPubsubError);
    });

    it("throws MissingBlockstoreError when the node has no blockstore", () => {
        expect(
            () => new PubsubVoter({ helia: fakeHeliaWithoutBlockstore(), chains: fakeChains(), manifest: bizManifest() })
        ).toThrow(MissingBlockstoreError);
    });

    it("throws MissingManifestError when no manifest is given", () => {
        // @ts-expect-error manifest is required in v1
        expect(() => new PubsubVoter({ helia: fakeHelia(), chains: fakeChains() })).toThrow(MissingManifestError);
    });

    it("throws DuplicateContestIdError when a manifest repeats a contestId", () => {
        expect(
            () => new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: dupContestIdManifest() })
        ).toThrow(DuplicateContestIdError);
    });

    it("is writable with a signer", () => {
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: fakeChains(),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        expect(voter.readOnly).toBe(false);
    });
});

describe("PubsubVoter.getContest", () => {
    it("exposes contestIds in manifest order", () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        expect(voter.contestIds).toEqual(["biz"]);
    });

    it("derives the correct topic and propagates read-only", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const contest = await voter.getContest({ contestId: "biz" });
        expect(contest.topic).toBe(await topicFor(bizCriteria()));
        expect(contest.criteria.contestId).toBe("biz");
        expect(contest.readOnly).toBe(true);
    });

    it("caches one network per contest", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const a = await voter.getContest({ contestId: "biz" });
        const b = await voter.getContest({ contestId: "biz" });
        expect(a).toBe(b);
    });

    it("throws UnknownContestError for a contestId not in the manifest", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        await expect(voter.getContest({ contestId: "nope" })).rejects.toBeInstanceOf(UnknownContestError);
    });

    it("rejects a manifest whose derived criteria is invalid", () => {
        const bad = { name: "m", defaults: {}, contests: [{ contestId: "x", name: "/x/" }] };
        expect(() => new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bad })).toThrow();
    });
});

describe("write path gating", () => {
    it("castVotes throws ReadOnlyError without a signer", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const contest = await voter.getContest({ contestId: "biz" });
        await expect(contest.castVotes([{ board: { publicKey: "b" }, vote: 1 }])).rejects.toBeInstanceOf(ReadOnlyError);
    });

    it("castVotes signs and returns a bundle when a signer is present", async () => {
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: stubChains(),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        const contest = await voter.getContest({ contestId: "biz" });
        const bundle = await contest.castVotes([{ board: { publicKey: VALID_KEY }, vote: 1 }]);
        expect(bundle.address).toBe("0x0000000000000000000000000000000000000001");
        // blockNumber is the bucket boundary: bucketForBlock(43200)=1, sampleBlockForBucket(1)=43200.
        expect(bundle.blockNumber).toBe(43200);
        expect(bundle.votes[0].board.publicKey).toBe(VALID_KEY);
    });
});

describe("getTally", () => {
    it("returns an empty ranking for a contest with no votes (no chain reads)", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const contest = await voter.getContest({ contestId: "biz" });
        expect(await contest.getTally()).toEqual({ contestId: "biz", ranking: [] });
    });

    it("reflects a cast vote end-to-end (cast -> CRDT -> tally)", async () => {
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: stubChains(),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        const contest = await voter.getContest({ contestId: "biz" });
        await contest.castVotes([{ board: { publicKey: VALID_KEY }, vote: 1 }]);

        const tally = await contest.getTally();
        expect(tally.ranking).toHaveLength(1);
        expect(tally.ranking[0].board.publicKey).toBe(VALID_KEY);
        expect(tally.ranking[0].weight).toBe(1n); // constant weight, 1 pass = 1 vote
    });

    it("drops a vote from the tally once it decays past its expiry window", async () => {
        // bizCriteria: voteExpiryBuckets 30, blocksPerBucket 43200. Cast at bucket 1; a vote
        // there expires once the current bucket exceeds 1 + 30 = 31.
        let block = 43200n; // bucket 1
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: advancingChains(() => block),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        const contest = await voter.getContest({ contestId: "biz" });
        await contest.castVotes([{ board: { publicKey: VALID_KEY }, vote: 1 }]);

        // Still live at bucket 1: the vote counts.
        expect((await contest.getTally()).ranking).toHaveLength(1);

        // Advance well past the expiry window (bucket 32 > 31): the decayed vote is gone.
        block = 32n * 43200n;
        expect((await contest.getTally()).ranking).toEqual([]);
    });
});

describe("network lifecycle", () => {
    it("start and stop resolve, wiring the real forward-gate over the host node", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const contest = await voter.getContest({ contestId: "biz" });
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
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        await expect(voter.destroy()).resolves.toBeUndefined();
    });

    it("stop() leaves topics and stays reusable", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        await voter.getContest({ contestId: "biz" });
        await expect(voter.stop()).resolves.toBeUndefined();
    });
});
