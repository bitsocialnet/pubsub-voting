import { describe, it, expect, vi, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { PubsubVoter, republishIntervalBuckets } from "./voter.js";
import {
    decodeVoteMessage,
    decodeRootRecord,
    encodeRootMessage,
    encodeRootRecord,
    rootFetchKey,
    ROOT_RECORD_VERSION,
    type RootRecord
} from "../transport/messages.js";
import { TOPIC_PREFIX } from "../topic.js";
import type { ChainClient, ChainClientFactory } from "../chain/types.js";
import type { FetchServiceLike, HeliaInstance, PubsubService } from "../transport/types.js";
import { MemoryVoteStore } from "../store/memory.js";
import { selectVoteStore } from "../store/select.js";
import {
    DuplicateContestIdError,
    MissingBlockstoreError,
    MissingFetchError,
    MissingManifestError,
    MissingPubsubError,
    ReadOnlyError,
    UnknownContestError
} from "../errors.js";
import { topicFor } from "../topic.js";
import {
    bizCriteria,
    fakeHelia,
    fakeHeliaWithoutPubsub,
    fakeHeliaWithoutBlockstore,
    fakeHeliaWithoutFetch,
    fakeFetchService,
    fakeChains,
    stubChains,
    fakeSigner
} from "../test-fixtures.js";

/** A valid base58btc IPNS community key (VotesBundleSchema rejects non-keys, so castVotes needs a real one). */
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

/**
 * A Helia node whose gossipsub `publish` is a spy, so a test can count re-broadcasts: every
 * cast/republish calls `publishBundle` → `publish`. Otherwise a no-op node like `fakeHelia`.
 */
function spyableHelia(): { helia: HeliaInstance; publish: ReturnType<typeof vi.fn> } {
    const publish = vi.fn(async () => undefined);
    const pubsub = {
        publish,
        subscribe: () => {},
        unsubscribe: () => {},
        getSubscribers: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
        topicValidators: new Map()
    } satisfies PubsubService;
    const blockstore = { get: async () => new Uint8Array(), put: async (cid: unknown) => cid, has: async () => false };
    const helia = { libp2p: { services: { pubsub, fetch: fakeFetchService() } }, blockstore } as unknown as HeliaInstance;
    return { helia, publish };
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

    it("throws MissingFetchError when the node's libp2p has no fetch service", () => {
        expect(
            () => new PubsubVoter({ helia: fakeHeliaWithoutFetch(), chains: fakeChains(), manifest: bizManifest() })
        ).toThrow(MissingFetchError);
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
        await expect(contest.castVotes([{ community: { publicKey: "b" }, vote: 1 }])).rejects.toBeInstanceOf(ReadOnlyError);
    });

    it("castVotes signs and returns a bundle when a signer is present", async () => {
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: stubChains(),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        const contest = await voter.getContest({ contestId: "biz" });
        const bundle = await contest.castVotes([{ community: { publicKey: VALID_KEY }, vote: 1 }]);
        expect(bundle.address).toBe("0x0000000000000000000000000000000000000001");
        // blockNumber is the bucket boundary: bucketForBlock(43200)=1, sampleBlockForBucket(1)=43200.
        expect(bundle.blockNumber).toBe(43200);
        expect(bundle.votes[0].community.publicKey).toBe(VALID_KEY);
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
        await contest.castVotes([{ community: { publicKey: VALID_KEY }, vote: 1 }]);

        const tally = await contest.getTally();
        expect(tally.ranking).toHaveLength(1);
        expect(tally.ranking[0].community.publicKey).toBe(VALID_KEY);
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
        await contest.castVotes([{ community: { publicKey: VALID_KEY }, vote: 1 }]);

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
    it("uses in-memory on Node without a dataPath, and a durable backend with one", () => {
        // No `indexedDB` in the Node test env and no dataPath ⇒ in-memory.
        expect(selectVoteStore(undefined)).toBeInstanceOf(MemoryVoteStore);
        // A dataPath selects the (lazily-loaded) durable Node backend, not the memory store.
        expect(selectVoteStore("./data")).not.toBeInstanceOf(MemoryVoteStore);
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

    it("start() resolves and keeps the voter usable (no longer a stub)", async () => {
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: fakeChains(),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        await expect(voter.start()).resolves.toBeUndefined();
        await voter.stop();
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

/**
 * A chain factory whose `getBlockNumber` is a spy, so a test can count how many head reads the
 * scheduler makes (each tick's freshness read is one) — the way to prove a timer stopped firing
 * even when no re-broadcast is expected. Block advances via the `currentBlock` closure.
 */
function countingChains(currentBlock: () => bigint): { chains: ChainClientFactory; getBlockNumber: ReturnType<typeof vi.fn> } {
    const getBlockNumber = vi.fn(async () => currentBlock());
    const client = {
        getBlockNumber,
        getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
        readContract: async () => 1n
    };
    return { chains: () => client as unknown as ChainClient, getBlockNumber };
}

describe("republish scheduler", () => {
    afterEach(() => vi.useRealTimers());

    const BUCKET = 43200; // bizCriteria blocksPerBucket; voteExpiryBuckets 30 ⇒ interval 15.
    const bucketBlock = (n: number): bigint => BigInt(n * BUCKET);
    const VOTE = [{ community: { publicKey: VALID_KEY }, vote: 1 }];

    it("revives a stored intent immediately on start() when the cadence is due", async () => {
        vi.useFakeTimers();
        let block = bucketBlock(1);
        const { helia, publish } = spyableHelia();
        const voter = new PubsubVoter({
            helia,
            chains: advancingChains(() => block),
            signer: fakeSigner(),
            manifest: bizManifest(),
            republishPollIntervalMs: 1000
        });
        const contest = await voter.getContest({ contestId: "biz" });
        await contest.castVotes(VOTE); // intent stored at bucket 1; no transport yet ⇒ no broadcast
        expect(publish).not.toHaveBeenCalled();

        block = bucketBlock(20); // past bucket 1 + interval(15)
        await voter.start(); // arming revives the stored intent right away (no timer tick needed)
        expect(publish).toHaveBeenCalledTimes(1);
        await voter.stop();
    });

    it("re-signs on a poll tick once due, and not before", async () => {
        vi.useFakeTimers();
        let block = bucketBlock(1);
        const { helia, publish } = spyableHelia();
        const voter = new PubsubVoter({
            helia,
            chains: advancingChains(() => block),
            signer: fakeSigner(),
            manifest: bizManifest(),
            republishPollIntervalMs: 1000
        });
        await voter.start(); // no intents yet
        const contest = await voter.getContest({ contestId: "biz" });
        await contest.castVotes(VOTE); // transport live ⇒ one broadcast, intent at bucket 1
        expect(publish).toHaveBeenCalledTimes(1);

        // Not due: bucket 5 < 1 + 15. A tick re-reads the head + prunes but does not re-sign.
        block = bucketBlock(5);
        await vi.advanceTimersByTimeAsync(1000);
        expect(publish).toHaveBeenCalledTimes(1);

        // Due: bucket 20 ≥ 1 + 15. The next tick re-signs (a second broadcast).
        block = bucketBlock(20);
        await vi.advanceTimersByTimeAsync(1000);
        expect(publish).toHaveBeenCalledTimes(2);
        await voter.stop();
    });

    it("encodes the root record on demand, caches it until the state changes, and stores its blocks", async () => {
        vi.useFakeTimers();
        let block = bucketBlock(1);
        const puts = new Set<string>();
        const { helia } = spyableHelia();
        const bs = (helia as unknown as { blockstore: { put(cid: CID, bytes: Uint8Array): Promise<CID> } }).blockstore;
        const origPut = bs.put.bind(bs);
        bs.put = async (cid, bytes) => {
            puts.add(cid.toString());
            return origPut(cid, bytes);
        };
        const voter = new PubsubVoter({
            helia,
            chains: advancingChains(() => block),
            signer: fakeSigner(),
            manifest: bizManifest(),
            republishPollIntervalMs: 1000
        });
        await voter.start();
        const contest = await voter.getContest({ contestId: "biz" });
        // `rootRecord`/`latestCheckpointRoot` serve the fetch responder + heartbeat, not the
        // public VoteNetwork interface, so reach them structurally in the test.
        const ck = contest as unknown as {
            rootRecord(): Promise<RootRecord>;
            latestCheckpointRoot(): CID | undefined;
        };
        expect(ck.latestCheckpointRoot()).toBeUndefined(); // nothing encoded yet

        await contest.castVotes(VOTE); // state at bucket 1
        const record = await ck.rootRecord();
        expect(record.count).toBe(1);
        expect(puts.has(record.root.toString())).toBe(true); // blocks written for directed bitswap
        expect(ck.latestCheckpointRoot()?.equals(record.root)).toBe(true);

        // Cached: an unchanged winner-set returns the same record without a re-encode.
        expect(await ck.rootRecord()).toBe(record);

        // A state change (the scheduler's re-sign at a later bucket) invalidates the cache.
        block = bucketBlock(20); // past the republish cadence (15)
        await vi.advanceTimersByTimeAsync(1000); // one poll tick: re-sign
        const after = await ck.rootRecord();
        expect(after.root.equals(record.root)).toBe(false);
        await voter.stop();
    });

    it("stop() clears the timers so no further ticks run", async () => {
        vi.useFakeTimers();
        let block = bucketBlock(1);
        const { chains, getBlockNumber } = countingChains(() => block);
        const voter = new PubsubVoter({
            helia: spyableHelia().helia,
            chains,
            signer: fakeSigner(),
            manifest: bizManifest(),
            republishPollIntervalMs: 1000
        });
        await voter.start();
        const contest = await voter.getContest({ contestId: "biz" });
        await contest.castVotes(VOTE);

        await voter.stop();
        const readsAfterStop = getBlockNumber.mock.calls.length;
        block = bucketBlock(50);
        await vi.advanceTimersByTimeAsync(5000); // five intervals of wall-clock
        // No tick fired: the head is never re-read after stop.
        expect(getBlockNumber.mock.calls.length).toBe(readsAfterStop);
    });

    it("a read-only voter start()s without arming the scheduler", async () => {
        vi.useFakeTimers();
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        await expect(voter.start()).resolves.toBeUndefined();
        await voter.stop();
    });

    it("withdrawal (castVotes([])) re-announces the tombstone each cadence, then stops at expiry", async () => {
        vi.useFakeTimers();
        let block = bucketBlock(1);
        const { helia, publish } = spyableHelia();
        const voter = new PubsubVoter({
            helia,
            chains: advancingChains(() => block),
            signer: fakeSigner(),
            manifest: bizManifest(),
            republishPollIntervalMs: 1000
        });
        await voter.start();
        const contest = await voter.getContest({ contestId: "biz" });
        await contest.castVotes(VOTE); // real vote at bucket 1: broadcast #1
        expect(publish).toHaveBeenCalledTimes(1);
        // Withdraw at bucket 2 (a real withdrawal is later than the vote, so its higher blockNumber
        // supersedes under LWW). Tombstone anchored at bucket 2, expiring at bucket 2 + 30 = 32.
        block = bucketBlock(2);
        await contest.castVotes([]); // broadcast #2
        expect(publish).toHaveBeenCalledTimes(2);
        expect((await contest.getTally()).ranking).toEqual([]); // superseded immediately

        // Not yet a cadence since the withdrawal (bucket 10, 10 - 2 = 8 < interval 15): no re-announce.
        block = bucketBlock(10);
        await vi.advanceTimersByTimeAsync(1000);
        expect(publish).toHaveBeenCalledTimes(2);

        // A cadence has passed (bucket 20, 20 - 2 = 18 ≥ 15): re-announce the STILL-LIVE tombstone's
        // existing CID (a re-broadcast, not a re-sign — its blockNumber/expiry are untouched).
        block = bucketBlock(20);
        await vi.advanceTimersByTimeAsync(1000);
        expect(publish).toHaveBeenCalledTimes(3);

        // Right after, not yet another cadence (bucket 25, 25 - 20 = 5 < 15): no re-announce.
        block = bucketBlock(25);
        await vi.advanceTimersByTimeAsync(1000);
        expect(publish).toHaveBeenCalledTimes(3);

        // Past the tombstone's OWN expiry (bucket 40 > 2 + 30): the scheduler drops the intent and
        // stops. Because it was only ever re-announced (never re-signed into a moving expiry), no
        // further broadcasts happen no matter how many ticks fire.
        block = bucketBlock(40);
        await vi.advanceTimersByTimeAsync(1000);
        expect(publish).toHaveBeenCalledTimes(3);
        block = bucketBlock(90);
        await vi.advanceTimersByTimeAsync(5000);
        expect(publish).toHaveBeenCalledTimes(3);
        expect((await contest.getTally()).ranking).toEqual([]);
        await voter.stop();
    });

    it("forget(contestId) stops the heartbeat without publishing", async () => {
        vi.useFakeTimers();
        let block = bucketBlock(1);
        const { helia, publish } = spyableHelia();
        const voter = new PubsubVoter({
            helia,
            chains: advancingChains(() => block),
            signer: fakeSigner(),
            manifest: bizManifest(),
            republishPollIntervalMs: 1000
        });
        await voter.start();
        const contest = await voter.getContest({ contestId: "biz" });
        await contest.castVotes(VOTE); // real vote: broadcast #1, intent stored at bucket 1
        expect(publish).toHaveBeenCalledTimes(1);

        await voter.forget({ contestId: "biz" }); // passive: drops the intent, publishes nothing
        expect(publish).toHaveBeenCalledTimes(1);

        // No re-sign: with the intent gone the scheduler keeps nothing alive even once "due".
        block = bucketBlock(20);
        await vi.advanceTimersByTimeAsync(5000);
        expect(publish).toHaveBeenCalledTimes(1);

        // Past the vote's own expiry (bucket 1 + 30): it decayed passively, so the tally is empty.
        block = bucketBlock(40);
        expect((await contest.getTally()).ranking).toEqual([]);
        await voter.stop();
    });

    it("forget on an unknown contest throws UnknownContestError", async () => {
        const voter = new PubsubVoter({
            helia: spyableHelia().helia,
            chains: fakeChains(),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        await expect(voter.forget({ contestId: "nope" })).rejects.toBeInstanceOf(UnknownContestError);
    });
});

/**
 * Root-record heartbeat (see DESIGN.md "Checkpoints", "Two transports for the same record").
 * `Math.random` is pinned to 0.5 so the ±25% jitter resolves to exactly the 10-minute base
 * interval, making timer advances deterministic.
 */
describe("root-record heartbeat", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    const INTERVAL_MS = 600_000; // jitter factor 0.75 + 0.5 * 0.5 = 1.0 under the pinned random

    /** Count published messages that decode to the root kind. */
    function rootPublishes(publish: ReturnType<typeof vi.fn>): number {
        return publish.mock.calls.filter((call) => {
            try {
                return decodeVoteMessage((call as [string, Uint8Array])[1]).kind === "root";
            } catch {
                return false;
            }
        }).length;
    }

    /** A read-only voter (no scheduler noise) with its topic validator + publish spy exposed. */
    async function heartbeatHarness() {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const { helia, publish } = spyableHelia();
        const pubsub = (helia as unknown as { libp2p: { services: { pubsub: PubsubService } } }).libp2p.services.pubsub;
        const voter = new PubsubVoter({ helia, chains: advancingChains(() => bucketBlock(1)), manifest: bizManifest() });
        await voter.start();
        const contest = await voter.getContest({ contestId: "biz" });
        const validator = pubsub.topicValidators!.get(contest.topic)!;
        const deliver = async (record: RootRecord, from = "peer2") => {
            const peer = { toString: () => from } as unknown as Parameters<typeof validator>[0];
            const verdict = await validator(peer, { topic: contest.topic, data: encodeRootMessage(record) });
            await vi.advanceTimersByTimeAsync(1); // flush the fire-and-forget hint handler
            return verdict;
        };
        const ownRecord = () => (contest as unknown as { rootRecord(): Promise<RootRecord> }).rootRecord();
        return { voter, contest, publish, deliver, ownRecord };
    }

    it("heartbeats its root record once per interval when nothing was heard", async () => {
        const h = await heartbeatHarness();
        expect(rootPublishes(h.publish)).toBe(0);
        await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(rootPublishes(h.publish)).toBe(1);
        await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(rootPublishes(h.publish)).toBe(2);
        await h.voter.stop();
        // stop() disarms the timer: no further heartbeats.
        await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
        expect(rootPublishes(h.publish)).toBe(2);
    });

    it("suppresses its heartbeat when a matching root was heard this interval", async () => {
        const h = await heartbeatHarness();
        expect(await h.deliver(await h.ownRecord())).toBe("accept"); // a converged peer spoke first
        await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(rootPublishes(h.publish)).toBe(0); // suppressed — the topic already carried this root
        // The next interval heard nothing, so the heartbeat resumes.
        await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(rootPublishes(h.publish)).toBe(1);
        await h.voter.stop();
    });

    it("answers a divergent root once per interval (no chorus) and stays quiet that interval", async () => {
        const h = await heartbeatHarness();
        const foreign: RootRecord = {
            version: ROOT_RECORD_VERSION,
            root: CID.parse("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4"),
            count: 1,
            sizeBytes: 100
        };
        expect(await h.deliver(foreign)).toBe("accept"); // forwarded (an unverifiable hint)
        expect(rootPublishes(h.publish)).toBe(1); // answered with our own record...
        await h.deliver(foreign, "peer3");
        expect(rootPublishes(h.publish)).toBe(1); // ...but only once per interval, however many arrive
        // The response already spoke for this interval: the timer stays quiet...
        await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(rootPublishes(h.publish)).toBe(1);
        // ...and the following (silent) interval heartbeats normally.
        await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(rootPublishes(h.publish)).toBe(2);
        await h.voter.stop();
    });
});

/**
 * The root-record fetch protocol: the responder registered on the host's fetch service and
 * the cold-join requester (see DESIGN.md "Checkpoints", "Cold-join pull").
 */
describe("root-record fetch protocol", () => {
    /** A helia whose fetch service records registrations and serves canned per-peer answers. */
    function fetchSpyHelia(peerAnswers: Map<string, Uint8Array>) {
        const lookups = new Map<string, (key: string) => Promise<Uint8Array | undefined>>();
        const fetchCalls: Array<{ peer: string; key: string }> = [];
        const fetchService: FetchServiceLike = {
            fetch: async (peer, key) => {
                fetchCalls.push({ peer: peer.toString(), key });
                return peerAnswers.get(peer.toString());
            },
            registerLookupFunction: (prefix, lookup) => {
                lookups.set(prefix, lookup);
            },
            unregisterLookupFunction: (prefix) => {
                lookups.delete(prefix);
            }
        };
        const subscribers = [...peerAnswers.keys()].map((id) => ({ toString: () => id }));
        const chased: string[] = []; // root CIDs the chase pulled blocks for
        const pubsub: PubsubService = {
            publish: async () => undefined,
            subscribe: () => {},
            unsubscribe: () => {},
            getSubscribers: () => subscribers as unknown as ReturnType<PubsubService["getSubscribers"]>,
            addEventListener: () => {},
            removeEventListener: () => {},
            topicValidators: new Map()
        };
        const blockstore = {
            get: async (cid: CID) => {
                chased.push(cid.toString());
                throw new Error("no block"); // the chase yields nothing; only the attempt matters here
            },
            put: async (cid: CID) => cid,
            has: async () => false
        };
        const helia = { libp2p: { services: { pubsub, fetch: fetchService } }, blockstore } as unknown as HeliaInstance;
        return { helia, lookups, fetchCalls, chased };
    }

    it("registers a responder that answers <topic>/root with the on-demand record, and unregisters on stop", async () => {
        const h = fetchSpyHelia(new Map());
        const voter = new PubsubVoter({ helia: h.helia, chains: fakeChains(), manifest: bizManifest() });
        await voter.start();
        const lookup = h.lookups.get(TOPIC_PREFIX);
        expect(lookup).toBeDefined();

        const contest = await voter.getContest({ contestId: "biz" });
        const answer = await lookup!(rootFetchKey(contest.topic));
        expect(answer).toBeDefined();
        const record = decodeRootRecord(answer!);
        expect(record.version).toBe(ROOT_RECORD_VERSION);
        expect(record.count).toBe(0); // an empty winner-set still answers (the empty checkpoint)

        // Foreign key shapes and unknown topics answer nothing.
        expect(await lookup!(contest.topic)).toBeUndefined(); // no /root suffix
        expect(await lookup!(rootFetchKey(`${TOPIC_PREFIX}nope`))).toBeUndefined();

        await voter.stop();
        expect(h.lookups.has(TOPIC_PREFIX)).toBe(false);
    });

    it("cold-joins by pulling each subscriber's record and chasing every distinct divergent root (union, not quorum)", async () => {
        const rootA = CID.parse("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4");
        const rootB = CID.parse("bafyreigz22r5ujmwkzdopj5b4yl55plabqbrq3hf3gvv4b6ekfbf2xxfd4");
        const recordOf = (root: CID) => encodeRootRecord({ version: ROOT_RECORD_VERSION, root, count: 1, sizeBytes: 100 });
        const h = fetchSpyHelia(
            new Map([
                ["peerA", recordOf(rootA)], // two peers agree on rootA...
                ["peerB", recordOf(rootA)],
                ["peerC", recordOf(rootB)], // ...one lone peer differs — still chased
                ["peerD", new Uint8Array([0xff])] // and one answers garbage — ignored
            ])
        );
        const voter = new PubsubVoter({ helia: h.helia, chains: fakeChains(), manifest: bizManifest() });
        await voter.start();
        const contest = await voter.getContest({ contestId: "biz" });

        await vi.waitFor(() => expect(h.fetchCalls.length).toBe(4));
        expect(new Set(h.fetchCalls.map((c) => c.key))).toEqual(new Set([rootFetchKey(contest.topic)]));
        // Both distinct roots were chased (the lone divergent one included); the agreeing pair
        // collapsed into one chase via the in-flight dedup.
        await vi.waitFor(() => {
            expect(h.chased).toContain(rootA.toString());
            expect(h.chased).toContain(rootB.toString());
        });
        await voter.stop();
    });
});
