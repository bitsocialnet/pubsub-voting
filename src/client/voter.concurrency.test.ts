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
