import { describe, it, expect, vi, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { PubsubVoter, republishIntervalBuckets, type PublishingState } from "./voter.js";
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

/** A valid base58btc IPNS community key (VotesBundleSchema rejects non-keys, so a real one is needed). */
const VALID_KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
/** A one-community upvote used across the publish tests. */
const VOTE = [{ community: { publicKey: VALID_KEY }, vote: 1 }];

/**
 * A chain factory whose current block advances between calls, so a vote published at one bucket can
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
 * A Helia node whose gossipsub `publish` is a spy, so a test can count broadcasts: every
 * publish/heartbeat calls `publishBundle`/`publishRootRecord` → `publish`. Otherwise a no-op node.
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

describe("PubsubVoter.createContest", () => {
    it("exposes contestIds in manifest order", () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        expect(voter.contestIds).toEqual(["biz"]);
    });

    it("derives the correct topic and criteria", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const contest = await voter.createContest({ contestId: "biz" });
        expect(contest.topic).toBe(await topicFor(bizCriteria()));
        expect(contest.criteria.contestId).toBe("biz");
    });

    it("returns the stable per-contest object", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const a = await voter.createContest({ contestId: "biz" });
        const b = await voter.createContest({ contestId: "biz" });
        expect(a).toBe(b);
    });

    it("throws UnknownContestError for a contestId not in the manifest", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        await expect(voter.createContest({ contestId: "nope" })).rejects.toBeInstanceOf(UnknownContestError);
    });

    it("rejects a manifest whose derived criteria is invalid", () => {
        const bad = { name: "m", defaults: {}, contests: [{ contestId: "x", name: "/x/" }] };
        expect(() => new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bad })).toThrow();
    });
});

describe("createContestVote (publish path)", () => {
    it("throws UnknownContestError for a contestId not in the manifest", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), signer: fakeSigner(), manifest: bizManifest() });
        await expect(voter.createContestVote({ contestId: "nope", votes: [] })).rejects.toBeInstanceOf(UnknownContestError);
    });

    it("publish() throws ReadOnlyError (and emits error + failed state) without a signer", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const vote = await voter.createContestVote({ contestId: "biz", votes: VOTE });
        const states: PublishingState[] = [];
        const errors: unknown[] = [];
        vote.on("publishingstatechange", (s) => states.push(s));
        vote.on("error", (e) => errors.push(e));
        await expect(vote.publish()).rejects.toBeInstanceOf(ReadOnlyError);
        expect(vote.publishingState).toBe("failed");
        expect(states).toEqual(["failed"]);
        expect(errors[0]).toBeInstanceOf(ReadOnlyError);
    });

    it("walks publishingState stopped -> signing -> publishing -> succeeded and resolves the bundle", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: stubChains(), signer: fakeSigner(), manifest: bizManifest() });
        const vote = await voter.createContestVote({ contestId: "biz", votes: VOTE });
        const states: PublishingState[] = [];
        vote.on("publishingstatechange", (s) => states.push(s));
        expect(vote.publishingState).toBe("stopped");

        const bundle = await vote.publish();
        expect(states).toEqual(["signing", "publishing", "succeeded"]);
        expect(vote.publishingState).toBe("succeeded");
        expect(vote.bundle).toBe(bundle);
        expect(bundle.address).toBe("0x0000000000000000000000000000000000000001");
        // blockNumber is the bucket boundary: bucketForBlock(43200)=1, sampleBlockForBucket(1)=43200.
        expect(bundle.blockNumber).toBe(43200);
        expect(bundle.votes[0].community.publicKey).toBe(VALID_KEY);
    });

    it("broadcasts the bundle once over the host node's gossipsub", async () => {
        const { helia, publish } = spyableHelia();
        const voter = new PubsubVoter({ helia, chains: stubChains(), signer: fakeSigner(), manifest: bizManifest() });
        const vote = await voter.createContestVote({ contestId: "biz", votes: VOTE });
        await vote.publish();
        // Exactly one bundle-kind message (the live delta). The heartbeat only fires 10 min out.
        const bundleBroadcasts = publish.mock.calls.filter((call) => {
            try {
                return decodeVoteMessage((call as [string, Uint8Array])[1]).kind === "bundle";
            } catch {
                return false;
            }
        }).length;
        expect(bundleBroadcasts).toBe(1);
    });
});

describe("Contest read view + tally", () => {
    it("returns an empty ranking for a contest with no votes (no chain reads)", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const contest = await voter.createContest({ contestId: "biz" });
        expect(await contest.getTally()).toEqual({ contestId: "biz", ranking: [] });
    });

    it("reflects a published vote end-to-end (publish -> shared engine CRDT -> tally)", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: stubChains(), signer: fakeSigner(), manifest: bizManifest() });
        await (await voter.createContestVote({ contestId: "biz", votes: VOTE })).publish();

        const contest = await voter.createContest({ contestId: "biz" });
        const tally = await contest.getTally();
        expect(tally.ranking).toHaveLength(1);
        expect(tally.ranking[0].community.publicKey).toBe(VALID_KEY);
        expect(tally.ranking[0].weight).toBe(1n); // constant weight, 1 pass = 1 vote
    });

    it("update() emits an initial update and a fresh tally when a later vote is published", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: stubChains(), signer: fakeSigner(), manifest: bizManifest() });
        const contest = await voter.createContest({ contestId: "biz" });
        let updates = 0;
        contest.on("update", () => {
            updates += 1;
        });
        await contest.update();
        expect(updates).toBe(1); // initial update fires with the current (empty) state
        expect(contest.tally).toEqual({ contestId: "biz", ranking: [] });

        await (await voter.createContestVote({ contestId: "biz", votes: VOTE })).publish();
        await vi.waitFor(() => expect(contest.tally?.ranking).toHaveLength(1));
        expect(updates).toBeGreaterThanOrEqual(2); // the publish triggered a recompute + emit
        expect(contest.tally?.ranking[0].community.publicKey).toBe(VALID_KEY);
        await contest.stop();
    });

    it("drops a vote from the tally once it decays past its expiry window", async () => {
        // bizCriteria: voteExpiryBuckets 30, blocksPerBucket 43200. Publish at bucket 1; a vote
        // there expires once the current bucket exceeds 1 + 30 = 31.
        let block = 43200n; // bucket 1
        const voter = new PubsubVoter({
            helia: fakeHelia(),
            chains: advancingChains(() => block),
            signer: fakeSigner(),
            manifest: bizManifest()
        });
        await (await voter.createContestVote({ contestId: "biz", votes: VOTE })).publish();
        const contest = await voter.createContest({ contestId: "biz" });

        // Still live at bucket 1: the vote counts.
        expect((await contest.getTally()).ranking).toHaveLength(1);

        // Advance well past the expiry window (bucket 32 > 31): the decayed vote is gone.
        block = 32n * 43200n;
        expect((await contest.getTally()).ranking).toEqual([]);
    });
});

describe("Contest lifecycle", () => {
    it("update() and stop() resolve, wiring the real forward-gate over the host node", async () => {
        const voter = new PubsubVoter({ helia: fakeHelia(), chains: fakeChains(), manifest: bizManifest() });
        const contest = await voter.createContest({ contestId: "biz" });
        await expect(contest.update()).resolves.toBeUndefined();
        await expect(contest.stop()).resolves.toBeUndefined();
    });
});

describe("republish cadence helper (client-owned republishing)", () => {
    it("recommends half the expiry window, rounded up", () => {
        expect(republishIntervalBuckets(bizCriteria())).toBe(15); // voteExpiryBuckets: 30
        expect(republishIntervalBuckets({ ...bizCriteria(), voteExpiryBuckets: 7 })).toBe(4);
        expect(republishIntervalBuckets({ ...bizCriteria(), voteExpiryBuckets: 1 })).toBe(1);
    });
});

describe("PubsubVoter lifecycle", () => {
    it("start() joins every contest and keeps the voter usable", async () => {
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
        await voter.createContest({ contestId: "biz" });
        await expect(voter.stop()).resolves.toBeUndefined();
    });
});

describe("checkpoint root record (on-demand encode + cache)", () => {
    const BUCKET = 43200; // bizCriteria blocksPerBucket
    const bucketBlock = (n: number): bigint => BigInt(n * BUCKET);

    it("encodes the root record on demand, caches it until the state changes, and stores its blocks", async () => {
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
            manifest: bizManifest()
        });
        await voter.start();
        const contest = await voter.createContest({ contestId: "biz" });
        // `rootRecord`/`latestCheckpointRoot` are internal hooks on the view (see voter.ts), not part
        // of the public Contest interface; reach them structurally in the test.
        const ck = contest as unknown as {
            rootRecord(): Promise<RootRecord>;
            latestCheckpointRoot(): CID | undefined;
        };
        expect(ck.latestCheckpointRoot()).toBeUndefined(); // nothing encoded yet

        await (await voter.createContestVote({ contestId: "biz", votes: VOTE })).publish(); // state at bucket 1
        const record = await ck.rootRecord();
        expect(record.count).toBe(1);
        expect(puts.has(record.root.toString())).toBe(true); // blocks written for directed bitswap
        expect(ck.latestCheckpointRoot()?.equals(record.root)).toBe(true);

        // Cached: an unchanged winner-set returns the same record without a re-encode.
        expect(await ck.rootRecord()).toBe(record);

        // A state change (re-publishing at a later bucket supersedes under LWW) invalidates the cache.
        block = bucketBlock(20);
        await (await voter.createContestVote({ contestId: "biz", votes: VOTE })).publish();
        const after = await ck.rootRecord();
        expect(after.root.equals(record.root)).toBe(false);
        await voter.stop();
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
    const bucketBlock = (n: number): bigint => BigInt(n * 43200);

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

    /** A read-only voter with its topic validator + publish spy exposed. */
    async function heartbeatHarness() {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const { helia, publish } = spyableHelia();
        const pubsub = (helia as unknown as { libp2p: { services: { pubsub: PubsubService } } }).libp2p.services.pubsub;
        const voter = new PubsubVoter({ helia, chains: advancingChains(() => bucketBlock(1)), manifest: bizManifest() });
        await voter.start();
        const contest = await voter.createContest({ contestId: "biz" });
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
        // `@libp2p/fetch` invokes the lookup with the key as raw bytes, not a string.
        const lookups = new Map<string, (key: Uint8Array) => Promise<Uint8Array | undefined>>();
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

        const contest = await voter.createContest({ contestId: "biz" });
        // The key arrives as utf8 bytes, exactly as `@libp2p/fetch` hands it to the responder.
        const asKey = (s: string): Uint8Array => new TextEncoder().encode(s);
        const answer = await lookup!(asKey(rootFetchKey(contest.topic)));
        expect(answer).toBeDefined();
        const record = decodeRootRecord(answer!);
        expect(record.version).toBe(ROOT_RECORD_VERSION);
        expect(record.count).toBe(0); // an empty winner-set still answers (the empty checkpoint)

        // Foreign key shapes and unknown topics answer nothing.
        expect(await lookup!(asKey(contest.topic))).toBeUndefined(); // no /root suffix
        expect(await lookup!(asKey(rootFetchKey(`${TOPIC_PREFIX}nope`)))).toBeUndefined();

        await voter.stop();
        expect(h.lookups.has(TOPIC_PREFIX)).toBe(false);
    });

    it("cold-joins by pulling each subscriber's record and chasing every distinct divergent root (union, not quorum)", async () => {
        const rootA = CID.parse("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4");
        const rootB = CID.parse("bafyreigz22r5ujmwkzdopj5b4yl55plabqbrq3hf3gvv4b6ekfbf2xxfd4");
        const recordOf = (root: CID) => encodeRootRecord({ version: ROOT_RECORD_VERSION, root, chunks: [], count: 1, sizeBytes: 100 });
        const h = fetchSpyHelia(
            new Map([
                ["peerA", recordOf(rootA)], // two peers agree on rootA...
                ["peerB", recordOf(rootA)],
                ["peerC", recordOf(rootB)], // ...one lone peer differs — still chased
                ["peerD", new Uint8Array([0xff])] // and one answers garbage — ignored
            ])
        );
        const voter = new PubsubVoter({ helia: h.helia, chains: fakeChains(), manifest: bizManifest() });
        await voter.start(); // start() joins the engine, which fires the cold-start pull
        const contest = await voter.createContest({ contestId: "biz" });

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

    it("retries a fetch reset by the shared node's inbound-stream cap, so the board still cold-joins instead of silently stranding", async () => {
        // A shared seeder over its per-protocol `maxInboundStreams` cap (libp2p's default is 32)
        // resets the fetch stream, which libp2p surfaces as a thrown error. Without a retry the reset
        // is swallowed and the board never pulls its checkpoint; with one it re-fetches and converges.
        // Here the FIRST attempt throws, the retry lands.
        const root = CID.parse("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4");
        const record = encodeRootRecord({ version: ROOT_RECORD_VERSION, root, chunks: [], count: 1, sizeBytes: 100 });
        let attempts = 0;
        const chased: string[] = [];
        const fetchService: FetchServiceLike = {
            fetch: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error("stream reset"); // TooManyInboundProtocolStreamsError on the seeder
                return record;
            },
            registerLookupFunction: () => {},
            unregisterLookupFunction: () => {}
        };
        const pubsub: PubsubService = {
            publish: async () => undefined,
            subscribe: () => {},
            unsubscribe: () => {},
            getSubscribers: () => [{ toString: () => "peerA" }] as unknown as ReturnType<PubsubService["getSubscribers"]>,
            addEventListener: () => {},
            removeEventListener: () => {},
            topicValidators: new Map()
        };
        const blockstore = {
            get: async (cid: CID) => {
                chased.push(cid.toString());
                throw new Error("no block"); // the chase attempt is what we assert
            },
            put: async (cid: CID) => cid,
            has: async () => false
        };
        const helia = { libp2p: { services: { pubsub, fetch: fetchService } }, blockstore } as unknown as HeliaInstance;
        const voter = new PubsubVoter({ helia, chains: fakeChains(), manifest: bizManifest() });
        await voter.start();
        await voter.createContest({ contestId: "biz" });

        // The retry re-fetches after the reset, so the record's root is still chased.
        await vi.waitFor(() => expect(chased).toContain(root.toString()), { timeout: 5000 });
        expect(attempts).toBeGreaterThanOrEqual(2);
        await voter.stop();
    });

    it("cold-joins via the HTTP content router even with NO topic subscribers: finds the provider of the criteria CID, dials it, fetches, and chases", async () => {
        // The pkc-js discovery path: gossipsub knows no subscribers yet, but the content router
        // names a provider of the criteria CID. The library must dial + fetch it immediately.
        const root = CID.parse("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4");
        const record = encodeRootRecord({ version: ROOT_RECORD_VERSION, root, chunks: [], count: 1, sizeBytes: 100 });
        const providerId = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
        const fetchCalls: Array<{ peer: string; key: string }> = [];
        const dialed: string[] = [];
        const chased: string[] = [];
        const fetchService: FetchServiceLike = {
            fetch: async (peer, key) => {
                fetchCalls.push({ peer: peer.toString(), key });
                return peer.toString() === providerId ? record : undefined;
            },
            registerLookupFunction: () => {},
            unregisterLookupFunction: () => {}
        };
        const pubsub: PubsubService = {
            publish: async () => undefined,
            subscribe: () => {},
            unsubscribe: () => {},
            getSubscribers: () => [], // NO subscribers — only the router can supply the provider
            addEventListener: () => {},
            removeEventListener: () => {},
            topicValidators: new Map()
        };
        const blockstore = {
            get: async (cid: CID) => {
                chased.push(cid.toString());
                throw new Error("no block"); // the chase attempt is what we assert
            },
            put: async (cid: CID) => cid,
            has: async () => false
        };
        const contentRouting = {
            findProviders: async function* () {
                yield { id: { toString: () => providerId }, multiaddrs: ["/ip4/127.0.0.1/tcp/1"] };
            }
        };
        const libp2p = {
            peerId: { toString: () => "self" },
            dial: async (addrs: unknown) => {
                dialed.push(String(addrs));
            },
            contentRouting,
            services: { pubsub, fetch: fetchService }
        };
        const helia = { libp2p, blockstore } as unknown as HeliaInstance;

        const voter = new PubsubVoter({ helia, chains: fakeChains(), manifest: bizManifest() });
        await voter.start();
        const contest = await voter.createContest({ contestId: "biz" });

        await vi.waitFor(() => {
            expect(dialed.length).toBeGreaterThan(0); // the discovered provider was dialed...
            expect(fetchCalls.some((c) => c.peer === providerId && c.key === rootFetchKey(contest.topic))).toBe(true); // ...and asked for its root
            expect(chased).toContain(root.toString()); // ...and its divergent root chased
        });
        await voter.stop();
    });
});
