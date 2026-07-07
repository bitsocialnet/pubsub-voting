import { describe, it, expect } from "vitest";
import type { PeerId } from "@libp2p/interface";
import { makeVoteTransport } from "./transport.js";
import { makeGossipGate } from "./gossip-validator.js";
import {
    decodeVoteMessage,
    encodeBundleMessage,
    MAX_ROOT_MESSAGE_BYTES,
    ROOT_RECORD_VERSION,
    type RootRecord
} from "./messages.js";
import type { PubsubService, GossipTopicValidator } from "./types.js";
import { makeMemoryBundleStore } from "../crdt/store.js";
import { makeVoteCrdt } from "../crdt/crdt.js";
import { makeVerdictCache } from "../verify/cache.js";
import { makeBucketMath } from "../chain/bucket.js";
import { encodeBundle, decodeBundle, bundleCid, bundleCidForBytes } from "../crdt/codec.js";
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
    const rootRecords: Array<[RootRecord, string]> = [];
    const gate = makeGossipGate({
        decodeMessage: decodeVoteMessage,
        parseBundle: async (blockBytes) => ({ cid: await bundleCidForBytes(blockBytes), bundle: decodeBundle(blockBytes) }),
        verifier: okVerifier,
        cache: makeVerdictCache(),
        admit: async ({ bundle }) => {
            await crdt.add(bundle);
        },
        limit: (fn) => fn(),
        allowBundlePeer: () => true,
        allowRootPeer: () => true,
        onRootRecord: (record, from) => rootRecords.push([record, from]),
        maxBundleMessageBytes: 4096,
        maxRootMessageBytes: MAX_ROOT_MESSAGE_BYTES,
        timeoutMs: 5000
    });
    const transport = makeVoteTransport({ pubsub, topic: TOPIC, gate });
    const bundle: VotesBundle = {
        address: `0x${"1".padStart(40, "0")}`,
        votes: [{ community: { publicKey: KEY_A }, vote: 1 }],
        blockNumber: 1,
        signature: { signature: `0x${"11".repeat(65)}`, type: "eip712" }
    };
    return { transport, topicValidators, published, subscribed, crdt, bundle, rootRecords };
}

describe("makeVoteTransport", () => {
    it("installs the gate validator and subscribes on start", async () => {
        const h = await harness();
        await h.transport.start();
        expect(h.topicValidators.has(TOPIC)).toBe(true);
        expect(h.subscribed.has(TOPIC)).toBe(true);
    });

    it("accepts a valid inline bundle through the installed validator and merges it", async () => {
        const h = await harness();
        await h.transport.start();

        const validator = h.topicValidators.get(TOPIC)!;
        const data = encodeBundleMessage(encodeBundle(h.bundle));
        const verdict = await validator(fakePeer("peer1"), { topic: TOPIC, data, from: fakePeer("peer1") });

        expect(verdict).toBe("accept");
        expect(h.crdt.current(0)).toHaveLength(1);
    });

    it("ignores a message on a different topic", async () => {
        const h = await harness();
        await h.transport.start();
        const validator = h.topicValidators.get(TOPIC)!;
        const data = encodeBundleMessage(encodeBundle(h.bundle));
        const verdict = await validator(fakePeer("peer1"), { topic: "other-topic", data, from: fakePeer("peer1") });
        expect(verdict).toBe("ignore");
    });

    it("publishes a bundle as an inline live delta", async () => {
        const h = await harness();
        await h.transport.publishBundle(encodeBundle(h.bundle));
        expect(h.published).toHaveLength(1);
        expect(h.published[0].topic).toBe(TOPIC);
        const message = decodeVoteMessage(h.published[0].data);
        expect(message.kind).toBe("bundle");
        if (message.kind === "bundle") expect(decodeBundle(message.bundle)).toEqual(h.bundle);
    });

    it("publishes a root record and surfaces a received one through the gate", async () => {
        const h = await harness();
        await h.transport.start();
        const record: RootRecord = { version: ROOT_RECORD_VERSION, root: await bundleCid(h.bundle), count: 1, sizeBytes: 200 };

        await h.transport.publishRootRecord(record);
        expect(h.published).toHaveLength(1);
        const message = decodeVoteMessage(h.published[0].data);
        expect(message.kind).toBe("root");
        if (message.kind === "root") expect(message.record.root.equals(record.root)).toBe(true);

        // Loop the published heartbeat back through the installed validator: forwarded + surfaced.
        const validator = h.topicValidators.get(TOPIC)!;
        const verdict = await validator(fakePeer("peer2"), { topic: TOPIC, data: h.published[0].data, from: fakePeer("peer2") });
        expect(verdict).toBe("accept");
        expect(h.rootRecords).toHaveLength(1);
        expect(h.rootRecords[0][1]).toBe("peer2");
    });

    it("removes the validator and unsubscribes on stop", async () => {
        const h = await harness();
        await h.transport.start();
        await h.transport.stop();
        expect(h.topicValidators.has(TOPIC)).toBe(false);
        expect(h.subscribed.has(TOPIC)).toBe(false);
    });
});
