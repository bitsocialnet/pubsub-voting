import { describe, it, expect, vi } from "vitest";
import type { PeerId } from "@libp2p/interface";
import { PubsubVoter, type PublishingState } from "./voter.js";
import { VoterDestroyedError } from "../errors.js";
import { bundleCidForBytes, encodeBundle } from "../crdt/codec.js";
import type { ChainClient, ChainClientFactory } from "../chain/types.js";
import type { VoteSigner } from "../signer/types.js";
import type { FetchServiceLike, HeliaInstance, PubsubService } from "../transport/types.js";
import { bizCriteria, fakeSigner, stubChains } from "../test-fixtures.js";

/**
 * Overlapping calls on one contest: lifecycle transitions racing each other (join/leave, create
 * vs destroy), a publish racing a stop, and tally recomputes racing each other. Each of these
 * used to leave the engine in a state no sequential call order can produce.
 */

const VALID_KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const OTHER_KEY = "12D3KooWQYV9dGMFoRzNStwpXztXaBUjtPqi6aU76ZgUriHhKust";
const VOTE = [{ community: { publicKey: VALID_KEY }, vote: 1 }];
const OTHER_VOTE = [{ community: { publicKey: OTHER_KEY }, vote: 1 }];
const THIRD_KEY = "12D3KooWJMAhZsN5twuG3u846uLTcTe6hrDyriB7YnCt8svHJBRg";
const THIRD_VOTE = [{ community: { publicKey: THIRD_KEY }, vote: 1 }];
const WALLET_A = "0x00000000000000000000000000000000000000aa";
const WALLET_B = "0x00000000000000000000000000000000000000bb";
const WALLET_C = "0x00000000000000000000000000000000000000cc";

/**
 * A host node that records what the voter did to it: the bundles it broadcast, which topics
 * carry an installed forward-gate (the transport's live subscription), and whether the
 * root-record responder is registered. `publish` may be overridden to make broadcasts fail,
 * `parkNextPut` parks the next blockstore write (e.g. a leave's snapshot flush) until released,
 * and `puts` counts blockstore writes (a checkpoint encode writes its blocks).
 */
function recordingHelia(publishImpl?: () => Promise<{ recipients?: readonly PeerId[] }>) {
    const broadcasts: string[] = [];
    const topicValidators: NonNullable<PubsubService["topicValidators"]> = new Map();
    const pubsub: PubsubService = {
        publish: async (topic) => {
            broadcasts.push(topic);
            return publishImpl ? publishImpl() : { recipients: [{ toString: () => "recipient1" } as unknown as PeerId] };
        },
        subscribe: () => {},
        unsubscribe: () => {},
        getSubscribers: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
        topicValidators
    };
    let registered = false;
    const fetch: FetchServiceLike = {
        fetch: async () => undefined,
        registerLookupFunction: () => {
            registered = true;
        },
        unregisterLookupFunction: () => {
            registered = false;
        }
    };
    let parkPut: Promise<void> | undefined;
    let putParked = false;
    let puts = 0;
    const blockstore = {
        get: async () => new Uint8Array(),
        put: async (cid: unknown) => {
            puts += 1;
            const parked = parkPut;
            parkPut = undefined; // only the next write parks
            if (parked !== undefined) {
                putParked = true;
                await parked;
            }
            return cid;
        },
        has: async () => false
    };
    const helia = { libp2p: { services: { pubsub, fetch } }, blockstore } as unknown as HeliaInstance;
    const parkNextPut = (): { parked: () => boolean; release: () => void } => {
        let release!: () => void;
        parkPut = new Promise<void>((resolve) => (release = resolve));
        putParked = false;
        return { parked: () => putParked, release };
    };
    return { helia, broadcasts, topicValidators, responderRegistered: () => registered, parkNextPut, puts: () => puts };
}

/** A signer that parks inside `signBallot` (a wallet prompt left open) until `release()`. */
function promptSigner(address = WALLET_A): { signer: VoteSigner; prompting: () => boolean; release: () => void } {
    const inner = fakeSigner(address);
    let prompting = false;
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    return {
        signer: {
            address: inner.address,
            signBallot: async (typedData) => {
                prompting = true;
                await answered;
                return inner.signBallot(typedData);
            }
        },
        prompting: () => prompting,
        release
    };
}

/**
 * A chain whose bucket-boundary block read (the tally's tie-break seed, `getBlock`) can be made to
 * fail, or its next read made to hang. Nothing else reads `getBlock`, so only a tally compute over
 * a weight TIE is affected: the gate read, the publish path and the background verifier stay healthy.
 * A parked read checks `fail` when it is released, not when it started.
 */
function tieReadChains(): { chains: ChainClientFactory; fail: (on: boolean) => void; hang: () => () => void; blockReads: () => number } {
    let failing = false;
    let hanging: Promise<void> | undefined;
    let blockReads = 0;
    const client = {
        getBlockNumber: async () => 43200n,
        getBlock: async () => {
            blockReads += 1;
            const parked = hanging;
            hanging = undefined; // only the next read parks
            if (parked !== undefined) await parked;
            if (failing) throw new Error("boundary block read failed");
            return { hash: `0x${"11".repeat(32)}` };
        },
        readContract: async ({ functionName }: { functionName?: string } = {}) => (functionName === "supportsInterface" ? true : 1n)
    };
    return {
        chains: () => client as unknown as ChainClient,
        fail: (on) => (failing = on),
        hang: () => {
            let release!: () => void;
            hanging = new Promise<void>((resolve) => (release = resolve));
            return release;
        },
        blockReads: () => blockReads
    };
}

describe("join/leave transitions never interleave", () => {
    it("stop() then update() without awaiting the stop leaves the contest joined with a live transport", async () => {
        const node = recordingHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();

        // A UI that restarts a view without awaiting the stop: the leave is suspended on the
        // transport teardown when the re-join builds its transport.
        await Promise.all([contest.stop(), contest.update()]);

        // The re-join's transport must be the one the engine holds: a vote published now goes out.
        const ballot = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() });
        const { recipientCount } = await ballot.publish();
        expect(recipientCount).toBe(1);
        expect(node.broadcasts).toEqual([contest.topic]);
        await voter.destroy();
    });

    it("stop() then update() while a snapshot flush is pending does not unsubscribe the re-joined view", async () => {
        const node = recordingHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        // A state change arms the debounced snapshot write, so the leave awaits its flush first.
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() })).publish();

        await Promise.all([contest.stop(), contest.update()]);

        // The view is subscribed, so the engine must be on the topic too: its gate is installed
        // and the root-record responder is up.
        expect(node.topicValidators.has(contest.topic)).toBe(true);
        expect(node.responderRegistered()).toBe(true);
        await voter.destroy();
    });

    it("two joins in the same tick count as one, so the last leave unregisters the responder", async () => {
        const node = recordingHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const first = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_A) });
        const second = await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: fakeSigner(WALLET_B) });

        await Promise.all([first.publish(), second.publish()]); // both join the same engine

        await voter.stop();
        expect(node.responderRegistered()).toBe(false);
        expect(node.topicValidators.has(first.topic)).toBe(false);
        await voter.destroy();
    });
});

describe("a publish never reports a broadcast that did not happen", () => {
    it("destroy() while the wallet is signing rejects the publish with VoterDestroyedError", async () => {
        const node = recordingHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const prompt = promptSigner();
        const ballot = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: prompt.signer });
        const states: PublishingState[] = [];
        ballot.on("publishingstatechange", (state) => states.push(state));
        const errors: unknown[] = [];
        ballot.on("error", (error) => errors.push(error));

        const publishing = ballot.publish();
        await vi.waitFor(() => expect(prompt.prompting()).toBe(true));
        await voter.destroy();
        prompt.release();

        await expect(publishing).rejects.toThrow(VoterDestroyedError);
        expect(ballot.publishingState).toBe("failed");
        expect(states).not.toContain("published");
        expect(errors[0]).toBeInstanceOf(VoterDestroyedError);
        expect(node.broadcasts).toEqual([]);
    });

    it("a contest stop() while the wallet is signing fails the publish instead of resolving it unsent", async () => {
        const node = recordingHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        const prompt = promptSigner();
        const ballot = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: prompt.signer });

        const publishing = ballot.publish();
        await vi.waitFor(() => expect(prompt.prompting()).toBe(true));
        await contest.stop(); // leaves the engine the ballot joined through
        prompt.release();

        await expect(publishing).rejects.toThrow(/not broadcast/);
        expect(ballot.publishingState).toBe("failed");
        expect(node.broadcasts).toEqual([]);
        await voter.destroy();
    });

    /**
     * The leave keeps its transport until the snapshot flush and the unsubscribe are done, so a
     * wallet answering while a stop() or destroy() is still flushing found a live transport and
     * broadcast after teardown had begun. Parks that flush on the blockstore write it makes.
     */
    async function answerDuringLeaveFlush(leave: (voter: PubsubVoter) => Promise<void>) {
        const node = recordingHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update();
        // A settled vote arms the debounced snapshot write, so the leave flushes it first.
        const first = await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_B) })).publish();
        await vi.waitFor(() => expect(contest.checksFor(first.cid)?.chainVerified).toBe(true));
        const prompt = promptSigner();
        const ballot = await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: prompt.signer });
        const publishing = ballot.publish();
        await vi.waitFor(() => expect(prompt.prompting()).toBe(true));

        const flush = node.parkNextPut();
        const leaving = leave(voter);
        await vi.waitFor(() => expect(flush.parked()).toBe(true));
        prompt.release();
        const outcome = await publishing.then(
            () => undefined,
            (error: unknown) => error
        );
        const broadcasts = [...node.broadcasts];
        flush.release();
        await leaving;
        await voter.destroy();
        return { outcome, broadcasts, topic: contest.topic, state: ballot.publishingState };
    }

    it("destroy() still flushing its snapshot when the wallet answers rejects the publish unsent", async () => {
        const { outcome, broadcasts, topic, state } = await answerDuringLeaveFlush((voter) => voter.destroy());
        expect(outcome).toBeInstanceOf(VoterDestroyedError);
        expect(state).toBe("failed");
        expect(broadcasts).toEqual([topic]); // the first vote's only
    });

    it("stop() still flushing its snapshot when the wallet answers fails the publish unsent", async () => {
        const { outcome, broadcasts, topic, state } = await answerDuringLeaveFlush((voter) => voter.stop());
        expect(String(outcome)).toMatch(/not broadcast/);
        expect(state).toBe("failed");
        expect(broadcasts).toEqual([topic]);
    });

    it("a wallet answering while the leave flushes arms no snapshot write that outlives the leave", async () => {
        vi.useFakeTimers();
        try {
            const node = recordingHelia();
            const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
            const contest = await voter.createContest({ criteria: bizCriteria() });
            await contest.update();
            // A settled vote arms the debounced snapshot write, so the leave flushes it first.
            await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_B) })).publish();
            await vi.advanceTimersByTimeAsync(500);
            const prompt = promptSigner();
            const ballot = await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: prompt.signer });
            const publishing = ballot.publish().catch(() => {});
            await vi.waitFor(() => expect(prompt.prompting()).toBe(true));

            // The signed vote and its retraction both change state while the flush is parked. One
            // leave: the contest's stop() leaves the engine the ballot published through.
            const flush = node.parkNextPut();
            const stopping = contest.stop();
            await vi.waitFor(() => expect(flush.parked()).toBe(true));
            prompt.release();
            await publishing;
            flush.release();
            await stopping;

            // The topic is left: no debounced write may re-encode and persist the checkpoint later.
            const puts = node.puts();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(node.puts()).toBe(puts);
            await voter.destroy();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("a failed broadcast takes the vote back out of the local state", () => {
    it("a broadcast the pubsub rejects leaves the vote neither counted nor served", async () => {
        const node = recordingHelia(async () => {
            throw new Error("NoPeersSubscribedToTopic");
        });
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const ballot = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() });

        await expect(ballot.publish()).rejects.toThrow("NoPeersSubscribedToTopic");
        expect(ballot.publishingState).toBe("failed");
        const cid = await bundleCidForBytes(encodeBundle(ballot.bundle!));
        expect(contest.checksFor(cid)).toBeUndefined();
        expect((await contest.getTally()).ranking).toEqual([]);

        // The deferred gate read still lands for the retracted bundle; it must not bring it back.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(contest.checksFor(cid)).toBeUndefined();
        expect((await contest.getTally()).ranking).toEqual([]);
        expect((await (contest as unknown as { rootRecord(): Promise<{ count: number }> }).rootRecord()).count).toBe(0);
        await voter.destroy();
    });

    it("a vote whose check settles while its broadcast is in flight is served only once the broadcast went out", async () => {
        let send!: () => void;
        const node = recordingHelia(
            () => new Promise((resolve) => (send = () => resolve({ recipients: [{ toString: () => "recipient1" } as unknown as PeerId] })))
        );
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const rootRecord = () => (contest as unknown as { rootRecord(): Promise<{ count: number }> }).rootRecord();
        const ballot = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() });
        const publishing = ballot.publish();
        await vi.waitFor(() => expect(node.broadcasts).toHaveLength(1));
        const cid = await bundleCidForBytes(encodeBundle(ballot.bundle!));
        await vi.waitFor(() => expect(contest.checksFor(cid)?.chainVerified).toBe(true));

        // Verified, but a failing broadcast would still take it back: a peer must not fetch it yet.
        expect((await rootRecord()).count).toBe(0);
        send();
        await publishing;
        expect((await rootRecord()).count).toBe(1);
        await voter.destroy();
    });

    it("keeps an identical vote that an earlier publish already put on the wire", async () => {
        let publishes = 0;
        const node = recordingHelia(async () => {
            publishes += 1;
            if (publishes > 1) throw new Error("NoPeersSubscribedToTopic");
            return { recipients: [{ toString: () => "recipient1" } as unknown as PeerId] };
        });
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const sent = await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() })).publish();

        // Same wallet, same votes, same bucket: byte-identical bundle, same CID — already out there.
        const again = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() });
        await expect(again.publish()).rejects.toThrow("NoPeersSubscribedToTopic");
        expect(again.bundle).toEqual(sent.bundle);
        expect(contest.checksFor(sent.cid)).toBeDefined();
        expect((await contest.getTally()).ranking).toHaveLength(1);
        await voter.destroy();
    });

    /**
     * Two ballots of the same wallet and votes in one bucket sign byte-identical bundles. Both
     * broadcasts are parked until `settle` decides each one's fate, so both are in flight at once.
     */
    async function duplicateInFlight(outcomes: ["send" | "fail", "send" | "fail"]) {
        const parked: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
        const node = recordingHelia(
            () =>
                new Promise((resolve, reject) =>
                    parked.push({ resolve: () => resolve({ recipients: [{ toString: () => "recipient1" } as unknown as PeerId] }), reject })
                )
        );
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const first = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() });
        const second = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() });
        const settled = Promise.allSettled([first.publish(), second.publish()]);
        await vi.waitFor(() => expect(parked).toHaveLength(2));
        outcomes.forEach((outcome, i) => (outcome === "send" ? parked[i]!.resolve() : parked[i]!.reject(new Error("NoPeersSubscribedToTopic"))));
        const results = await settled;
        expect(first.bundle).toEqual(second.bundle);
        const cid = await bundleCidForBytes(encodeBundle(first.bundle!));
        return { voter, contest, cid, results };
    }

    it("two in-flight publishes of the same bytes take the vote back when both broadcasts fail", async () => {
        const { voter, contest, cid, results } = await duplicateInFlight(["fail", "fail"]);
        expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
        expect(contest.checksFor(cid)).toBeUndefined();
        expect((await contest.getTally()).ranking).toEqual([]);
        await voter.destroy();
    });

    it("two in-flight publishes of the same bytes keep the vote when either broadcast went out", async () => {
        for (const outcomes of [
            ["send", "fail"],
            ["fail", "send"]
        ] as const) {
            const { voter, contest, cid } = await duplicateInFlight([...outcomes]);
            expect(contest.checksFor(cid)).toBeDefined();
            expect((await contest.getTally()).ranking).toHaveLength(1);
            await voter.destroy();
        }
    });

    it("a failed re-vote leaves the wallet's earlier vote in place, even once the re-vote had settled", async () => {
        let head = 43200n;
        const client = {
            getBlockNumber: async () => head,
            getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
            readContract: async ({ functionName }: { functionName?: string } = {}) => (functionName === "supportsInterface" ? true : 1n)
        };
        let fail!: () => void;
        const parked = new Promise<never>((_, reject) => (fail = () => reject(new Error("NoPeersSubscribedToTopic"))));
        parked.catch(() => {});
        let publishes = 0;
        const node = recordingHelia(async () => {
            publishes += 1;
            if (publishes > 1) return parked;
            return { recipients: [{ toString: () => "recipient1" } as unknown as PeerId] };
        });
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: () => client as unknown as ChainClient });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        await contest.update(); // subscribed: each state change recomputes the tally, which prunes
        const earlier = await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() })).publish();
        await vi.waitFor(() => expect(contest.checksFor(earlier.cid)?.chainVerified).toBe(true));

        // A bucket later the same wallet re-votes. Its broadcast hangs while its own deferred check
        // settles and a recompute prunes the bundle it supersedes.
        head += 43200n;
        const revote = await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: fakeSigner() });
        const publishing = revote.publish();
        await vi.waitFor(() =>
            expect(contest.tally?.ranking.map((row) => [row.community.publicKey, row.chainVerified])).toEqual([[OTHER_KEY, true]])
        );

        fail();
        await expect(publishing).rejects.toThrow("NoPeersSubscribedToTopic");
        // The re-vote never left; the earlier vote did, and is this wallet's vote again.
        expect(contest.checksFor(earlier.cid)?.chainVerified).toBe(true);
        expect((await contest.getTally()).ranking.map((row) => row.community.publicKey)).toEqual([VALID_KEY]);
        await voter.destroy();
    });

    it("a destroy() while the wallet is signing does not keep the unsent vote either", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: recordingHelia().helia, chains: stubChains() });
        const prompt = promptSigner();
        const ballot = await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: prompt.signer });
        const publishing = ballot.publish();
        await vi.waitFor(() => expect(prompt.prompting()).toBe(true));
        await voter.destroy();
        prompt.release();
        await expect(publishing).rejects.toThrow(VoterDestroyedError);
        expect(ballot.checks).toBeUndefined();
    });
});

describe("tally recompute recovery and ordering", () => {
    it("retries a failed recompute, so a quiet topic does not keep a stale tally", async () => {
        vi.useFakeTimers();
        try {
            const chain = tieReadChains();
            const voter = new PubsubVoter({ dataPath: false, helia: recordingHelia().helia, chains: chain.chains });
            const contest = await voter.createContest({ criteria: bizCriteria() });
            const errors: unknown[] = [];
            contest.on("error", (error) => errors.push(error));
            await contest.update();

            // Two wallets, two communities, weight 1 each: a tie, so every compute reads the
            // boundary block — and that read fails.
            chain.fail(true);
            await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_A) })).publish();
            await (await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: fakeSigner(WALLET_B) })).publish();
            await vi.advanceTimersByTimeAsync(500); // the deferred gate reads settle; their recomputes fail too
            expect(errors.length).toBeGreaterThan(0);
            expect(contest.tally?.ranking.length ?? 0).toBeLessThan(2); // stale: wallet B's vote is missing

            // The RPC recovers. Nothing else happens on this topic: only a retry can catch up.
            chain.fail(false);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(contest.tally?.ranking.map((row) => row.weight)).toEqual([1n, 1n]);
            await voter.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it("a recompute that succeeds before the retry fires cancels the retry", async () => {
        vi.useFakeTimers();
        try {
            const chain = tieReadChains();
            const voter = new PubsubVoter({ dataPath: false, helia: recordingHelia().helia, chains: chain.chains });
            const contest = await voter.createContest({ criteria: bizCriteria() });
            await contest.update();
            chain.fail(true);
            await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_A) })).publish();
            await (await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: fakeSigner(WALLET_B) })).publish();
            await vi.advanceTimersByTimeAsync(500); // failed recomputes: a retry is armed
            chain.fail(false);

            // A new vote (breaking the tie) recomputes successfully before the retry is due.
            await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_C) })).publish();
            await vi.advanceTimersByTimeAsync(500);
            expect(contest.tally?.ranking.map((row) => row.weight)).toEqual([2n, 1n]);
            let updates = 0;
            contest.on("update", () => {
                updates += 1;
            });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(updates).toBe(0); // the stale retry did not fire a redundant recompute
            await voter.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it("an older compute finishing late never overwrites a newer tally", async () => {
        const chain = tieReadChains();
        const voter = new PubsubVoter({ dataPath: false, helia: recordingHelia().helia, chains: chain.chains });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const a = await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_A) })).publish();
        const b = await (await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: fakeSigner(WALLET_B) })).publish();
        // Settled before the view subscribes, so no settlement can start a loop compute of its own.
        await vi.waitFor(() => expect([a.cid, b.cid].map((cid) => contest.checksFor(cid)?.chainVerified)).toEqual([true, true]));

        // update()'s initial compute sees the 1–1 tie and parks on the boundary block read.
        const releaseTieRead = chain.hang();
        const updating = contest.update();
        await vi.waitFor(() => expect(chain.blockReads()).toBe(1));

        // Meanwhile a third wallet breaks the tie; the refresh loop computes the newer tally.
        const third = await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_C) })).publish();
        await vi.waitFor(() => expect(contest.checksFor(third.cid)?.chainVerified).toBe(true));
        await vi.waitFor(() => expect(contest.tally?.ranking.every((row) => row.chainVerified)).toBe(true));
        expect(contest.tally?.ranking.map((row) => row.weight)).toEqual([2n, 1n]);

        // The stale compute finally lands: it must not roll the tally back to the tie.
        releaseTieRead();
        await updating;
        expect(contest.tally?.ranking.map((row) => row.weight)).toEqual([2n, 1n]);
        await voter.destroy();
    });

    it("an older compute failing after a newer one was applied neither reports nor retries", async () => {
        vi.useFakeTimers();
        try {
            const chain = tieReadChains();
            const voter = new PubsubVoter({ dataPath: false, helia: recordingHelia().helia, chains: chain.chains });
            const contest = await voter.createContest({ criteria: bizCriteria() });
            const a = await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_A) })).publish();
            const b = await (await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: fakeSigner(WALLET_B) })).publish();
            await vi.advanceTimersByTimeAsync(500);
            expect([a.cid, b.cid].map((cid) => contest.checksFor(cid)?.chainVerified)).toEqual([true, true]);

            // update()'s initial compute sees the 1–1 tie and parks on the boundary block read.
            const releaseTieRead = chain.hang();
            const updating = contest.update();
            await vi.advanceTimersByTimeAsync(0);
            expect(chain.blockReads()).toBe(1);

            // A third wallet breaks the tie (no boundary read): the refresh loop applies the newer tally.
            await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_C) })).publish();
            await vi.advanceTimersByTimeAsync(500);
            expect(contest.tally?.ranking.map((row) => [row.weight, row.chainVerified])).toEqual([
                [2n, true],
                [1n, true]
            ]);

            // The parked compute now fails. A newer tally is already applied: nothing to report or retry.
            const errors: unknown[] = [];
            contest.on("error", (error) => errors.push(error));
            let updates = 0;
            contest.on("update", () => {
                updates += 1;
            });
            chain.fail(true);
            releaseTieRead();
            await updating;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(errors).toEqual([]);
            expect(updates).toBe(0);
            expect(contest.tally?.ranking.map((row) => row.weight)).toEqual([2n, 1n]);
            await voter.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it("an older compute finishing after a newer one failed keeps the retry armed", async () => {
        vi.useFakeTimers();
        try {
            const chain = tieReadChains();
            const voter = new PubsubVoter({ dataPath: false, helia: recordingHelia().helia, chains: chain.chains });
            const contest = await voter.createContest({ criteria: bizCriteria() });
            const a = await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner(WALLET_A) })).publish();
            const b = await (await voter.createContestVote({ criteria: bizCriteria(), votes: OTHER_VOTE, signer: fakeSigner(WALLET_B) })).publish();
            await vi.advanceTimersByTimeAsync(500);
            expect([a.cid, b.cid].map((cid) => contest.checksFor(cid)?.chainVerified)).toEqual([true, true]);

            // update()'s initial compute sees the 1–1 tie and parks on the boundary block read.
            const releaseTieRead = chain.hang();
            const updating = contest.update();
            await vi.advanceTimersByTimeAsync(0);
            expect(chain.blockReads()).toBe(1);

            // A third wallet votes for a third community: a 3-way tie, whose boundary read fails, so
            // the refresh loop's newer computes fail and arm a retry.
            chain.fail(true);
            const third = await (await voter.createContestVote({ criteria: bizCriteria(), votes: THIRD_VOTE, signer: fakeSigner(WALLET_C) })).publish();
            await vi.advanceTimersByTimeAsync(500);
            expect(contest.checksFor(third.cid)?.chainVerified).toBe(true);
            expect(chain.blockReads()).toBeGreaterThan(1);

            // The RPC recovers and the older compute lands before the retry is due. It may show its
            // two-row tally, but it predates wallet C's vote and must not cancel the retry.
            chain.fail(false);
            releaseTieRead();
            await updating;
            expect(contest.tally?.ranking.length).toBe(2);

            // Nothing else happens on this topic: only the retry can catch up.
            await vi.advanceTimersByTimeAsync(3_000);
            expect(contest.tally?.ranking.map((row) => row.weight)).toEqual([1n, 1n, 1n]);
            await voter.destroy();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("destroy() racing a create", () => {
    it("a createContest in flight when destroy() runs rejects instead of yielding a live contest", async () => {
        const node = recordingHelia();
        const voter = new PubsubVoter({ dataPath: false, helia: node.helia, chains: stubChains() });
        const creating = voter.createContest({ criteria: bizCriteria() }); // suspended on the criteria CID
        const destroying = voter.destroy();
        await expect(creating).rejects.toThrow(VoterDestroyedError);
        await destroying;
        expect(node.topicValidators.size).toBe(0);
    });

    it("a createContestVote in flight when destroy() runs rejects too", async () => {
        const voter = new PubsubVoter({ dataPath: false, helia: recordingHelia().helia, chains: stubChains() });
        const creating = voter.createContestVote({ criteria: bizCriteria(), votes: VOTE, signer: fakeSigner() });
        const destroying = voter.destroy();
        await expect(creating).rejects.toThrow(VoterDestroyedError);
        await destroying;
    });
});
