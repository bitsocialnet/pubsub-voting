import { describe, it, expect } from "vitest";
import type { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
import { makeVoteTransport } from "./transport.js";
import { makeGossipGate } from "./gossip-validator.js";
import { encodeWinnerCids, decodeWinnerCids } from "./winner-cids.js";
import type { PubsubService, GossipTopicValidator } from "./types.js";
import { makeMemoryBundleStore } from "../crdt/store.js";
import { makeVoteCrdt } from "../crdt/crdt.js";
import { makeVerdictCache } from "../verify/cache.js";
import { makeBucketMath } from "../chain/bucket.js";
import type { BundleVerifier } from "../verify/types.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const TOPIC = "bitsocial-votes/test";
const okVerifier: BundleVerifier = { verify: async () => ({ valid: true, ruleScore: 1n, resolvedNames: {} }) };

function fakePeer(id: string): PeerId {
    return { toString: () => id } as unknown as PeerId;
}

function fakePubsub() {
    const topicValidators = new Map<string, GossipTopicValidator>();
    const published: Array<{ topic: string; data: Uint8Array }> = [];
    const subscribed = new Set<string>();
    const pubsub: PubsubService = {
        topicValidators,
        publish: async (topic, data) => {
            published.push({ topic, data });
            return undefined;
        },
        subscribe: (t) => {
            subscribed.add(t);
        },
        unsubscribe: (t) => {
            subscribed.delete(t);
        },
        getSubscribers: () => [],
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    return { pubsub, topicValidators, published, subscribed };
}

async function harness() {
    const { pubsub, topicValidators, published, subscribed } = fakePubsub();
    const store = makeMemoryBundleStore();
    const crdt = makeVoteCrdt({ store, bucketMath: makeBucketMath(43200), voteExpiryBuckets: 30 });
    const gate = makeGossipGate({
        decodeWinnerCids,
        fetchNode: (cid) => store.get(cid),
        verifier: okVerifier,
        cache: makeVerdictCache(),
        merge: (h) => crdt.merge(h),
        limit: (fn) => fn(),
        allowPeer: () => true,
        bounds: { maxWinnerCidsPerMessage: 16, maxMessageBytes: 1 << 20 },
        timeoutMs: 5000
    });
    const transport = makeVoteTransport({
        pubsub,
        topic: TOPIC,
        gate,
        encodeWinnerCids,
        decodeWinnerCids,
        getWinnerCids: () => crdt.winnerCids(0)
    });
    const bundle: VotesBundle = { address: "0x1", votes: [{ board: { publicKey: KEY_A }, vote: 1 }], blockNumber: 1, signature: { signature: "0x", type: "eip712" } };
    const cid = await store.put(bundle);
    return { transport, topicValidators, published, subscribed, crdt, cid };
}

describe("makeVoteTransport", () => {
    it("installs the gate validator and subscribes on start", async () => {
        const h = await harness();
        await h.transport.start();
        expect(h.topicValidators.has(TOPIC)).toBe(true);
        expect(h.subscribed.has(TOPIC)).toBe(true);
    });

    it("accepts a valid message through the installed validator and merges it", async () => {
        const h = await harness();
        const heardCids: CID[] = [];
        h.transport.onWinnerCids((cids) => heardCids.push(...cids));
        await h.transport.start();

        const validator = h.topicValidators.get(TOPIC)!;
        const verdict = await validator(fakePeer("peer1"), { topic: TOPIC, data: encodeWinnerCids([h.cid]), from: fakePeer("peer1") });

        expect(verdict).toBe("accept");
        expect(h.crdt.current(0)).toHaveLength(1);
        expect(heardCids[0].equals(h.cid)).toBe(true);
    });

    it("ignores a message on a different topic", async () => {
        const h = await harness();
        await h.transport.start();
        const validator = h.topicValidators.get(TOPIC)!;
        const verdict = await validator(fakePeer("peer1"), { topic: "other-topic", data: encodeWinnerCids([h.cid]), from: fakePeer("peer1") });
        expect(verdict).toBe("ignore");
    });

    it("broadcasts encoded winner CIDs to the topic", async () => {
        const h = await harness();
        await h.transport.broadcastWinnerCids([h.cid]);
        expect(h.published).toHaveLength(1);
        expect(h.published[0].topic).toBe(TOPIC);
        expect(decodeWinnerCids(h.published[0].data)[0].equals(h.cid)).toBe(true);
    });

    it("removes the validator and unsubscribes on stop", async () => {
        const h = await harness();
        await h.transport.start();
        await h.transport.stop();
        expect(h.topicValidators.has(TOPIC)).toBe(false);
        expect(h.subscribed.has(TOPIC)).toBe(false);
    });
});
