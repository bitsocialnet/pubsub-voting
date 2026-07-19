import { describe, it, expect, vi, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";
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
    InvalidCommunityNameError,
    MissingBlockstoreError,
    MissingChainClientError,
    MissingFetchError,
    MissingPubsubError,
    ReadOnlyError,
    UnknownRuleError,
    VoteEvictedError,
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
    fakeSigner,
    realSigner
} from "../test-fixtures.js";

/** A valid base58btc IPNS community key (VotesBundleSchema rejects non-keys, so a real one is needed). */
const VALID_KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
/** A different key, for name resolutions that must NOT match the claimed `publicKey`. */
const OTHER_KEY = "12D3KooWQYV9dGMFoRzNStwpXztXaBUjtPqi6aU76ZgUriHhKust";
/** A one-community upvote used across the publish tests. */
const VOTE = [{ community: { publicKey: VALID_KEY }, vote: 1 }];
/** The same upvote carrying a resolvable community name (exercises the name pipeline). */
const NAMED_VOTE = [{ community: { name: "memes.bso", publicKey: VALID_KEY }, vote: 1 }];

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
 * A `.bso` resolver whose FIRST `resolve` throws (the publish-time preflight's call — a
 * transient outage, so the publish proceeds with the name check deferred) and whose later
 * calls block until `release()`, so a test can observe the provisional (nameResolved: false)
 * window deterministically before the background verifier settles the name check.
 */
function gatedResolver(publicKey: string): { resolver: NameResolver; release: () => void } {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return {
        resolver: {
            key: "gated",
            provider: "test",
            canResolve: ({ name }) => name.endsWith(".bso"),
            resolve: async () => {
                calls += 1;
                if (calls === 1) throw new Error("registry briefly down"); // fails the preflight open
                await gate;
                return { publicKey };
            }
        },
        release
    };
}

/** A `.bso` resolver that instantly resolves every name to `publicKey` (or to no record). */
function instantResolver(publicKey: string | undefined): NameResolver {
    return {
        key: "instant",
        provider: "test",
        canResolve: ({ name }) => name.endsWith(".bso"),
        resolve: async () => (publicKey === undefined ? undefined : { publicKey })
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

/**
 * A Helia node whose gossipsub records `subscription-change` listeners (dispatchable by the
 * test) and whose fetch service logs each pulled peer — the seams the cold-start re-pull
 * (issue #15) rides. `fetch` answers a definitive "no record" (undefined), so a pull completes
 * without retries and without needing a decodable root record.
 */
function subscribableHelia(): {
    helia: HeliaInstance;
    fetchedPeers: string[];
    listenerCount: () => number;
    dispatch: (peerId: string, topic: string, subscribe?: boolean) => void;
} {
    type Listener = (evt: { detail: { peerId: PeerId; subscriptions: Array<{ topic: string; subscribe: boolean }> } }) => void;
    const listeners = new Set<Listener>();
    const fetchedPeers: string[] = [];
    const pubsub = {
        publish: async () => ({ recipients: [] as PeerId[] }),
        subscribe: () => {},
        unsubscribe: () => {},
        getSubscribers: () => [],
        addEventListener: (type: string, listener: unknown) => {
            if (type === "subscription-change") listeners.add(listener as Listener);
        },
        removeEventListener: (type: string, listener: unknown) => {
            listeners.delete(listener as Listener);
        },
        topicValidators: new Map()
    } as unknown as PubsubService;
    const fetch = {
        fetch: async (peer: PeerId) => {
            fetchedPeers.push(peer.toString());
            return undefined; // definitive "no record" — no retry, nothing to decode
        },
        registerLookupFunction: () => {},
        unregisterLookupFunction: () => {}
    };
    const blockstore = { get: async () => new Uint8Array(), put: async (cid: unknown) => cid, has: async () => false };
    const helia = { libp2p: { services: { pubsub, fetch } }, blockstore } as unknown as HeliaInstance;
    return {
        helia,
        fetchedPeers,
        listenerCount: () => listeners.size,
        dispatch: (peerId, topic, subscribe = true) => {
            for (const listener of [...listeners]) {
                listener({ detail: { peerId: { toString: () => peerId } as unknown as PeerId, subscriptions: [{ topic, subscribe }] } });
            }
        }
    };
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

    it("rejects a criteria requiring a chain the host's factory cannot resolve (recuse, not miscount)", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: () => undefined });
        await expect(voter.createContest({ criteria: bizCriteria() })).rejects.toThrow(MissingChainClientError);
        await expect(voter.createContest({ criteria: bizCriteria() })).rejects.toThrow(/chainId 8453/);
    });

    it("rejects a pre-v1 criteria still carrying rpcUrls (loud error, never a silent re-topic)", async () => {
        // RPC endpoints are client settings now; a stripping schema would silently derive a
        // DIFFERENT topic from such a document, so the strict schema must fail it instead.
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains() });
        const criteria = bizCriteria();
        const withRpcUrls = {
            ...criteria,
            requires: { ...criteria.requires, chains: { base: { chainId: 8453, rpcUrls: ["https://mainnet.base.org"] } } }
        } as unknown as ReturnType<typeof bizCriteria>;
        await expect(voter.createContest({ criteria: withRpcUrls })).rejects.toThrow();
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

        // The preflight's resolve throws (gatedResolver call 1): a registry outage never blocks
        // the publish — the name check stays deferred to the background verifier.
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: NAMED_VOTE })).publish();
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

    it("publish() rejects InvalidCommunityNameError when the carried name resolves to a different key", async () => {
        const { helia, publish } = spyableHelia();
        const voter = new PubsubVoter({ dataPath: false,
            helia,
            chains: stubChains(),
            signer: fakeSigner(),
            nameResolvers: [instantResolver(OTHER_KEY)] // the registry says the name is someone else's
        });
        const vote = await voter.createContestVote({ criteria: bizCriteria(), votes: NAMED_VOTE });
        const states: PublishingState[] = [];
        const errors: unknown[] = [];
        vote.on("publishingstatechange", (s) => states.push(s));
        vote.on("error", (e) => errors.push(e));

        await expect(vote.publish()).rejects.toBeInstanceOf(InvalidCommunityNameError);
        expect(states).toEqual(["failed"]); // refused before signing — no signing/publishing walk
        const error = errors[0] as InvalidCommunityNameError;
        expect(error.communityName).toBe("memes.bso");
        expect(error.claimedPublicKey).toBe(VALID_KEY);
        expect(error.resolvedPublicKey).toBe(OTHER_KEY);
        expect(publish).not.toHaveBeenCalled(); // nothing hit the wire
        // ...and nothing was admitted locally either.
        const contest = await voter.createContest({ criteria: bizCriteria() });
        expect((await contest.getTally()).ranking).toEqual([]);
    });

    it("publish() rejects when the carried name has no record, or no resolver handles it", async () => {
        const noRecord = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: stubChains(),
            signer: fakeSigner(),
            nameResolvers: [instantResolver(undefined)]
        });
        await expect((await noRecord.createContestVote({ criteria: bizCriteria(), votes: NAMED_VOTE })).publish()).rejects.toThrow(
            /does not resolve/
        );

        const noResolver = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: stubChains(), signer: fakeSigner() });
        await expect((await noResolver.createContestVote({ criteria: bizCriteria(), votes: NAMED_VOTE })).publish()).rejects.toThrow(
            /no resolver handles/
        );
    });

    it("records a preflight-resolved name as settled: no pending nameResolved flash on the own row", async () => {
        const { chains, release } = gatedChains(); // the gate read is what stays pending
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains,
            signer: fakeSigner(),
            nameResolvers: [instantResolver(VALID_KEY)]
        });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: NAMED_VOTE })).publish();

        // The preflight resolved the name before signing, so the very first rendered row is
        // already nameResolved — only the deferred gate read is still owed.
        const tally = await contest.getTally();
        expect(tally.ranking[0]?.nameResolved).toBe(true);
        expect(tally.ranking[0]?.chainVerified).toBe(false);
        release();
        await vi.waitFor(async () => expect((await contest.getTally()).ranking[0]?.chainVerified).toBe(true));
    });

    it("surfaces VoteEvictedError on the vote AND the contest when the gate evicts an own publish", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: stubChains({ balance: 0n }), signer: fakeSigner() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const contestErrors: unknown[] = [];
        contest.on("error", (e) => contestErrors.push(e));
        await contest.update();

        const vote = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE });
        const voteErrors: unknown[] = [];
        vote.on("error", (e) => voteErrors.push(e));
        await vote.publish(); // resolves on the offline checks; the gate read lands in the background

        await vi.waitFor(() => expect(voteErrors.length).toBeGreaterThan(0));
        const error = voteErrors[0] as VoteEvictedError;
        expect(error).toBeInstanceOf(VoteEvictedError);
        expect(error.verdict.reason).toContain("rule score is 0n");
        expect(error.bundle).toBe(vote.bundle); // names the exact publish that was evicted
        expect(vote.publishingState).toBe("failed"); // flipped post hoc
        // The same error reaches a long-lived contest view, and the tally recounted without it.
        await vi.waitFor(() => expect(contestErrors.some((e) => e instanceof VoteEvictedError)).toBe(true));
        expect((await contest.getTally()).ranking).toEqual([]);
        await contest.stop();
    });

    it("publishes through a resolver outage, then surfaces VoteEvictedError when the name turns out mismatched", async () => {
        let calls = 0;
        const resolver: NameResolver = {
            key: "flaky",
            provider: "test",
            canResolve: ({ name }) => name.endsWith(".bso"),
            resolve: async () => {
                calls += 1;
                if (calls === 1) throw new Error("registry down"); // the preflight's call
                return { publicKey: OTHER_KEY }; // the background verifier's call: a mismatch
            }
        };
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: stubChains(),
            signer: fakeSigner(),
            nameResolvers: [resolver]
        });
        const vote = await voter.createContestVote({ criteria: bizCriteria(), votes: NAMED_VOTE });
        const voteErrors: unknown[] = [];
        vote.on("error", (e) => voteErrors.push(e));
        await vote.publish(); // the outage fails open — publishing is never blocked on the registry

        await vi.waitFor(() => expect(voteErrors.some((e) => e instanceof VoteEvictedError)).toBe(true));
        const error = voteErrors.find((e) => e instanceof VoteEvictedError) as VoteEvictedError;
        expect(error.verdict.reason).toContain(`resolves to ${OTHER_KEY}`);
        expect(vote.publishingState).toBe("failed");
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

describe("cold-start re-pull on subscription-change (issue #15)", () => {
    it("pulls a peer whose subscription appears after join (the join-races-subscription-gossip gap)", async () => {
        const node = subscribableHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update(); // zero subscribers at the join snapshot — nothing pulled yet
        expect(node.fetchedPeers).toEqual([]);

        node.dispatch("peer-late", contest.topic);
        await vi.waitFor(() => expect(node.fetchedPeers).toEqual(["peer-late"]));
        await voter.destroy();
    });

    it("asks each peer at most once (the pull's seen-set dedups re-announcements)", async () => {
        const node = subscribableHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();

        node.dispatch("peer-a", contest.topic);
        node.dispatch("peer-a", contest.topic);
        node.dispatch("peer-b", contest.topic);
        await vi.waitFor(() => expect(node.fetchedPeers.sort()).toEqual(["peer-a", "peer-b"]));
        await voter.destroy();
    });

    it("ignores other topics and unsubscribes", async () => {
        const node = subscribableHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();

        node.dispatch("peer-x", "some/other-topic");
        node.dispatch("peer-y", contest.topic, false); // an UNsubscribe is not a pull target
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(node.fetchedPeers).toEqual([]);
        await voter.destroy();
    });

    it("disarms the listener on stop() and re-arms on the next update()", async () => {
        const node = subscribableHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        expect(node.listenerCount()).toBe(1);

        await contest.stop();
        expect(node.listenerCount()).toBe(0);
        node.dispatch("peer-after-stop", contest.topic);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(node.fetchedPeers).toEqual([]);

        await contest.update(); // a re-join arms a fresh window (no stacked listeners)
        expect(node.listenerCount()).toBe(1);
        await voter.destroy();
        expect(node.listenerCount()).toBe(0);
    });
});

describe("checkpoint snapshot persistence (dataPath)", () => {
    const tempDataPath = async (): Promise<string> => {
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        return mkdtempSync(join(tmpdir(), "pubsub-voting-voter-test-"));
    };
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

    it("restores the persisted checkpoint at join: a seeder restart with no other peer online keeps the tally (issue #14)", async () => {
        const dataPath = await tempDataPath();
        const signer = realSigner(); // the restore re-runs verifyOffline, so the signature must recover

        // Session 1: publish, let the background gate read settle, then destroy — the leave()
        // flush persists the snapshot (the debounced timer has not fired yet).
        const first = countingChains();
        const voterA = new PubsubVoter({ dataPath, helia: fakeHelia(), chains: first.chains, signer });
        await (await voterA.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contestA = await voterA.createContest({ criteria: bizCriteria() });
        await vi.waitFor(async () => expect((await contestA.getTally()).ranking[0]?.chainVerified).toBe(true));
        await voterA.destroy();

        // Session 2 (the incident's restart): a FRESH Helia node — empty blockstore, zero topic
        // subscribers, no providers — so only the persisted snapshot can populate the tally.
        const second = countingChains();
        const voterB = new PubsubVoter({ dataPath, helia: fakeHelia(), chains: second.chains, signer });
        const contestB = await voterB.createContest({ criteria: bizCriteria() });
        await contestB.update();
        // The restored state is already in the initial tally (provisional, then re-verified in
        // the background from the persisted gate cache — zero chain reads).
        expect(contestB.tally?.ranking[0]?.community.publicKey).toBe(VALID_KEY);
        await vi.waitFor(() => expect(contestB.tally?.ranking[0]?.chainVerified).toBe(true));
        expect(second.gateReads()).toBe(0);
        await voterB.destroy();
    });

    it("discards a corrupt snapshot blob and joins empty (the pre-persistence behavior)", async () => {
        const dataPath = await tempDataPath();
        const { makeStorage } = await import("../storage/node.js");
        const topic = await topicFor(bizCriteria());
        const writer = makeStorage({ dataPath });
        await writer.openSnapshots().set(topic, new Uint8Array([1, 2, 3]));
        await writer.destroy();

        const voter = new PubsubVoter({ dataPath, helia: fakeHelia(), chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        expect(contest.tally?.ranking).toEqual([]);
        // The bad blob was removed, not left to fail every future join (WAL admits the reader).
        const reader = makeStorage({ dataPath });
        await vi.waitFor(async () => expect(await reader.openSnapshots().get(topic)).toBeUndefined());
        await reader.destroy();
        await voter.destroy();
    });

    it("skips the snapshot write while deferred checks are pending (never clobbers a good snapshot with a lossy one)", async () => {
        const dataPath = await tempDataPath();
        const topic = await topicFor(bizCriteria());
        const { chains, release } = gatedChains(); // the gate read never lands until release()
        const voter = new PubsubVoter({ dataPath, helia: fakeHelia(), chains, signer: realSigner() });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();

        // Leave with the gate read still pending: the flush must SKIP — the encoder would
        // serve none of the pending bundles, persisting an empty checkpoint.
        await voter.stop();
        const { makeStorage } = await import("../storage/node.js");
        const reader = makeStorage({ dataPath });
        expect(await reader.openSnapshots().get(topic)).toBeUndefined();
        await reader.destroy();
        release();
        await voter.destroy();
    });

    it("runs the flush safely on the in-memory backend (`dataPath: false` — nothing to persist, nothing thrown)", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: stubChains(), signer: fakeSigner() });
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        await expect(voter.stop()).resolves.toBeUndefined(); // leave() flush against the memory store
        await expect(voter.destroy()).resolves.toBeUndefined();
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

    it("a failing router surfaces through each joined contest's error event (announce failures are not silent)", async () => {
        const h = announcerHarness();
        h.fetchSpy.mockResolvedValue({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
        const voter = new PubsubVoter({
            dataPath: false,
            helia: h.helia,
            chains: stubChains(),
            httpRouterUrls: ["http://router.example"]
        });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const errors: unknown[] = [];
        contest.on("error", (e) => errors.push(e));
        await contest.update();
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
        expect(String(errors[0])).toContain("router.example");
        expect(String(errors[0])).toContain("503");
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

    it("announces only JOINED contests: a created-but-never-updated engine contributes no keys", async () => {
        const h = announcerHarness();
        const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: stubChains(), httpRouterUrls: ["http://router.example"] });
        const joined = await voter.createContest({ criteria: bizCriteria() });
        // A second engine exists (createContest built it) but this node never joined its topic —
        // announcing its criteria CID would advertise state we do not serve.
        const bystander = await voter.createContest({ criteria: { ...bizCriteria(), contestId: "pol" } });
        await joined.update();
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        expect(h.fetchSpy).toHaveBeenCalledTimes(1);
        const keys = h.bodies()[0]!.body.Providers[0]!.Payload.Keys;
        const criteriaCidOf = (topic: string) => topic.slice(TOPIC_PREFIX.length);
        expect(keys).toContain(criteriaCidOf(joined.topic));
        expect(keys).not.toContain(criteriaCidOf(bystander.topic));
        expect(keys).toHaveLength(2); // joined criteria CID + its (empty-checkpoint) root, nothing else
        await voter.stop();
    });
});

describe("cold-start fetch backoff bounds", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    /** One subscriber whose fetch ALWAYS throws — a peer permanently over its inbound-stream cap. */
    function throwingFetchHarness() {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5); // deterministic backoff: 200, 400, 800 … ms
        let attempts = 0;
        const fetchService: FetchServiceLike = {
            fetch: async () => {
                attempts += 1;
                throw new Error("stream reset");
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
        const blockstore = { get: async () => new Uint8Array(), put: async (cid: unknown) => cid, has: async () => false };
        const helia = { libp2p: { services: { pubsub, fetch: fetchService } }, blockstore } as unknown as HeliaInstance;
        const voter = new PubsubVoter({ dataPath: false, helia, chains: fakeChains() });
        return { voter, attempts: () => attempts };
    }

    it("abandons the retry quietly when the contest is left mid-backoff (no post-leave fetches)", async () => {
        const h = throwingFetchHarness();
        const contest = await h.voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        await vi.waitFor(() => expect(h.attempts()).toBe(1)); // first attempt threw; the pull is in its backoff sleep
        await h.voter.stop(); // leave() clears the chaser mid-backoff
        await vi.advanceTimersByTimeAsync(60_000); // every scheduled backoff wake-up fires...
        expect(h.attempts()).toBe(1); // ...and finds the contest left: no further fetch, no throw
    });

    it("stops retrying at the fetch deadline; the join itself stays healthy", async () => {
        const h = throwingFetchHarness();
        const contest = await h.voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        await vi.advanceTimersByTimeAsync(40_000); // well past COLD_START_FETCH_DEADLINE_MS (30 s)
        const settled = h.attempts();
        expect(settled).toBeGreaterThan(1); // it did retry while inside the deadline...
        await vi.advanceTimersByTimeAsync(120_000);
        expect(h.attempts()).toBe(settled); // ...and gave up for good once past it
        expect(contest.tally?.ranking).toEqual([]); // the failed pull never poisoned the join
        await h.voter.stop();
    });
});

describe("cold-start provider discovery bounds", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function routedHarness(contentRouting: unknown) {
        const fetchedPeers: string[] = [];
        const dialed: string[] = [];
        const fetchService: FetchServiceLike = {
            fetch: async (peer) => {
                fetchedPeers.push(peer.toString());
                return undefined; // definitive "no record" — no retry, no chase
            },
            registerLookupFunction: () => {},
            unregisterLookupFunction: () => {}
        };
        const pubsub: PubsubService = {
            publish: async () => undefined,
            subscribe: () => {},
            unsubscribe: () => {},
            getSubscribers: () => [], // router-only discovery
            addEventListener: () => {},
            removeEventListener: () => {},
            topicValidators: new Map()
        };
        const blockstore = { get: async () => new Uint8Array(), put: async (cid: unknown) => cid, has: async () => false };
        const libp2p = {
            peerId: { toString: () => "self" },
            dial: async (addrs: unknown) => {
                dialed.push(String(addrs));
            },
            contentRouting,
            services: { pubsub, fetch: fetchService }
        };
        const helia = { libp2p, blockstore } as unknown as HeliaInstance;
        return { voter: new PubsubVoter({ dataPath: false, helia, chains: fakeChains() }), fetchedPeers, dialed };
    }

    it("caps router-discovered providers at COLD_START_PEERS and skips dialing an address-less provider", async () => {
        // Seven providers announced; only the first four (COLD_START_PEERS) are taken. The first
        // carries no multiaddrs — it is still pulled (it may already be connected), just not dialed.
        const contentRouting = {
            findProviders: async function* () {
                for (let i = 0; i < 7; i++) {
                    yield { id: { toString: () => `prov${i}` }, multiaddrs: i === 0 ? [] : [`/ip4/203.0.113.${i}/tcp/4001`] };
                }
            }
        };
        const h = routedHarness(contentRouting);
        const contest = await h.voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        await vi.waitFor(() => expect(h.fetchedPeers.length).toBe(4));
        expect(h.fetchedPeers.sort()).toEqual(["prov0", "prov1", "prov2", "prov3"]);
        expect(h.dialed).toHaveLength(3); // prov0 has no addrs to dial
        await h.voter.stop();
    });

    it("abandons a hung content router at the discovery timeout (bounded, never wedged)", async () => {
        vi.useFakeTimers();
        // A router that never answers: `next` resolves only by rejecting on the abort signal —
        // exactly how a signal-respecting libp2p content router surfaces the timeout.
        const contentRouting = {
            findProviders: (_cid: unknown, opts: { signal: AbortSignal }) => ({
                [Symbol.asyncIterator]() {
                    return {
                        next: () =>
                            new Promise<never>((_, reject) => {
                                opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                            })
                    };
                }
            })
        };
        const h = routedHarness(contentRouting);
        const contest = await h.voter.createContest({ criteria: bizCriteria() });
        await contest.update(); // join resolves immediately — discovery is fire-and-forget
        await vi.advanceTimersByTimeAsync(10_000); // COLD_START_ROUTER_TIMEOUT_MS fires the abort
        expect(h.fetchedPeers).toEqual([]); // nothing discovered, nothing pulled...
        expect(contest.tally?.ranking).toEqual([]); // ...and the contest is live regardless
        await h.voter.stop();
    });
});

describe("tally tie-break through the engine (bucket-boundary block hash seed)", () => {
    /** bizCriteria, but one wallet may vote for two communities — the minimal weight tie. */
    const tieCriteria = () => ({ ...bizCriteria(), maxVotesPerAddress: 2 });
    const TWO_VOTES = [
        { community: { publicKey: VALID_KEY }, vote: 1 },
        { community: { publicKey: OTHER_KEY }, vote: 1 }
    ];

    it("orders a weight tie by the rolling seed sha256(bucketBlockHash ‖ publicKey), reading the boundary block", async () => {
        let blockReads = 0;
        const client = {
            getBlockNumber: async () => 43200n,
            getBlock: async () => {
                blockReads += 1;
                return { hash: `0x${"11".repeat(32)}` };
            },
            readContract: async () => 1n
        };
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: () => client as unknown as ChainClient,
            signer: fakeSigner()
        });
        await (await voter.createContestVote({ criteria: tieCriteria(), votes: TWO_VOTES })).publish();
        const contest = await voter.createContest({ criteria: tieCriteria() });
        const tally = await contest.getTally();
        expect(tally.ranking.map((r) => r.weight)).toEqual([1n, 1n]); // a genuine tie
        expect(blockReads).toBeGreaterThanOrEqual(1); // the seed's one boundary-block read happened

        // Recompute the documented seed independently and assert the REAL order, not just stability.
        const blockHash = new Uint8Array(32).fill(0x11);
        const seedOf = async (publicKey: string): Promise<Uint8Array> => {
            const pk = base58btc.decode(`z${publicKey}`);
            const buf = new Uint8Array(blockHash.length + pk.length);
            buf.set(blockHash, 0);
            buf.set(pk, blockHash.length);
            return (await sha256.digest(buf)).digest;
        };
        const lex = (x: Uint8Array, y: Uint8Array): number => {
            for (let i = 0; i < Math.min(x.length, y.length); i++) {
                if (x[i] !== y[i]) return x[i]! - y[i]!;
            }
            return x.length - y.length;
        };
        const expected = [VALID_KEY, OTHER_KEY];
        const seeds = new Map(await Promise.all(expected.map(async (k) => [k, await seedOf(k)] as const)));
        expected.sort((a, b) => lex(seeds.get(a)!, seeds.get(b)!));
        expect(tally.ranking.map((r) => r.community.publicKey)).toEqual(expected);
    });

    it("surfaces a boundary block with no hash as a tally error event (never a silent mis-order)", async () => {
        const client = {
            getBlockNumber: async () => 43200n,
            getBlock: async () => ({ hash: null }), // a pruned/pending boundary block
            readContract: async () => 1n
        };
        const voter = new PubsubVoter({ dataPath: false,
            helia: fakeHelia(),
            chains: () => client as unknown as ChainClient,
            signer: fakeSigner()
        });
        const contest = await voter.createContest({ criteria: tieCriteria() });
        const errors: unknown[] = [];
        contest.on("error", (e) => errors.push(e));
        await contest.update();
        await (await voter.createContestVote({ criteria: tieCriteria(), votes: TWO_VOTES })).publish();
        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
        expect(String(errors[0])).toContain("has no hash");
        await voter.stop();
    });
});

describe("peer-root map (advertiser LRU + chase session providers)", () => {
    const PEER_ROOTS_MAX = 256; // src/client/voter.ts PEER_ROOTS_MAX

    /**
     * A voter on a session-capable blockstore with a fixed connection set, its topic validator
     * exposed: delivering root records drives `#notePeerRoot`, and each divergent-root chase
     * reveals the map's contents through the session's `providers` (advertisers ∩ connections).
     */
    async function peerRootHarness(connections: string[]) {
        const sessions: Array<{ root: string; providers: string[] }> = [];
        let broadcastGets = 0;
        const blockstore = {
            get: async () => {
                broadcastGets += 1;
                throw new Error("no block"); // every chase fails fast; only its session opening matters
            },
            put: async (cid: unknown) => cid,
            has: async () => false,
            createSession: (root: CID, options?: { providers?: PeerId[] }) => {
                sessions.push({ root: root.toString(), providers: (options?.providers ?? []).map((p) => p.toString()) });
                return {
                    get: async () => {
                        throw new Error("no block");
                    },
                    addPeer: () => {},
                    close: () => {}
                };
            }
        };
        const pubsub: PubsubService = {
            publish: async () => undefined,
            subscribe: () => {},
            unsubscribe: () => {},
            getSubscribers: () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
            topicValidators: new Map()
        };
        const libp2p = {
            peerId: { toString: () => "self" },
            getConnections: () => connections.map((id) => ({ remotePeer: { toString: () => id } })),
            services: { pubsub, fetch: fakeFetchService() }
        };
        const helia = { libp2p, blockstore } as unknown as HeliaInstance;
        const voter = new PubsubVoter({ dataPath: false, helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        const validator = pubsub.topicValidators!.get(contest.topic)!;
        const deliver = async (record: RootRecord, from: string) => {
            const peer = { toString: () => from } as unknown as Parameters<typeof validator>[0];
            await validator(peer, { topic: contest.topic, data: encodeRootMessage(record) });
        };
        /** Wait until `n` chases ran to completion (each failed chase does exactly one broadcast get). */
        const drainChases = async (n: number) => {
            await vi.waitFor(() => expect(broadcastGets).toBe(n));
            await new Promise((resolve) => setTimeout(resolve, 25)); // let the flight leave the in-flight map
        };
        const ownRecord = await (contest as unknown as { rootRecord(): Promise<RootRecord> }).rootRecord();
        return { voter, contest, deliver, drainChases, sessions, ownRecord };
    }

    it("seeds a chase with every still-connected advertiser of that exact root; refresh keeps a peer, overflow evicts the oldest", async () => {
        // p1, p2, p257 are connected; the divergent root RA is what they advertise.
        const h = await peerRootHarness(["p1", "p2", "p257"]);
        const RA = CID.parse("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4");
        const recordA: RootRecord = { version: ROOT_RECORD_VERSION, root: RA, count: 1, sizeBytes: 100 };

        await h.deliver(recordA, "p1"); // map: p1→RA
        await h.drainChases(1);
        expect(h.sessions[0]).toEqual({ root: RA.toString(), providers: ["p1"] });

        await h.deliver(recordA, "p2"); // map: p1, p2 — both advertise RA and both are connected
        await h.drainChases(2);
        expect(h.sessions[1]).toEqual({ root: RA.toString(), providers: ["p1", "p2"] });

        // Fill the map to PEER_ROOTS_MAX with peers advertising OUR root (noted, but no chase).
        for (let i = 3; i <= PEER_ROOTS_MAX; i++) await h.deliver(h.ownRecord, `filler${i}`);
        // Re-advertising refreshes p1's slot: p2 is now the oldest entry.
        await h.deliver(recordA, "p1");
        await h.drainChases(3);
        // p257 lands on the FULL map: the oldest (p2) is evicted — its slot, and only its slot.
        await h.deliver(recordA, "p257");
        await h.drainChases(4);
        // The final chase proves both: p1 survived (refreshed), p2 is gone (evicted), p257 present.
        expect(h.sessions[3]).toEqual({ root: RA.toString(), providers: ["p1", "p257"] });

        await h.voter.stop();
    });
});

describe("facade odds and ends", () => {
    it("update() is idempotent while joined (no duplicate listeners, no re-join)", async () => {
        const h = subscribableHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: h.helia, chains: fakeChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        let updates = 0;
        contest.on("update", () => {
            updates += 1;
        });
        await contest.update();
        expect(h.listenerCount()).toBe(1);
        expect(updates).toBe(1);
        await contest.update(); // second call is a no-op: already subscribed
        expect(h.listenerCount()).toBe(1);
        expect(updates).toBe(1);
        await voter.stop();
    });

    it("a ContestVote exposes its contest's topic", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: fakeHelia(), chains: fakeChains(), signer: fakeSigner() });
        const vote = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE });
        expect(vote.topic).toBe(await topicFor(bizCriteria()));
        await voter.destroy();
    });
});

describe("checkpoint snapshot restore admissibility", () => {
    const tempDataPath = async (): Promise<string> => {
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        return mkdtempSync(join(tmpdir(), "pubsub-voting-voter-test-"));
    };
    const chainsAt = (head: bigint): ChainClientFactory => {
        const client = {
            getBlockNumber: async () => head,
            getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
            readContract: async () => 1n
        };
        return () => client as unknown as ChainClient;
    };

    it("skips a restored bundle dated past our own chain head (transiently unevaluable, not admitted blind)", async () => {
        const dataPath = await tempDataPath();
        const signer = realSigner();

        // Session 1 persists a vote sampled at bucket 40.
        const voterA = new PubsubVoter({ dataPath, helia: fakeHelia(), chains: chainsAt(40n * 43200n), signer });
        await (await voterA.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contestA = await voterA.createContest({ criteria: bizCriteria() });
        await vi.waitFor(async () => expect((await contestA.getTally()).ranking[0]?.chainVerified).toBe(true));
        await voterA.destroy();

        // Session 2's chain head is far BEHIND the snapshot (a lagging or wrong RPC): the bundle's
        // sample bucket is not yet reachable, so the restore must skip it rather than admit a
        // bundle no verifier could evaluate.
        const voterB = new PubsubVoter({ dataPath, helia: fakeHelia(), chains: chainsAt(43200n), signer });
        const contestB = await voterB.createContest({ criteria: bizCriteria() });
        await contestB.update();
        expect(contestB.tally?.ranking).toEqual([]);
        await voterB.destroy();
    });

    it("a re-join restores idempotently (already-admitted bundles are not doubled)", async () => {
        const dataPath = await tempDataPath();
        const signer = realSigner();
        const chains = chainsAt(40n * 43200n);

        const voterA = new PubsubVoter({ dataPath, helia: fakeHelia(), chains, signer });
        await (await voterA.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        const contestA = await voterA.createContest({ criteria: bizCriteria() });
        await vi.waitFor(async () => expect((await contestA.getTally()).ranking[0]?.chainVerified).toBe(true));
        await voterA.destroy();

        const voterB = new PubsubVoter({ dataPath, helia: fakeHelia(), chains, signer });
        const contestB = await voterB.createContest({ criteria: bizCriteria() });
        await contestB.update();
        expect(contestB.tally?.ranking).toHaveLength(1);
        await contestB.stop();
        await contestB.update(); // the re-join re-runs the restore against already-admitted state
        expect(contestB.tally?.ranking).toHaveLength(1); // same vote, not doubled
        expect(contestB.tally?.ranking[0]?.weight).toBe(1n);
        await voterB.destroy();
    });
});
