import { describe, it, expect, vi, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
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
import type { ChainClient, ChainClientFactory, NameResolver } from "../chain/types.js";
import type { FetchServiceLike, HeliaInstance, PubsubService } from "../transport/types.js";
import {
    MissingBlockstoreError,
    MissingFetchError,
    MissingPubsubError,
    ReadOnlyError,
    UnknownRuleError,
    VoterDestroyedError
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

/**
 * A chain factory whose `readContract` (the gate's balance read) blocks until `release()`, so a
 * test can observe the provisional (chainVerified: false) window deterministically before the
 * background verifier settles it.
 */
function gatedChains(): { chains: ChainClientFactory; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = {
        getBlockNumber: async () => 43200n,
        getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
        readContract: async () => {
            await gate;
            return 1n;
        }
    };
    return { chains: () => client as unknown as ChainClient, release };
}

/**
 * A `.bso` resolver whose `resolve` blocks until `release()`, so a test can observe the
 * provisional (nameResolved: false) window deterministically before the background verifier
 * settles the name check.
 */
function gatedResolver(publicKey: string): { resolver: NameResolver; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return {
        resolver: {
            key: "gated",
            provider: "test",
            canResolve: ({ name }) => name.endsWith(".bso"),
            resolve: async () => {
                await gate;
                return { publicKey };
            }
        },
        release
    };
}

/**
 * A Helia node whose gossipsub `publish` is a spy, so a test can count broadcasts: every
 * publish/heartbeat calls `publishBundle`/`publishRootRecord` → `publish`. Otherwise a no-op node.
 */
function spyableHelia(): { helia: HeliaInstance; publish: ReturnType<typeof vi.fn> } {
    const publish = vi.fn(async () => ({ recipients: [{ toString: () => "recipient1" } as unknown as PeerId] }));
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
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        expect(voter.readOnly).toBe(true);
    });

    it("throws MissingPubsubError when the node's libp2p has no gossipsub service", () => {
        expect(
            () => new PubsubVoter({ dataPath: false, helia: fakeHeliaWithoutPubsub(), chains: fakeChains() })
        ).toThrow(MissingPubsubError);
    });

    it("throws MissingBlockstoreError when the node has no blockstore", () => {
        expect(
            () => new PubsubVoter({ dataPath: false, helia: fakeHeliaWithoutBlockstore(), chains: fakeChains() })
        ).toThrow(MissingBlockstoreError);
    });

    it("throws MissingFetchError when the node's libp2p has no fetch service", () => {
        expect(
            () => new PubsubVoter({ dataPath: false, helia: fakeHeliaWithoutFetch(), chains: fakeChains() })
        ).toThrow(MissingFetchError);
    });

    it("is writable with a signer", () => {
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: fakeChains(),
            signer: fakeSigner()
        });
        expect(voter.readOnly).toBe(false);
    });
});

describe("PubsubVoter.createContest", () => {
    it("derives the correct topic and criteria", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        expect(contest.topic).toBe(await topicFor(bizCriteria()));
        expect(contest.criteria.contestId).toBe("biz");
    });

    it("returns the stable per-contest object for byte-identical criteria", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const a = await voter.createContest({ criteria: bizCriteria() });
        const b = await voter.createContest({ criteria: bizCriteria() });
        expect(a).toBe(b);
    });

    it("forks byte-distinct criteria into distinct contests even under a shared contestId", async () => {
        // Engines are keyed by topic (the criteria bytes), not by contestId: two documents that
        // happen to share an id are different contests on different topics.
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const a = await voter.createContest({ criteria: bizCriteria() });
        const b = await voter.createContest({ criteria: { ...bizCriteria(), voteExpiryBuckets: 60 } });
        expect(a).not.toBe(b);
        expect(a.topic).not.toBe(b.topic);
        expect(b.criteria.contestId).toBe("biz");
    });

    it("rejects an invalid criteria document (strict schema at the create seam)", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const missingFields = { contestId: "x", name: "/x/" } as unknown as ReturnType<typeof bizCriteria>;
        await expect(voter.createContest({ criteria: missingFields })).rejects.toThrow();
        const unknownField = { ...bizCriteria(), extra: 1 } as unknown as ReturnType<typeof bizCriteria>;
        await expect(voter.createContest({ criteria: unknownField })).rejects.toThrow();
    });

    it("rejects a criteria naming a rule this client does not implement (recuse, not miscount)", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const foreignRule = { ...bizCriteria(), requires: { ...bizCriteria().requires, rules: ["not-a-rule"] } };
        await expect(voter.createContest({ criteria: foreignRule })).rejects.toThrow(UnknownRuleError);
    });
});

describe("createContestVote (publish path)", () => {
    it("rejects an invalid criteria document like createContest", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains(), signer: fakeSigner() });
        const missingFields = { contestId: "x", name: "/x/" } as unknown as ReturnType<typeof bizCriteria>;
        await expect(voter.createContestVote({ criteria: missingFields, votes: [] })).rejects.toThrow();
    });

    it("publish() throws ReadOnlyError (and emits error + failed state) without a signer", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const vote = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE });
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
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: stubChains(), signer: fakeSigner() });
        const vote = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE });
        const states: PublishingState[] = [];
        vote.on("publishingstatechange", (s) => states.push(s));
        expect(vote.publishingState).toBe("stopped");

        const { bundle, recipientCount } = await vote.publish();
        expect(states).toEqual(["signing", "publishing", "succeeded"]);
        expect(vote.publishingState).toBe("succeeded");
        expect(vote.bundle).toBe(bundle);
        expect(recipientCount).toBe(1); // gossipsub `recipients.length`, surfaced through the facade
        expect(bundle.address).toBe("0x0000000000000000000000000000000000000001");
        // blockNumber is the bucket boundary: bucketForBlock(43200)=1, sampleBlockForBucket(1)=43200.
        expect(bundle.blockNumber).toBe(43200);
        expect(bundle.votes[0].community.publicKey).toBe(VALID_KEY);
    });

    it("broadcasts the bundle once over the host node's gossipsub", async () => {
        const { helia, publish } = spyableHelia();
        const voter = new PubsubVoter({ dataPath: false, helia, chains: stubChains(), signer: fakeSigner() });
        const vote = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE });
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
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        expect(await contest.getTally()).toEqual({ contestId: "biz", ranking: [] });
    });

    it("reflects a published vote end-to-end (publish -> shared engine CRDT -> tally)", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: stubChains(), signer: fakeSigner() });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();

        const contest = await voter.createContest({ criteria: bizCriteria() });
        const tally = await contest.getTally();
        expect(tally.ranking).toHaveLength(1);
        expect(tally.ranking[0].community.publicKey).toBe(VALID_KEY);
        expect(tally.ranking[0].weight).toBe(1n); // constant weight, 1 pass = 1 vote
    });

    it("admits an own vote provisionally: chainVerified flips once the background gate read lands", async () => {
        const { chains, release } = gatedChains();
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains, signer: fakeSigner() });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contest = await voter.createContest({ criteria: bizCriteria() });

        // The vote counts immediately (render fast), but its gate read has not landed yet.
        const before = await contest.getTally();
        expect(before.ranking).toHaveLength(1);
        expect(before.ranking[0].chainVerified).toBe(false);

        release(); // the RPC answers — the background verifier settles the gate check
        await vi.waitFor(async () => expect((await contest.getTally()).ranking[0]?.chainVerified).toBe(true));
    });

    it("serves a later session's gate check from the persisted store: zero chain reads on restart", async () => {
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dataPath = mkdtempSync(join(tmpdir(), "pubsub-voting-voter-test-"));
        const countingChains = (): { chains: ChainClientFactory; gateReads: () => number } => {
            let gateReads = 0;
            const client = {
                getBlockNumber: async () => 43200n,
                getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
                readContract: async () => {
                    gateReads += 1;
                    return 1n;
                }
            };
            return { chains: () => client as unknown as ChainClient, gateReads: () => gateReads };
        };

        // Session 1: publish, let the background gate read settle (and persist), then destroy.
        const first = countingChains();
        const voterA = new PubsubVoter({ dataPath, helia: fakeHelia(), chains: first.chains, signer: fakeSigner() });
        await (await voterA.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contestA = await voterA.createContest({ criteria: bizCriteria() });
        await vi.waitFor(async () => expect((await contestA.getTally()).ranking[0]?.chainVerified).toBe(true));
        expect(first.gateReads()).toBe(1);
        await voterA.destroy();

        // Session 2 (a restart): same wallet, same bucket, same criteria — the gate score is a
        // pure function of pinned historical state, so it comes from the store, not the chain.
        const second = countingChains();
        const voterB = new PubsubVoter({ dataPath, helia: fakeHelia(), chains: second.chains, signer: fakeSigner() });
        await (await voterB.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contestB = await voterB.createContest({ criteria: bizCriteria() });
        await vi.waitFor(async () => expect((await contestB.getTally()).ranking[0]?.chainVerified).toBe(true));
        expect(second.gateReads()).toBe(0);
        await voterB.destroy();
    });

    it("re-purges persisted gate results when the expiry horizon advances past the last purge", async () => {
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { makeStorage } = await import("../storage/node.js");
        const dataPath = mkdtempSync(join(tmpdir(), "pubsub-voting-voter-test-"));

        // Head starts at bucket 40, so the first head read already purges (boundary: bucket 10).
        let block = 43200n * 40n;
        const voter = new PubsubVoter({ dataPath, helia: fakeHelia(), chains: advancingChains(() => block), signer: fakeSigner() });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await vi.waitFor(async () => expect((await contest.getTally()).ranking[0]?.chainVerified).toBe(true));

        // The settled gate read persisted a score keyed to bucket 40's sample block (WAL mode
        // admits this second read-only connection alongside the voter's own).
        const reader = makeStorage({ dataPath }).openLru({ cacheName: "gate-results", maxItems: 50_000 });
        const bucket40Key = (keys: string[]) => keys.find((k) => k.endsWith(`:${43200 * 40}`));
        await vi.waitFor(async () => expect(bucket40Key(await reader.keys())).toBeDefined());

        // The head advances to bucket 71: bucket 40 falls out of the 30-bucket expiry window,
        // so the head read piggybacked on this tally must purge again — not only once per
        // engine lifetime — and drop the now-dead entry.
        block = 43200n * 71n;
        await contest.getTally();
        await vi.waitFor(async () => expect(bucket40Key(await reader.keys())).toBeUndefined());
        await voter.destroy();
    });

    it("emits an update event when a row's chainVerified flips after the background gate read lands", async () => {
        const { chains, release } = gatedChains();
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains, signer: fakeSigner() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        // Record the row's flag at every update emit: the flip must arrive AS AN EVENT, not
        // only via a forced getTally().
        const flags: Array<boolean | undefined> = [];
        contest.on("update", () => flags.push(contest.tally?.ranking[0]?.chainVerified));
        await contest.update();

        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        await vi.waitFor(() => expect(flags).toContain(false)); // the provisional render emitted

        release(); // the gate read lands in the background
        await vi.waitFor(() => expect(flags).toContain(true)); // the settlement re-emitted update
        expect(contest.tally?.ranking[0]?.chainVerified).toBe(true);
        await contest.stop();
    });

    it("emits an update event when a row's nameResolved flips after the background resolution lands", async () => {
        const { resolver, release } = gatedResolver(VALID_KEY);
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: stubChains(), // instant gate — isolates the name check as the pending stage
            signer: fakeSigner(),
            nameResolvers: [resolver]
        });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const flags: Array<boolean | undefined> = [];
        contest.on("update", () => flags.push(contest.tally?.ranking[0]?.nameResolved));
        await contest.update();

        const named = [{ community: { name: "memes.bso", publicKey: VALID_KEY }, vote: 1 }];
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: named })).publish();
        await vi.waitFor(() => expect(flags).toContain(false)); // name still pending at render

        release(); // the resolution lands in the background
        await vi.waitFor(() => expect(flags).toContain(true));
        expect(contest.tally?.ranking[0]?.community.name).toBe("memes.bso");
        expect(contest.tally?.ranking[0]?.nameResolved).toBe(true);
        await contest.stop();
    });

    it("evicts an own vote whose wallet fails the gate (score 0n), recounting the tally", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: stubChains({ balance: 0n }), signer: fakeSigner() });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contest = await voter.createContest({ criteria: bizCriteria() });
        // The local tally converges to the network's view: an ineligible vote does not stick.
        await vi.waitFor(async () => expect((await contest.getTally()).ranking).toEqual([]));
    });

    it("serves only verified bundles in its checkpoint (a pending own vote is withheld)", async () => {
        const { chains, release } = gatedChains();
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains, signer: fakeSigner() });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contest = (await voter.createContest({ criteria: bizCriteria() })) as unknown as {
            rootRecord(): Promise<{ count: number }>;
        };

        expect((await contest.rootRecord()).count).toBe(0); // pending — never re-served
        release();
        await vi.waitFor(async () => expect((await contest.rootRecord()).count).toBe(1));
    });

    it("surfaces a background infra failure through the contest error event; the vote stays pending", async () => {
        const client = {
            getBlockNumber: async () => 43200n,
            getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
            readContract: async () => {
                throw new Error("RPC down");
            }
        };
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: () => client as unknown as ChainClient,
            signer: fakeSigner()
        });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const errors: unknown[] = [];
        contest.on("error", (e) => errors.push(e));
        await contest.update();

        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
        // Infra is nobody's verdict: not evicted, still counted, flagged unverified.
        const tally = await contest.getTally();
        expect(tally.ranking).toHaveLength(1);
        expect(tally.ranking[0].chainVerified).toBe(false);
        await voter.stop(); // clears the background retry timer with the topic leave
    });

    it("update() emits an initial update and a fresh tally when a later vote is published", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: stubChains(), signer: fakeSigner() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        let updates = 0;
        contest.on("update", () => {
            updates += 1;
        });
        await contest.update();
        expect(updates).toBe(1); // initial update fires with the current (empty) state
        expect(contest.tally).toEqual({ contestId: "biz", ranking: [] });

        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        await vi.waitFor(() => expect(contest.tally?.ranking).toHaveLength(1));
        expect(updates).toBeGreaterThanOrEqual(2); // the publish triggered a recompute + emit
        expect(contest.tally?.ranking[0].community.publicKey).toBe(VALID_KEY);
        await contest.stop();
    });

    it("drops a vote from the tally once it decays past its expiry window", async () => {
        // bizCriteria: voteExpiryBuckets 30, blocksPerBucket 43200. Publish at bucket 1; a vote
        // there expires once the current bucket exceeds 1 + 30 = 31.
        let block = 43200n; // bucket 1
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: advancingChains(() => block),
            signer: fakeSigner()
        });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contest = await voter.createContest({ criteria: bizCriteria() });

        // Still live at bucket 1: the vote counts.
        expect((await contest.getTally()).ranking).toHaveLength(1);

        // Advance well past the expiry window (bucket 32 > 31): the decayed vote is gone.
        block = 32n * 43200n;
        expect((await contest.getTally()).ranking).toEqual([]);
    });
});

describe("Contest lifecycle", () => {
    it("update() and stop() resolve, wiring the real forward-gate over the host node", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
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
    it("destroy() is a safe teardown, even before any join", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        await expect(voter.destroy()).resolves.toBeUndefined();
    });

    it("stop() leaves topics and stays reusable", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        await voter.createContest({ criteria: bizCriteria() });
        await expect(voter.stop()).resolves.toBeUndefined();
    });

    it("stop() lets a pre-existing contest update() again (client stays reusable)", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        let updates = 0;
        contest.on("update", () => {
            updates += 1;
        });
        await contest.update();
        expect(updates).toBe(1);

        await voter.stop();
        // Reusable: the same contest object re-joins and re-emits its initial tally after stop().
        await expect(contest.update()).resolves.toBeUndefined();
        expect(updates).toBe(2);
        expect(contest.tally).toEqual({ contestId: "biz", ranking: [] });
        await voter.stop();
    });

    it("destroy() is terminal: create paths reject afterward", async () => {
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: fakeChains(),
            signer: fakeSigner()
        });
        await voter.destroy();
        await expect(voter.createContest({ criteria: bizCriteria() })).rejects.toThrow(VoterDestroyedError);
        await expect(voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).rejects.toThrow(VoterDestroyedError);
    });

    it("destroy() stops pre-existing contests and forbids re-update / re-publish", async () => {
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: fakeChains(),
            signer: fakeSigner()
        });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const vote = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE });
        await contest.update(); // live before teardown
        await voter.destroy();

        // A contest obtained before destroy can no longer update.
        await expect(contest.update()).rejects.toThrow(VoterDestroyedError);

        // A ballot obtained before destroy can no longer publish: it emits `error` and ends failed.
        let errored: unknown;
        vote.on("error", (error) => {
            errored = error;
        });
        await expect(vote.publish()).rejects.toThrow(VoterDestroyedError);
        expect(errored).toBeInstanceOf(VoterDestroyedError);
        expect(vote.publishingState).toBe("failed");
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
        const voter = new PubsubVoter({ dataPath: false,
            helia,
            chains: advancingChains(() => block),
            signer: fakeSigner()
        });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        // `rootRecord`/`latestCheckpointRoot` are internal hooks on the view (see voter.ts), not part
        // of the public Contest interface; reach them structurally in the test.
        const ck = contest as unknown as {
            rootRecord(): Promise<RootRecord>;
            latestCheckpointRoot(): CID | undefined;
        };
        expect(ck.latestCheckpointRoot()).toBeUndefined(); // nothing encoded yet

        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish(); // state at bucket 1
        // The checkpoint serves only settled bundles; the own vote's deferred checks land in the
        // background, so wait for the settlement before asserting the encoded count.
        await vi.waitFor(async () => expect((await ck.rootRecord()).count).toBe(1));
        const record = await ck.rootRecord();
        expect(record.count).toBe(1);
        expect(puts.has(record.root.toString())).toBe(true); // blocks written for directed bitswap
        expect(ck.latestCheckpointRoot()?.equals(record.root)).toBe(true);

        // Cached: an unchanged winner-set returns the same record without a re-encode.
        expect(await ck.rootRecord()).toBe(record);

        // A state change (re-publishing at a later bucket supersedes under LWW) invalidates the
        // cache. Until the new bundle's deferred checks settle, the checkpoint keeps serving the
        // superseded VERIFIED bundle (the provisional-winner fallback), so wait for settlement.
        block = bucketBlock(20);
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        await vi.waitFor(async () => expect((await ck.rootRecord()).root.equals(record.root)).toBe(false));
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
        const voter = new PubsubVoter({ dataPath: false, helia, chains: advancingChains(() => bucketBlock(1)) });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update(); // joins the topic: installs the gate and arms the heartbeat
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

    it("destroy() disarms the heartbeat (all contests stopped)", async () => {
        const h = await heartbeatHarness();
        await vi.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(rootPublishes(h.publish)).toBe(1);
        await h.voter.destroy();
        // Terminal teardown clears the timer just like stop(): no further heartbeats.
        await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
        expect(rootPublishes(h.publish)).toBe(1);
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
        const counts = { register: 0, unregister: 0 };
        const fetchService: FetchServiceLike = {
            fetch: async (peer, key) => {
                fetchCalls.push({ peer: peer.toString(), key });
                return peerAnswers.get(peer.toString());
            },
            registerLookupFunction: (prefix, lookup) => {
                counts.register += 1;
                lookups.set(prefix, lookup);
            },
            unregisterLookupFunction: (prefix) => {
                counts.unregister += 1;
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
        return { helia, lookups, fetchCalls, chased, counts };
    }

    it("registers a responder that answers <topic>/root with the on-demand record, and unregisters on stop", async () => {
        const h = fetchSpyHelia(new Map());
        const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update(); // the join registers the responder (lazy lifecycle)
        const lookup = h.lookups.get(TOPIC_PREFIX);
        expect(lookup).toBeDefined();

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

    it("answers nothing for a contest that was created but never joined (serves exactly the topics it participates in)", async () => {
        const h = fetchSpyHelia(new Map());
        const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: fakeChains() });
        const joined = await voter.createContest({ criteria: bizCriteria() });
        await joined.update(); // registers the responder

        // A ballot for a second contest builds its engine, but publish() never runs — so this
        // node never joins that topic and holds no view of that contest.
        const bystander = { ...bizCriteria(), contestId: "pol" };
        await voter.createContestVote({ criteria: bystander, votes: [] });

        const asKey = (s: string): Uint8Array => new TextEncoder().encode(s);
        const lookup = h.lookups.get(TOPIC_PREFIX);
        expect(lookup).toBeDefined();
        expect(await lookup!(asKey(rootFetchKey(joined.topic)))).toBeDefined();
        // The never-joined engine must answer "no record", not an empty checkpoint that
        // masquerades as this node's view of a contest it does not participate in.
        expect(await lookup!(asKey(rootFetchKey(await topicFor(bystander))))).toBeUndefined();
        await voter.stop();
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
        const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update(); // the join fires the cold-start pull

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
        const voter = new PubsubVoter({ dataPath: false, helia, chains: fakeChains() });
        await (await voter.createContest({ criteria: bizCriteria() })).update();

        // The retry re-fetches after the reset, so the record's root is still chased.
        await vi.waitFor(() => expect(chased).toContain(root.toString()), { timeout: 5000 });
        expect(attempts).toBeGreaterThanOrEqual(2);
        await voter.stop();
    });

    it("budgets concurrent cold-start fetches per peer across ALL contests, so a directory-wide join never trips a peer's inbound-stream cap by itself", async () => {
        // 40 contests on one voter all cold-start against the SAME peer. Without a voter-wide
        // budget that opens 40 concurrent fetch streams — past libp2p's default 32-inbound cap on
        // the responder, which would reset the excess (the failure the retry rides out). The
        // budget must instead hold at most 24 in flight and queue the rest.
        const CONTESTS = 40;
        const BUDGET = 24; // COLD_START_PEER_FETCH_LIMIT
        let inFlight = 0;
        let peak = 0;
        const pending: Array<() => void> = [];
        const fetchService: FetchServiceLike = {
            fetch: async () => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise<void>((resolve) => pending.push(resolve));
                inFlight -= 1;
                return undefined; // definitive "no record" — no retry, no chase
            },
            registerLookupFunction: () => {},
            unregisterLookupFunction: () => {}
        };
        const pubsub: PubsubService = {
            publish: async () => undefined,
            subscribe: () => {},
            unsubscribe: () => {},
            getSubscribers: () => [{ toString: () => "seeder" }] as unknown as ReturnType<PubsubService["getSubscribers"]>,
            addEventListener: () => {},
            removeEventListener: () => {},
            topicValidators: new Map()
        };
        const blockstore = { get: async () => new Uint8Array(), put: async (cid: unknown) => cid, has: async () => false };
        const helia = { libp2p: { services: { pubsub, fetch: fetchService } }, blockstore } as unknown as HeliaInstance;
        const voter = new PubsubVoter({ dataPath: false, helia, chains: fakeChains() });

        const contests = await Promise.all(
            Array.from({ length: CONTESTS }, (_, i) => voter.createContest({ criteria: { ...bizCriteria(), contestId: `c${i}` } }))
        );
        await Promise.all(contests.map((contest) => contest.update())); // joins fire-and-forget the cold-start pulls

        // Demand (40) exceeds the budget (24): the budget saturates at exactly 24 in flight...
        await vi.waitFor(() => expect(pending.length).toBe(BUDGET));
        expect(peak).toBe(BUDGET);
        // ...and releasing slots drains the queue — every contest gets served, still never above budget.
        let released = 0;
        while (released < CONTESTS) {
            await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
            while (pending.length > 0) {
                pending.shift()!();
                released += 1;
            }
        }
        await vi.waitFor(() => expect(inFlight).toBe(0));
        expect(released).toBe(CONTESTS);
        expect(peak).toBe(BUDGET);
        await voter.stop();
    });

    it("randomizes which subscribers a cold start asks, so a directory join spreads across serving peers instead of always the first listed", async () => {
        // 8 subscribers, 12 contests: a deterministic slice would send every contest to the same
        // first 4 peers (funnelling the whole directory through their stream caps while the other
        // 4 idle). With the shuffle, the odds that 12 independent picks all land on one fixed
        // 4-subset are (1/70)^11 — so seeing a 5th peer is a safe assertion.
        const root = CID.parse("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4");
        const record = encodeRootRecord({ version: ROOT_RECORD_VERSION, root, chunks: [], count: 1, sizeBytes: 100 });
        const h = fetchSpyHelia(new Map(Array.from({ length: 8 }, (_, i) => [`peer${i}`, record])));
        const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: fakeChains() });
        const contests = await Promise.all(
            Array.from({ length: 12 }, (_, i) => voter.createContest({ criteria: { ...bizCriteria(), contestId: `c${i}` } }))
        );
        await Promise.all(contests.map((contest) => contest.update()));

        await vi.waitFor(() => expect(h.fetchCalls.length).toBe(12 * 4)); // each contest still asks COLD_START_PEERS peers
        expect(new Set(h.fetchCalls.map((call) => call.peer)).size).toBeGreaterThan(4);
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

        const voter = new PubsubVoter({ dataPath: false, helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update(); // the join fires the cold-start pull

        await vi.waitFor(() => {
            expect(dialed.length).toBeGreaterThan(0); // the discovered provider was dialed...
            expect(fetchCalls.some((c) => c.peer === providerId && c.key === rootFetchKey(contest.topic))).toBe(true); // ...and asked for its root
            expect(chased).toContain(root.toString()); // ...and its divergent root chased
        });
        await voter.stop();
    });

    describe("lazy responder registration (no public start(): the join/leave transitions drive it)", () => {
        it("registers on the first joined topic, stays while any topic is joined, unregisters on the last leave, and re-registers on re-join", async () => {
            const h = fetchSpyHelia(new Map());
            const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: fakeChains() });
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(false); // construction registers nothing

            const a = await voter.createContest({ criteria: bizCriteria() });
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(false); // creating a contest is still lazy

            await a.update(); // the first real join registers the responder
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(true);
            expect(h.counts.register).toBe(1);

            const b = await voter.createContest({ criteria: { ...bizCriteria(), contestId: "g", name: "/g/" } });
            await b.update(); // a second joined topic reuses the one registration
            expect(h.counts.register).toBe(1);

            await a.stop(); // one topic still joined: the responder stays
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(true);

            await b.stop(); // the last leave unregisters
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(false);
            expect(h.counts.unregister).toBe(1);

            await a.update(); // the voter stays reusable: a re-join re-registers
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(true);
            expect(h.counts.register).toBe(2);
            await voter.stop();
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(false);
        });

        it("publishing a ballot also joins, so a write-only client serves root records too", async () => {
            const h = fetchSpyHelia(new Map());
            const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: stubChains(), signer: fakeSigner() });
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(false);
            await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(true);
            await voter.stop();
            expect(h.lookups.has(TOPIC_PREFIX)).toBe(false);
        });
    });
});

describe("provider-record announcer (httpRouterUrls)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    /** The announcer's change-coalescing window (ANNOUNCE_DEBOUNCE_MS in transport/announce/node.ts). */
    const DEBOUNCE_MS = 10_000;
    const PUBLIC_ADDR = "/ip4/203.0.113.5/tcp/4001";

    /**
     * A fake Helia whose libp2p also carries the announcer's surface (peer id, addresses,
     * `self:peer:update` events), with the global `fetch` stubbed so announces are recorded
     * instead of hitting the network (stubChains never reads over HTTP, so nothing else fetches).
     */
    function announcerHarness() {
        vi.useFakeTimers();
        const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }));
        vi.stubGlobal("fetch", fetchSpy);
        const pubsub = {
            publish: async () => ({ recipients: [{ toString: () => "recipient1" } as unknown as PeerId] }),
            subscribe: () => {},
            unsubscribe: () => {},
            getSubscribers: () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
            topicValidators: new Map()
        } satisfies PubsubService;
        const blockstore = { get: async () => new Uint8Array(), put: async (cid: unknown) => cid, has: async () => false };
        const helia = {
            libp2p: {
                services: { pubsub, fetch: fakeFetchService() },
                peerId: { toString: () => "12D3KooWSeeder" },
                getMultiaddrs: () => [PUBLIC_ADDR, "/ip4/127.0.0.1/tcp/4001"].map((a) => ({ toString: () => a })),
                addEventListener: () => {},
                removeEventListener: () => {}
            },
            blockstore
        } as unknown as HeliaInstance;
        /** The JSON bodies fetch received, parsed. */
        const bodies = () =>
            fetchSpy.mock.calls.map((call) => {
                const [url, init] = call as unknown as [string, { method: string; body: string }];
                return { url, method: init.method, body: JSON.parse(init.body) as { Providers: Array<{ Payload: { ID: string; Addrs: string[]; Keys: string[] } }> } };
            });
        return { helia, fetchSpy, bodies };
    }

    it("announces every joined contest's criteria + root CIDs in one batched PUT per router", async () => {
        const h = announcerHarness();
        const voter = new PubsubVoter({
            dataPath: false,
            helia: h.helia,
            chains: stubChains(),
            httpRouterUrls: ["http://router-a.example/", "http://router-b.example"]
        });
        const a = await voter.createContest({ criteria: bizCriteria() });
        const b = await voter.createContest({ criteria: { ...bizCriteria(), contestId: "g", name: "/g/" } });
        await a.update();
        await b.update();
        expect(h.fetchSpy).not.toHaveBeenCalled(); // debounced: nothing goes out at join time
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(h.fetchSpy).toHaveBeenCalledTimes(2); // one PUT per router, both contests batched

        const rootA = (await (a as unknown as { rootRecord(): Promise<RootRecord> }).rootRecord()).root.toString();
        const criteriaCidOf = (topic: string) => topic.slice(TOPIC_PREFIX.length);
        for (const put of h.bodies()) {
            expect(put.url).toMatch(/^http:\/\/router-[ab]\.example\/routing\/v1\/providers$/);
            expect(put.method).toBe("PUT");
            const { ID, Addrs, Keys } = put.body.Providers[0]!.Payload;
            expect(ID).toBe("12D3KooWSeeder");
            expect(Addrs).toEqual([PUBLIC_ADDR]); // loopback filtered client-side
            // Both criteria CIDs plus the (shared, deduped) empty-checkpoint root.
            expect(Keys).toEqual(expect.arrayContaining([criteriaCidOf(a.topic), criteriaCidOf(b.topic), rootA]));
            expect(Keys).toHaveLength(3);
        }
        await voter.stop();
    });

    it("a local publish (checkpoint change) triggers a debounced re-announce", async () => {
        const h = announcerHarness();
        const voter = new PubsubVoter({
            dataPath: false,
            helia: h.helia,
            chains: stubChains(),
            signer: fakeSigner(),
            httpRouterUrls: ["http://router.example"]
        });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(h.fetchSpy).toHaveBeenCalledTimes(1);

        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        // The publish (and its background settlement) re-announced at least once more.
        expect(h.fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        await voter.stop();
    });

    it("stop() stops announcing (no periodic re-announce after the last topic leaves)", async () => {
        const h = announcerHarness();
        const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: stubChains(), httpRouterUrls: ["http://router.example"] });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(h.fetchSpy).toHaveBeenCalledTimes(1);
        await voter.stop();
        await vi.advanceTimersByTimeAsync(2 * 3_600_000); // two hourly ticks would have fired
        expect(h.fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("no httpRouterUrls (or an empty list) never announces", async () => {
        const h = announcerHarness();
        const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: stubChains(), httpRouterUrls: [] });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        await vi.advanceTimersByTimeAsync(2 * 3_600_000);
        expect(h.fetchSpy).not.toHaveBeenCalled();
        await voter.stop();
    });
});
