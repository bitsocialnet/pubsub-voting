import pLimit from "p-limit";
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { fetch as fetchService } from "@libp2p/fetch";
import { createHelia, type Helia } from "helia";
import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../../schema/votes.js";
import type { BundleVerdict, BundleVerifier } from "../../verify/types.js";
import { makeBlockstoreBundleStore } from "../bundle-store.js";
import { adaptBlockstore } from "../helia.js";
import { makeVoteCrdt } from "../../crdt/crdt.js";
import type { VoteCrdt } from "../../crdt/types.js";
import { makeBucketMath } from "../../chain/bucket.js";
import { makeVerdictCache, type VerdictCache } from "../../verify/cache.js";
import { encodeBundle, decodeBundle, bundleCidForBytes } from "../../crdt/codec.js";
import { encodeCheckpoint } from "../../checkpoint/codec.js";
import { makeGossipGate } from "../gossip-validator.js";
import { makeRootChaser, type RootChaser } from "../chase.js";
import { makeVoteTransport } from "../transport.js";
import type { PubsubService, VoteTransport } from "../types.js";
import {
    decodeVoteMessage,
    maxBundleMessageBytes,
    MAX_ROOT_MESSAGE_BYTES,
    ROOT_RECORD_VERSION,
    type RootRecord
} from "../messages.js";

/**
 * Test harness for the two-node gossipsub integration test. It stands up ONE real libp2p +
 * Helia node carrying `@libp2p/gossipsub` (>= 15.0.23, the CVE-2026-46679 floor) and
 * `@libp2p/fetch`, and wires the SAME forward-gate / chaser / transport the production client
 * assembles in `src/client/voter.ts` `start()` — the only differences are test seams: an
 * injectable verifier (so a test can force a reject or a slow verify) and a small `timeoutMs`.
 * No production `src/` code is modified; this reuses `makeGossipGate` / `makeRootChaser` /
 * `makeVoteTransport` verbatim.
 *
 * What only a real node can prove (and a fake pubsub cannot): gossipsub actually forwards an
 * accepted message and drops a rejected one, peer scores move on a `reject`, a validation past
 * the deadline yields `ignore` with no penalty, a converged pair stays quiet, and a divergent
 * root pulls the checkpoint blocks over real bitswap.
 */

/** Every bundle in the test is dated to a small block; reads use bucket 0 (never expired). */
const CURRENT_BUCKET = 0;
const BLOCKS_PER_BUCKET = 43_200;
const VOTE_EXPIRY_BUCKETS = 30;

/** A permissive default verifier; individual tests swap it via {@link VoteNode.setVerifier}. */
const okVerifier = (): BundleVerdict => ({ valid: true, ruleScore: 1n, resolvedNames: {} });

/** The gossipsub peer-score methods used for assertions — on the concrete class, not the interface. */
interface ScoreOps {
    getScore(peer: string): number;
    getMeshPeers(topic: string): string[];
}

export interface VoteNodeOptions {
    /** Per-message validation deadline (ms). Small values let a test force the deadline path. */
    timeoutMs?: number;
}

export interface VoteNode {
    readonly helia: Helia;
    readonly libp2p: Libp2p;
    /** The gossipsub service, plus the score/mesh introspection the assertions read. */
    readonly pubsub: PubsubService & ScoreOps;
    readonly peerId: string;
    readonly topic: string;
    readonly crdt: VoteCrdt;
    readonly cache: VerdictCache;
    readonly chaser: RootChaser;
    readonly transport: VoteTransport;
    /** Bundle-kind messages this node ACCEPTED (delivered post-validation ⇒ it would forward them). */
    readonly acceptedBundles: Uint8Array[];
    /** Root records this node heard through the gate. */
    readonly heardRoots: RootRecord[];
    /** True once a heard root matched this node's own current root (heartbeat suppression signal). */
    heardMatchingRoot(): boolean;
    /** Replace the injected verifier (e.g. a rejecter, or a slow one, for a specific assertion). */
    setVerifier(verify: (bundle: VotesBundle) => Promise<BundleVerdict>): void;
    /** Encode this node's current winner-set to a checkpoint (blocks written to its blockstore). */
    checkpointRootRecord(): Promise<RootRecord>;
    /** Publish this node's own root record on the topic (a heartbeat). */
    publishOwnRoot(): Promise<void>;
    /** Seed a bundle straight into this node's state (store block + CRDT merge), no network. */
    admitBundle(bundle: VotesBundle): Promise<void>;
    stop(): Promise<void>;
}

/** Build one real node with the full forward-gate wired to real gossipsub. */
export async function makeVoteNode(topic: string, options: VoteNodeOptions = {}): Promise<VoteNode> {
    const timeoutMs = options.timeoutMs ?? 10_000;

    const libp2p = await createLibp2p({
        addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            fetch: fetchService(),
            pubsub: gossipsub({
                allowPublishToZeroTopicPeers: true,
                heartbeatInterval: 300,
                // Isolate the invalid-message penalty (P₄) as the only score signal so a reject is
                // crisply observable and an `ignore` provably moves nothing. Positive/mesh weights
                // are zeroed; IP-colocation is disabled because both nodes share 127.0.0.1.
                scoreParams: {
                    IPColocationFactorWeight: 0,
                    appSpecificScore: () => 0,
                    topics: {
                        [topic]: {
                            topicWeight: 1,
                            timeInMeshWeight: 0,
                            timeInMeshQuantum: 1_000,
                            timeInMeshCap: 1,
                            firstMessageDeliveriesWeight: 0,
                            firstMessageDeliveriesDecay: 0.5,
                            firstMessageDeliveriesCap: 100,
                            meshMessageDeliveriesWeight: 0,
                            meshMessageDeliveriesDecay: 0.5,
                            meshMessageDeliveriesCap: 100,
                            meshMessageDeliveriesThreshold: 1,
                            meshMessageDeliveriesWindow: 10,
                            meshMessageDeliveriesActivation: 5_000,
                            meshFailurePenaltyWeight: 0,
                            meshFailurePenaltyDecay: 0.5,
                            // One invalid delivery ⇒ score −50: clearly negative, below the publish
                            // threshold, but above the −80 graylist so the peer is not disconnected
                            // mid-assertion.
                            invalidMessageDeliveriesWeight: -50,
                            invalidMessageDeliveriesDecay: 0.9
                        }
                    }
                }
            })
        }
    });
    const helia = await createHelia({ libp2p });

    const pubsub = libp2p.services.pubsub as unknown as PubsubService & ScoreOps;
    // Adapt Helia's async-generator `get` to the library's Promise-returning BlockstoreLike, the
    // same bridge `requireHeliaServices` applies to an injected host node.
    const blockstore = adaptBlockstore(helia.blockstore as never);
    const store = makeBlockstoreBundleStore(blockstore);
    const crdt = makeVoteCrdt({
        store,
        bucketMath: makeBucketMath(BLOCKS_PER_BUCKET),
        voteExpiryBuckets: VOTE_EXPIRY_BUCKETS
    });
    const cache = makeVerdictCache();

    // The injected verifier, swappable per test. The gate and the chaser share this reference.
    // The chaser's offline stage runs the same swapped implementation, so a test that makes the
    // verifier fail still sees the chase drop the bundle BEFORE admit (the two-node assertions
    // pin admission, not which stage deferred — deferred checks are unit-tested in
    // verify/background.test.ts).
    let verifyImpl: (bundle: VotesBundle) => Promise<BundleVerdict> = async () => okVerifier();
    const verifier: BundleVerifier = {
        verify: (bundle) => verifyImpl(bundle),
        verifyOffline: (bundle) => verifyImpl(bundle)
    };

    const admit = async ({ cid, bytes }: { cid: CID; bytes: Uint8Array; bundle: VotesBundle }): Promise<void> => {
        await blockstore.put(cid, bytes);
        await crdt.merge([cid]);
    };

    const acceptedBundles: Uint8Array[] = [];
    const heardRoots: RootRecord[] = [];
    let matchedOwnRoot = false;

    async function checkpointRootRecord(): Promise<RootRecord> {
        const winners = crdt.current(CURRENT_BUCKET);
        const { root, blocks } = await encodeCheckpoint(winners);
        for (const block of blocks) await blockstore.put(block.cid, block.bytes);
        return {
            version: ROOT_RECORD_VERSION,
            root,
            count: winners.length,
            sizeBytes: blocks.reduce((total, block) => total + block.bytes.length, 0)
        };
    }

    const chaseLimit = pLimit(2);
    const chaser = makeRootChaser({
        getBlock: async (cid, signal) => {
            try {
                return await blockstore.get(cid, { signal });
            } catch {
                return undefined;
            }
        },
        verifyOffline: (bundle) => verifier.verifyOffline(bundle),
        cache,
        hasBundle: (cid) => store.has(cid),
        admit,
        // The harness runs the whole swapped pipeline in `verifyOffline` above, so nothing is
        // left deferred; the background verifier has its own unit tests.
        deferVerify: () => {},
        limit: (fn) => chaseLimit(fn),
        timeoutMs: 30_000
    });

    const gateLimit = pLimit(8);
    const gate = makeGossipGate({
        decodeMessage: decodeVoteMessage,
        parseBundle: async (blockBytes) => ({
            cid: await bundleCidForBytes(blockBytes),
            bundle: decodeBundle(blockBytes)
        }),
        verifier,
        cache,
        admit,
        limit: (fn) => gateLimit(fn),
        allowBundlePeer: () => true,
        allowRootPeer: () => true,
        onAccept: (_cid, _bundle, _from) => {},
        // Mirror `PubsubVoter.#handleRootRecord`: a matching root is the suppression signal (no
        // chase, no echo); a divergent root is chased over directed bitswap.
        onRootRecord: (record) => {
            heardRoots.push(record);
            void (async () => {
                const own = await checkpointRootRecord();
                if (own.root.equals(record.root)) {
                    matchedOwnRoot = true;
                    return;
                }
                chaser.chase(record.root);
            })().catch(() => {});
        },
        maxBundleMessageBytes: maxBundleMessageBytes({ maxVotesPerAddress: 1 }),
        maxRootMessageBytes: MAX_ROOT_MESSAGE_BYTES,
        timeoutMs
    });

    const transport = makeVoteTransport({ pubsub, topic, gate });
    await transport.start();

    // Record every ACCEPTED message. gossipsub emits "message" only after the topic validator
    // returns accept, so a delivered bundle is one this node forwarded — and a rejected/ignored
    // one never appears here. This is the observable for the forward / no-forward assertions.
    pubsub.addEventListener("message", (evt) => {
        if (evt.detail.topic !== topic) return;
        try {
            const message = decodeVoteMessage(evt.detail.data);
            if (message.kind === "bundle") acceptedBundles.push(message.bundle);
        } catch {
            // A delivered message always decodes (it passed the gate); ignore anything else.
        }
    });

    return {
        helia,
        libp2p,
        pubsub,
        peerId: libp2p.peerId.toString(),
        topic,
        crdt,
        cache,
        chaser,
        transport,
        acceptedBundles,
        heardRoots,
        heardMatchingRoot: () => matchedOwnRoot,
        setVerifier: (verify) => {
            verifyImpl = verify;
        },
        checkpointRootRecord,
        publishOwnRoot: async () => {
            await transport.publishRootRecord(await checkpointRootRecord());
        },
        admitBundle: async (bundle) => {
            const bytes = encodeBundle(bundle);
            const cid = await bundleCidForBytes(bytes);
            await blockstore.put(cid, bytes);
            await crdt.merge([cid]);
        },
        stop: async () => {
            await transport.stop();
            await helia.stop();
        }
    };
}

/**
 * Dial `b` from `a` and wait until gossipsub has grafted them into each other's mesh for
 * `topic` — after which a publish is reliably delivered (so negative assertions like "not
 * forwarded" are meaningful, not just races against an unformed mesh).
 */
export async function connectNodes(a: VoteNode, b: VoteNode): Promise<void> {
    await a.libp2p.dial(b.libp2p.getMultiaddrs());
    await waitFor(
        () => a.pubsub.getMeshPeers(a.topic).includes(b.peerId) && b.pubsub.getMeshPeers(b.topic).includes(a.peerId),
        15_000,
        "gossipsub mesh to form between the two nodes"
    );
}

/** Poll `predicate` until it is truthy or `timeoutMs` elapses (then throw with `description`). */
export async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 15_000,
    description = "condition"
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
        await delay(50);
    }
}

/** Resolve after `ms`; used only to space out polls, never as an observation substitute. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A well-formed one-vote bundle. The signature is a well-formed 65 bytes; validity is the verifier's job. */
export function sampleBundle(address: string, publicKey: string, blockNumber = 10): VotesBundle {
    return {
        address,
        votes: [{ community: { publicKey }, vote: 1 }],
        blockNumber,
        signature: { signature: `0x${"11".repeat(65)}`, type: "eip712" }
    };
}
