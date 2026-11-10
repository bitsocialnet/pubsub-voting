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
const WALLET_A = "0x00000000000000000000000000000000000000aa";
const WALLET_B = "0x00000000000000000000000000000000000000bb";
const WALLET_C = "0x00000000000000000000000000000000000000cc";

/**
 * A host node that records what the voter did to it: the bundles it broadcast, which topics
 * carry an installed forward-gate (the transport's live subscription), and whether the
 * root-record responder is registered. `publish` may be overridden to make broadcasts fail.
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
    const blockstore = { get: async () => new Uint8Array(), put: async (cid: unknown) => cid, has: async () => false };
    const helia = { libp2p: { services: { pubsub, fetch } }, blockstore } as unknown as HeliaInstance;
    return { helia, broadcasts, topicValidators, responderRegistered: () => registered };
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
