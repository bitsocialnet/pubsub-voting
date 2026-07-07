import pLimit from "p-limit";
import type { Criteria } from "../schema/criteria.js";
import { VotesBundleSchema, type Vote, type VotesBundle } from "../schema/votes.js";
import type { ChainClient, ChainClientFactory, ChainClients, NameResolver } from "../chain/types.js";
import { makeBucketMath } from "../chain/bucket.js";
import { tickerForRef } from "../chain/ticker.js";
import type { BlockstoreLike, HeliaInstance, PubsubService, VoteTransport } from "../transport/types.js";
import { requireHeliaServices } from "../transport/helia.js";
import { makeBlockstoreBundleStore } from "../transport/bundle-store.js";
import { makeRateLimiter } from "../transport/rate-limit.js";
import { makeGossipGate } from "../transport/gossip-validator.js";
import { makeVoteTransport } from "../transport/transport.js";
import {
    decodeVoteMessage,
    maxBundleMessageBytes,
    MAX_ROOT_MESSAGE_BYTES,
    ROOT_RECORD_VERSION,
    type RootRecord
} from "../transport/messages.js";
import { makeRootChaser, type RootChaser } from "../transport/chase.js";
import { encodeBundle, decodeBundle, bundleCidForBytes } from "../crdt/codec.js";
import type { RuleRegistry } from "../rules/types.js";
import { resolveRegistry, validateCriteriaRules } from "../rules/registry.js";
import { makeVoteCrdt } from "../crdt/crdt.js";
import type { VoteCrdt } from "../crdt/types.js";
import { makeBundleVerifier } from "../verify/bundle.js";
import { makeVerdictCache } from "../verify/cache.js";
import { makeGateResultCache } from "../verify/gate-result-cache.js";
import { makeAcceptedDedup } from "../transport/accepted-dedup.js";
import { encodeCheckpoint } from "../checkpoint/codec.js";
import type { CID } from "multiformats/cid";
import { makeTally } from "../tally/tally.js";
import type { ContestTally, TallyOptions } from "../tally/types.js";
import type { VoteSigner } from "../signer/types.js";
import { ballotTypedData } from "../signer/eip712.js";
import { criteriaCid, TOPIC_PREFIX } from "../topic.js";
import { deriveCriteria } from "../manifest/manifest.js";
import type { VoteStore } from "../store/types.js";
import { selectVoteStore } from "../store/select.js";
import {
    DuplicateContestIdError,
    MissingManifestError,
    ReadOnlyError,
    UnknownContestError,
    UnknownRuleError
} from "../errors.js";

/**
 * How often to republish a live vote, in buckets: half its expiry window, rounded up. A
 * bundle is valid for `voteExpiryBuckets` after its `blockNumber` (see DESIGN.md "Passive
 * expiry"), so re-signing at the halfway point leaves one full missed cycle of slack before
 * the vote decays. Derived per-contest from the criteria — there is no global interval.
 */
export function republishIntervalBuckets(criteria: Criteria): number {
    return Math.ceil(criteria.voteExpiryBuckets / 2);
}

/**
 * Default wall-clock poll interval (ms) for the republish scheduler. The liveness cadence
 * ({@link republishIntervalBuckets}) is measured in *buckets* (block counts) and the criteria
 * carries no block-time, so the scheduler cannot arm a timer that fires exactly one cadence
 * later. Instead it polls on this wall-clock interval and re-signs any intent whose bucket
 * cadence is due (see `ContestNetwork.republishIfDue`). Buckets are large (day-scale in the
 * 5chan example) and the cadence spans many of them, so a coarse poll still detects due-ness
 * well within the half-window slack; hosts tune it via `republishPollIntervalMs`.
 */
export const DEFAULT_REPUBLISH_POLL_MS = 600_000;

/**
 * Public facade.
 *
 * Two objects, mirroring the data model:
 *   - `VoteClient` (PubsubVoter): holds the host-injected dependencies once and mints
 *     one `VoteNetwork` per contest. This is what a host like 5chan touches — it has
 *     63 directory slots = 63 contests = 63 topics derived from one manifest, and it
 *     should not wire dependencies 63 times.
 *   - `VoteNetwork`: one contest (one topic). Join, sync, cast, read the tally.
 *
 * The injected seams (helia, chains, signer, nameResolvers) are the ONLY host contact
 * surface, so the same core runs under pkc-js, plebbit, or a raw node. The host passes
 * its running Helia node directly — no adapter — and the library drives that node's
 * gossipsub service and blockstore itself. A voter built without a `signer` is read-only.
 */

/** One contest's network: join the topic, keep the CRDT in sync, cast votes, read the tally. */
export interface VoteNetwork {
    /** The criteria document this contest runs (already validated). */
    readonly criteria: Criteria;
    /** The gossipsub topic = "bitsocial-votes/" + CID(dag-cbor(criteria)). */
    readonly topic: string;
    /** True when no signer was provided: tallies readable, voting disabled. */
    readonly readOnly: boolean;

    /** Join the topic behind the validate-before-forward gate and subscribe to gossip. */
    start(): Promise<void>;
    /** Leave the topic and release the transport. Does not stop the host node. */
    stop(): Promise<void>;

    /**
     * Sign the given votes into a bundle for the current bucket, add it to the CRDT, and
     * publish it inline as a live delta. Pass an empty array to withdraw: a newer empty bundle
     * supersedes the prior one under LWW, and the scheduler re-publishes that tombstone (without
     * re-signing it) until it expires, then drops it. Throws `ReadOnlyError` with no signer.
     */
    castVotes(votes: Vote[]): Promise<VotesBundle>;

    /**
     * Stop keeping this wallet's vote in this contest alive — drop the stored intent so the
     * scheduler stops re-signing it and the vote decays at its own expiry (passive withdrawal;
     * publishes nothing, unlike `castVotes([])` which actively supersedes). Idempotent.
     */
    forget(): Promise<void>;

    /** Current contest ranking, verified lazily top-down. */
    getTally(options?: TallyOptions): Promise<ContestTally>;

    /** Fired when incoming votes change the state. */
    on(event: "update", cb: () => void): void;
}

/** Manager: one set of injected dependencies, many contests. */
export interface VoteClient {
    /** True when constructed without a signer: every contest is read-only. */
    readonly readOnly: boolean;
    /** The `contestId`s of every contest in this voter's manifest, in manifest order. */
    readonly contestIds: readonly string[];
    /**
     * Get (or create and cache) the network for one contest by its `contestId`. The id must
     * name a contest in this voter's manifest, else `UnknownContestError`. Networks cache by
     * topic, so repeated calls for the same contest return the same object.
     */
    getContest(args: { contestId: string }): Promise<VoteNetwork>;
    /**
     * Stop keeping this wallet's vote in one contest alive: drop its stored intent so the
     * scheduler stops re-signing it and the vote decays at its own expiry (passive withdrawal;
     * publishes nothing, unlike `castVotes([])` which actively supersedes). The `contestId` must
     * name a contest in this voter's manifest, else `UnknownContestError`. Idempotent.
     */
    forget(args: { contestId: string }): Promise<void>;
    /**
     * Join every contest in the constructor `manifest`, start each network, and arm the
     * republish scheduler that keeps this wallet's own votes alive by re-signing them with a
     * fresh `blockNumber` on the liveness cadence (`ceil(voteExpiryBuckets / 2)` buckets per
     * contest). Idempotent to the extent contests cache by topic.
     */
    start(): Promise<void>;
    /** Stop the republish scheduler and leave every topic. The client stays reusable. */
    stop(): Promise<void>;
    /** Stop every contest this client started. */
    stopAll(): Promise<void>;
    /**
     * Full teardown: stop the republish scheduler, leave every topic, and dispose the vote
     * store (release its DB/file handles). Use when discarding the voter; unlike `stop`,
     * the store is closed, so the client is not meant to be reused after `destroy`.
     */
    destroy(): Promise<void>;
}

/** Construction options for {@link PubsubVoter}. */
export interface PubsubVoterOptions {
    /**
     * The host's running Helia node (the value `createHelia` returns; for pkc-js it is
     * `pkc.clients.libp2pJsClients[key]._helia`). The only host-node seam, passed
     * directly with no adapter. It MUST carry a gossipsub service at
     * `libp2p.services.pubsub` and a usable `blockstore`; the constructor throws
     * `MissingPubsubError` / `MissingBlockstoreError` otherwise (a plain Helia node has
     * no pubsub). The library never starts or stops this node.
     */
    helia: HeliaInstance;
    /**
     * Builds a chain client from a `{ chain, config }` pair. Each contest builds its
     * own clients from `criteria.requires.chains` via this factory, so chains are
     * per-contest data, not a global injection.
     */
    chains: ChainClientFactory;
    /** Identity. Omit for a read-only voter (renders tallies, cannot cast). */
    signer?: VoteSigner;
    /**
     * The 5chan-style directory manifest this voter owns. Required in v1: the voter derives
     * every contest from it (via `deriveCriteria`) at construction, addresses each by its
     * unique `contestId` (`getContest`), and keeps them all republished under one lifecycle.
     * Its `contestId`s MUST be unique — a duplicate throws `DuplicateContestIdError` at
     * construction — and a missing/invalid manifest throws `MissingManifestError`.
     */
    manifest: unknown;
    /**
     * Directory for the voter's persistence, Node only — the same `dataPath` convention
     * pkc-js and `@bitsocial/bso-resolver` use. When set, the Node backend keeps this
     * wallet's vote intents in a SQLite file inside this directory, so republishing survives
     * a restart (see DESIGN.md "Persistence"). Ignored in the browser, which uses IndexedDB.
     * Optional: with no `dataPath` on Node, persistence is in-memory (lost on restart).
     */
    dataPath?: string;
    /** Rule overrides that shadow built-ins by `type` (a flat `type -> rule` map). */
    rules?: RuleRegistry;
    /**
     * Community-name resolvers, same instances a host gives pkc-js (e.g.
     * `@bitsocial/bso-resolver` for `name.bso`). The tally resolves each vote's
     * `community.name` claim through the first resolver whose `canResolve` matches and
     * drops bundles whose name does not resolve to the claimed `publicKey`. Omit only
     * if no contest's votes carry names — with no resolver for a carried name's TLD,
     * the claim cannot be verified and the bundle is dropped (never counted unchecked).
     */
    nameResolvers?: NameResolver[];
    /**
     * Wall-clock interval (ms) at which the republish scheduler polls each contest to re-sign
     * this wallet's stored vote on the liveness cadence. Defaults to
     * {@link DEFAULT_REPUBLISH_POLL_MS}. The cadence itself is bucket-based and per-contest
     * (`ceil(voteExpiryBuckets / 2)`); this only sets how often the scheduler checks whether a
     * contest is due. Lower it to react faster (at more RPC head reads); tests use a tiny value
     * with fake timers. Ignored on a read-only voter (no signer ⇒ nothing to republish).
     */
    republishPollIntervalMs?: number;
}

interface ResolvedDeps {
    helia: HeliaInstance;
    /** The node's gossipsub service, validated once at construction. */
    pubsub: PubsubService;
    /** The node's blockstore, validated once at construction. */
    blockstore: BlockstoreLike;
    chains: ChainClientFactory;
    signer: VoteSigner | undefined;
    /** Built-ins with any host overrides merged in (overrides shadow by `type`). */
    registry: RuleRegistry;
    /** Community-name resolvers for verifying `community.name` claims at tally time. */
    nameResolvers: NameResolver[];
    /** Persistence for this voter's own vote intents (in-memory unless a host injects one). */
    store: VoteStore;
}

/** Hard per-message validation deadline (ms): the 10s budget for the verify pipeline in the gate. */
const GATE_TIMEOUT_MS = 10_000;
/** Concurrent in-flight verifications across the gate (chain reads + name resolution are RPC). */
const GATE_CONCURRENCY = 8;
/** Per-peer rate window for bundle-kind messages: how many one peer may make us validate per interval. */
const GATE_RATE = { limit: 256, intervalMs: 10_000 };
/**
 * Per-peer rate window for root-kind messages. An honest heartbeat is ~1 per 10 minutes (plus a
 * divergence response), so 4/min is ≫ any honest rate while flattening a root spray.
 */
const GATE_ROOT_RATE = { limit: 4, intervalMs: 60_000 };
/**
 * Root-record heartbeat interval (ms): 10 minutes — the IPNS-over-pubsub rebroadcast default
 * (`go-libp2p-pubsub-router`) — jittered ±25% per firing, with suppression on top (skip when a
 * matching root was heard this interval) so a converged topic stays near-silent. See DESIGN.md
 * "Checkpoints" and "Transport constants (v1)".
 */
const HEARTBEAT_INTERVAL_MS = 600_000;
/** Per-root chase deadline (ms): a multi-block directed-bitswap pull, coarser than one message. */
const CHASE_TIMEOUT_MS = 30_000;
/** Concurrent root chases; a spray of divergent roots queues, never floods. */
const CHASE_CONCURRENCY = 2;
/**
 * How long a gating-chain head read stays fresh (ms) for the gate's freshness guard. Steady-
 * state votes cost no read (they resolve against the cached bucket); only a look-ahead bundle
 * consults the head, and this TTL caps that to ≤1 `getBlockNumber` per window under a flood of
 * future-dated bundles.
 */
const HEAD_BUCKET_TTL_MS = 1_000;

/** Lowercase `0x`-hex to bytes (for the bucket boundary block hash). */
function hexToBytes(hex: string): Uint8Array {
    const body = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** One contest: joins the topic behind the validate-before-forward gate, reads the tally, casts votes. */
class ContestNetwork implements VoteNetwork {
    readonly criteria: Criteria;
    readonly topic: string;
    readonly readOnly: boolean;

    readonly #deps: ResolvedDeps;
    /** Chain clients for this contest, built from `criteria.requires.chains` via the factory. */
    readonly #chainClients: ChainClients;
    readonly #updateListeners: Array<() => void> = [];

    readonly #criteriaCid: Uint8Array;
    /** The gating (`rule`) chain's numeric chainId, bound into every ballot signature. */
    readonly #chainId: number;
    /** The gating (`rule`) chain client, also the seed chain for the tally's tie-break block hash. */
    readonly #ruleChain: ChainClient;
    readonly #bucketMath: ReturnType<typeof makeBucketMath>;
    readonly #crdt: VoteCrdt;
    readonly #tally: ReturnType<typeof makeTally>;
    /** Live once `start()` runs; the gate + gossip wiring for this topic. */
    #transport: VoteTransport | undefined;
    /**
     * Last-known current bucket on the gating chain, refreshed by {@link #refreshBucket} on
     * every chain read the network already does (start, cast, tally). The CRDT's read-time
     * expiry filter (`current`) reads it, so decayed votes drop without a per-read chain call.
     * Coarse-stale is fine — buckets are large.
     */
    #currentBucketCache = 0;
    /**
     * Bucket of the last tombstone re-announce (or the withdrawal itself), so a live
     * empty-votes withdrawal is re-published on the liveness cadence — not every poll tick —
     * to reach peers that missed its one-shot flood. In-memory only: `undefined` means "due
     * now" (so a restart re-announces a still-live tombstone once, then rides the cadence).
     * Re-announcing re-publishes the *existing* bundle bytes; it never re-signs (see
     * {@link republishIfDue}). See DESIGN.md "Cancelling a vote".
     */
    #lastTombstoneAnnounceBucket: number | undefined = undefined;
    /**
     * The on-demand checkpoint cache: the last encoded root record and the bucket it was encoded
     * at. Invalidated by {@link #markStateChanged} (any merge/cast/chase admit) and by a bucket
     * advance (expiry changes the winner set without any message). See DESIGN.md "Checkpoints",
     * "On-demand encode".
     */
    #rootRecordCache: { record: RootRecord; bucket: number } | undefined = undefined;
    /** True when the winner-set changed since the last encode; the next `rootRecord()` re-encodes. */
    #checkpointDirty = true;
    /** Live once `start()` runs; chases advertised roots that differ from our own. */
    #chaser: RootChaser | undefined;
    /** The armed heartbeat timer (jittered; see {@link #armHeartbeat}), cleared by `stop()`. */
    #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    /** True when a heartbeat matching our own root was heard this interval (suppression). */
    #heardMatchingRoot = false;
    /** True once we published our record this interval (heartbeat OR divergence response). */
    #publishedRootThisInterval = false;

    constructor(criteria: Criteria, topic: string, criteriaCidBytes: Uint8Array, deps: ResolvedDeps) {
        this.criteria = criteria;
        this.topic = topic;
        this.readOnly = deps.signer === undefined;
        this.#deps = deps;
        this.#criteriaCid = criteriaCidBytes;
        this.#chainClients = Object.fromEntries(
            Object.entries(criteria.requires.chains).map(
                ([chain, config]): [string, ChainClient] => [chain, deps.chains({ chain, config })]
            )
        );

        // The gating (`rule`) chain fixes the ballot's chainId and the tie-break seed chain.
        const rule = deps.registry[criteria.rule.type];
        if (!rule) throw new UnknownRuleError("rule", criteria.rule.type);
        const ruleTicker = tickerForRef(criteria, criteria.rule, rule.optionsSchema.parse(criteria.rule));
        const ruleChain = this.#chainClients[ruleTicker];
        if (!ruleChain) throw new Error(`no chain client for gating (\`rule\`) chain "${ruleTicker}"`);
        this.#ruleChain = ruleChain;
        this.#chainId = criteria.requires.chains[ruleTicker]!.chainId;

        this.#bucketMath = makeBucketMath(criteria.blocksPerBucket);
        const store = makeBlockstoreBundleStore(deps.blockstore);
        this.#crdt = makeVoteCrdt({ store, bucketMath: this.#bucketMath, voteExpiryBuckets: criteria.voteExpiryBuckets });

        const verifier = makeBundleVerifier({
            criteria,
            criteriaCid: criteriaCidBytes,
            chainId: this.#chainId,
            registry: deps.registry,
            chainFor: (ticker) => this.#chainFor(ticker),
            bucketMath: this.#bucketMath,
            nameResolvers: deps.nameResolvers,
            gateResultCache: makeGateResultCache()
        });
        // The gate/transport are (re)built in start(); the store, crdt, caches, and verifier are
        // stable per contest, so they survive restarts of the topic.
        this.#store = store;
        this.#cache = makeVerdictCache();
        this.#acceptedDedup = makeAcceptedDedup(this.#bucketMath);
        this.#verifier = verifier;

        this.#tally = makeTally({
            criteria,
            registry: deps.registry,
            chainFor: (ticker) => this.#chainFor(ticker),
            bucketMath: this.#bucketMath,
            current: () => this.#crdt.current(this.#currentBucketCache),
            bucketBlockHash: () => this.#bucketBlockHash()
        });
    }

    readonly #store: ReturnType<typeof makeBlockstoreBundleStore>;
    readonly #cache: ReturnType<typeof makeVerdictCache>;
    readonly #acceptedDedup: ReturnType<typeof makeAcceptedDedup>;
    readonly #verifier: ReturnType<typeof makeBundleVerifier>;

    #chainFor(ticker: string): ChainClient {
        const client = this.#chainClients[ticker];
        if (!client) throw new Error(`no chain client configured for chain "${ticker}"`);
        return client;
    }

    /** Read the gating-chain head and update {@link #currentBucketCache}; returns the bucket. */
    async #refreshBucket(): Promise<number> {
        const head = await this.#ruleChain.getBlockNumber();
        this.#currentBucketCache = this.#bucketMath.bucketForBlock(Number(head));
        this.#headReadMs = Date.now();
        return this.#currentBucketCache;
    }

    /** `Date.now()` of the last gating-chain head read, memoizing {@link #nowBucket}. */
    #headReadMs = 0;

    /** The current gating-chain head bucket, memoized for {@link HEAD_BUCKET_TTL_MS}. */
    async #nowBucket(): Promise<number> {
        if (this.#headReadMs !== 0 && Date.now() - this.#headReadMs < HEAD_BUCKET_TTL_MS) {
            return this.#currentBucketCache;
        }
        return this.#refreshBucket();
    }

    /**
     * Is this bundle's bucket sample block already reachable from our gating-chain head? A
     * bundle dated to a future bucket (the voter's head ahead of ours, clock skew, or an absurd
     * `blockNumber`) is transiently not-yet-evaluable, so the gate `ignore`s it (no penalty,
     * uncached) until our head advances. Steady-state votes (bucket at/behind the current one)
     * take the pure comparison and cost no chain read; only a look-ahead bundle — including the
     * first vote seen on an otherwise-idle join — pays a (TTL-memoized) head read.
     */
    async #isEvaluableNow(bundle: VotesBundle): Promise<boolean> {
        const sampleBucket = this.#bucketMath.bucketForBlock(bundle.blockNumber);
        if (sampleBucket <= this.#currentBucketCache) return true;
        return sampleBucket <= (await this.#nowBucket());
    }

    /** Hash of the current bucket boundary block on the gating (`rule`) chain (rolling tie seed). */
    async #bucketBlockHash(): Promise<Uint8Array> {
        const head = await this.#ruleChain.getBlockNumber();
        const boundary = this.#bucketMath.sampleBlockForBucket(this.#bucketMath.bucketForBlock(Number(head)));
        const block = await this.#ruleChain.getBlock({ blockNumber: BigInt(boundary) });
        if (!block.hash) throw new Error(`bucket boundary block ${boundary} has no hash`);
        return hexToBytes(block.hash);
    }

    #notifyUpdate(): void {
        for (const cb of this.#updateListeners) cb();
    }

    async start(): Promise<void> {
        const limit = pLimit(GATE_CONCURRENCY);
        const gate = makeGossipGate({
            decodeMessage: decodeVoteMessage,
            parseBundle: async (blockBytes) => ({
                cid: await bundleCidForBytes(blockBytes),
                bundle: decodeBundle(blockBytes)
            }),
            verifier: this.#verifier,
            isEvaluableNow: (bundle) => this.#isEvaluableNow(bundle),
            cache: this.#cache,
            acceptedDedup: this.#acceptedDedup,
            // Store the sender's exact block bytes (byte-identity with its CID), then merge.
            admit: async ({ cid, bytes }) => {
                await this.#deps.blockstore.put(cid, bytes);
                await this.#crdt.merge([cid]);
            },
            limit: (fn) => limit(fn),
            allowBundlePeer: makeRateLimiter(GATE_RATE),
            allowRootPeer: makeRateLimiter(GATE_ROOT_RATE),
            onAccept: () => {
                this.#markStateChanged();
                this.#notifyUpdate();
            },
            // Root records surface as unverifiable hints: compare to our own root, chase a
            // divergence lazily, answer it once per interval. Never awaited by the validator.
            onRootRecord: (record) => {
                void this.#handleRootRecord(record).catch(() => {});
            },
            maxBundleMessageBytes: maxBundleMessageBytes(this.criteria),
            maxRootMessageBytes: MAX_ROOT_MESSAGE_BYTES,
            timeoutMs: GATE_TIMEOUT_MS
        });
        const chaseLimit = pLimit(CHASE_CONCURRENCY);
        this.#chaser = makeRootChaser({
            getBlock: async (cid, signal) => {
                try {
                    // Blockstore + bitswap: the advertisers are connected topic peers that
                    // provably hold these blocks, so the want resolves against them directly.
                    return await this.#deps.blockstore.get(cid, { signal });
                } catch {
                    return undefined;
                }
            },
            verifier: this.#verifier,
            cache: this.#cache,
            isEvaluableNow: (bundle) => this.#isEvaluableNow(bundle),
            hasBundle: (cid) => this.#store.has(cid),
            admit: async ({ cid, bytes }) => {
                await this.#deps.blockstore.put(cid, bytes);
                await this.#crdt.merge([cid]);
                this.#markStateChanged();
            },
            onMerged: () => this.#notifyUpdate(),
            limit: (fn) => chaseLimit(fn),
            timeoutMs: CHASE_TIMEOUT_MS
        });
        this.#transport = makeVoteTransport({
            pubsub: this.#deps.pubsub,
            topic: this.topic,
            gate
        });
        await this.#transport.start();
        this.#armHeartbeat();
        // If a restart left state behind, refresh the bucket and prune the decayed nodes. Gated
        // on non-empty state so an empty join stays network-free (no getBlockNumber read),
        // preserving the "zero chain reads for a constant-weight tally" property.
        if (this.#crdt.nodeCount() > 0) {
            await this.#refreshBucket();
            await this.#crdt.prune(this.#currentBucketCache);
        }
    }

    async stop(): Promise<void> {
        if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
        this.#heartbeatTimer = undefined;
        this.#heardMatchingRoot = false;
        this.#publishedRootThisInterval = false;
        this.#chaser = undefined;
        await this.#transport?.stop();
        this.#transport = undefined;
    }

    async castVotes(votes: Vote[]): Promise<VotesBundle> {
        const signer = this.#deps.signer;
        if (signer === undefined) throw new ReadOnlyError();

        // Sign for the current bucket boundary block, the same block every verifier reads at.
        const head = await this.#ruleChain.getBlockNumber();
        const bucket = this.#bucketMath.bucketForBlock(Number(head));
        this.#currentBucketCache = bucket;
        const blockNumber = this.#bucketMath.sampleBlockForBucket(bucket);
        const typedData = ballotTypedData({ criteriaCid: this.#criteriaCid, chainId: this.#chainId, votes, blockNumber });
        const signature = await signer.signBallot(typedData);
        const address = await signer.address();
        const bundle = VotesBundleSchema.parse({ address, votes, blockNumber, signature });

        await this.#crdt.add(bundle);
        this.#markStateChanged();
        // The live delta: this wallet's own bundle, inlined — never the whole winner-set.
        await this.#transport?.publishBundle(encodeBundle(bundle));
        // Persist the intent so the scheduler can revive/re-announce it after a restart. A
        // withdrawal (empty `votes`) is a tombstone: it is broadcast once here to supersede the
        // prior vote under LWW, then the scheduler *re-publishes its existing bytes* (never
        // re-signs it) on the liveness cadence until it expires, at which point the intent is
        // dropped and the bundle decays via expiry + prune. Its blockNumber exceeds the vote it
        // supersedes, so that vote decays strictly earlier — the tombstone need only ride out its
        // own expiry, never an immortal one. See DESIGN.md "Cancelling a vote".
        await this.#deps.store.put({ topic: this.topic, address, votes, lastBucket: this.#bucketMath.bucketForBlock(blockNumber) });
        // This broadcast counts as the tombstone's first announce; the next is one cadence away.
        if (votes.length === 0) this.#lastTombstoneAnnounceBucket = bucket;
        this.#notifyUpdate();
        return bundle;
    }

    /**
     * The republish scheduler's per-contest tick. Reloads this wallet's stored intent and acts
     * on the liveness cadence (`republishIntervalBuckets`):
     *   - **Active vote** (non-empty votes): if due, re-sign it with a fresh `blockNumber` via
     *     {@link castVotes} — which re-broadcasts and writes the bumped `lastBucket` back — so the
     *     vote stays alive.
     *   - **Tombstone** (empty votes, from `castVotes([])`): while its bundle is still live,
     *     *re-publish its existing bytes* (the same inline bundle — NO re-sign, so the expiry
     *     clock is untouched) once per cadence, reaching peers that missed the withdrawal's
     *     one-shot flood. Once the tombstone has expired, drop the intent — the bundle decays
     *     via expiry + prune. A tombstone is never re-signed (that would make it immortal);
     *     only re-published.
     * Also prunes decayed CRDT nodes each tick, gated on non-empty state. When there is no intent
     * AND no state, it returns before any chain read, so an idle contest still reads no chain. A
     * read-only voter or a contest this wallet never voted in is a no-op. Called on `start()` (to
     * revive after a restart) and per poll.
     */
    async republishIfDue(): Promise<void> {
        if (this.readOnly) return;
        const intent = await this.#deps.store.get(this.topic);
        const hasState = this.#crdt.nodeCount() > 0;
        if (intent === undefined && !hasState) return; // nothing to do; no chain read
        const bucket = await this.#refreshBucket();
        if (intent !== undefined) {
            if (intent.votes.length === 0) {
                await this.#tickTombstone(intent.address, intent.lastBucket, bucket);
            } else if (intent.lastBucket + republishIntervalBuckets(this.criteria) <= bucket) {
                await this.castVotes(intent.votes);
            }
        }
        if (hasState) {
            // Compaction: drop expired/superseded nodes from memory. Blockstore GC of the
            // now-unreferenced blocks is deferred housekeeping (see DESIGN.md "Checkpoints").
            await this.#crdt.prune(bucket);
        }
    }

    /** Invalidate the on-demand checkpoint cache: the winner-set changed (cast/merge/chase). */
    #markStateChanged(): void {
        this.#checkpointDirty = true;
    }

    /**
     * The contest's current root record, encoded **on demand** and cached until the winner-set
     * changes ({@link #markStateChanged}) or the bucket advances (expiry changes the set with no
     * message). Each encode writes its blocks to the blockstore — content-addressed and
     * idempotent — so directed bitswap can serve them to a chasing peer. Served by the fetch
     * responder and heartbeated on the topic; there is NO cut cadence (see DESIGN.md
     * "Checkpoints", "On-demand encode").
     */
    async rootRecord(): Promise<RootRecord> {
        const bucket = this.#currentBucketCache;
        const cached = this.#rootRecordCache;
        if (!this.#checkpointDirty && cached !== undefined && cached.bucket === bucket) return cached.record;
        const winners = this.#crdt.current(bucket);
        const { root, blocks } = await encodeCheckpoint(winners);
        for (const block of blocks) await this.#deps.blockstore.put(block.cid, block.bytes);
        const record: RootRecord = {
            version: ROOT_RECORD_VERSION,
            root,
            count: winners.length,
            sizeBytes: blocks.reduce((total, block) => total + block.bytes.length, 0)
        };
        this.#rootRecordCache = { record, bucket };
        this.#checkpointDirty = false;
        return record;
    }

    /**
     * The root CID of this contest's current checkpoint, or `undefined` before the first
     * encode. The blocks it references are in the blockstore.
     */
    latestCheckpointRoot(): CID | undefined {
        return this.#rootRecordCache?.record.root;
    }

    /**
     * Handle a heard root record (an unverifiable hint, surfaced by the gate at layer 1):
     *   - matching our own root ⇒ note it for heartbeat **suppression** (a converged topic
     *     stays near-silent);
     *   - differing ⇒ **chase** it lazily (bounded; see transport/chase.ts) and answer with our
     *     own record at most once per interval, so both sides learn of the split without an
     *     attacker being able to make honest peers chorus.
     * See DESIGN.md "Checkpoints", "Two transports for the same record".
     */
    async #handleRootRecord(record: RootRecord): Promise<void> {
        const own = await this.rootRecord();
        if (own.root.equals(record.root)) {
            this.#heardMatchingRoot = true;
            return;
        }
        this.#chaser?.chase(record.root);
        if (!this.#publishedRootThisInterval) {
            this.#publishedRootThisInterval = true;
            await this.#transport?.publishRootRecord(own);
        }
    }

    /**
     * Arm the next heartbeat firing: {@link HEARTBEAT_INTERVAL_MS} jittered ±25%, re-armed
     * after each tick. The tick publishes our root record UNLESS this interval already carried
     * it — either a matching heartbeat was heard (suppression) or we already published (the
     * one-per-interval cap, shared with the divergence response).
     */
    #armHeartbeat(): void {
        const delay = HEARTBEAT_INTERVAL_MS * (0.75 + Math.random() * 0.5);
        const timer = setTimeout(() => {
            void this.#heartbeatTick()
                .catch(() => {}) // transient publish/encode failure — next interval retries
                .finally(() => {
                    if (this.#heartbeatTimer !== undefined) this.#armHeartbeat();
                });
        }, delay);
        // Don't hold a Node process open; no-op in the browser.
        (timer as { unref?: () => void }).unref?.();
        this.#heartbeatTimer = timer;
    }

    async #heartbeatTick(): Promise<void> {
        const suppressed = this.#heardMatchingRoot || this.#publishedRootThisInterval;
        this.#heardMatchingRoot = false;
        this.#publishedRootThisInterval = false;
        if (suppressed) return;
        await this.#transport?.publishRootRecord(await this.rootRecord());
    }

    /**
     * Advance a live withdrawal tombstone: re-publish its existing bundle bytes on the liveness
     * cadence (never re-signing — the expiry clock stays fixed), and once the bundle has expired
     * drop the intent so it stops. `withdrawalBucket` is the intent's `lastBucket` (set once by
     * {@link castVotes}); the tombstone bundle matches the CRDT's own expiry predicate,
     * `currentBucket > withdrawalBucket + voteExpiryBuckets`.
     */
    async #tickTombstone(address: string, withdrawalBucket: number, bucket: number): Promise<void> {
        if (bucket > withdrawalBucket + this.criteria.voteExpiryBuckets) {
            await this.#deps.store.delete(this.topic);
            this.#lastTombstoneAnnounceBucket = undefined;
            return;
        }
        const anchor = this.#lastTombstoneAnnounceBucket;
        if (anchor === undefined || bucket - anchor >= republishIntervalBuckets(this.criteria)) {
            // Re-publish the existing tombstone bundle — the same bytes inline, no re-sign, no
            // `lastBucket` bump — so a peer that missed its one-shot flood converges within a
            // cadence. The wallet's LWW winner while the tombstone is live IS the tombstone.
            const wallet = address.toLowerCase();
            const tombstone = this.#crdt
                .current(bucket)
                .find((b) => b.address.toLowerCase() === wallet && b.votes.length === 0);
            if (tombstone) await this.#transport?.publishBundle(encodeBundle(tombstone));
            this.#lastTombstoneAnnounceBucket = bucket;
        }
    }

    /**
     * Stop keeping this wallet's vote in this contest alive — drop the stored intent so the
     * scheduler stops re-signing it and the vote decays at its own expiry (passive withdrawal;
     * publishes nothing, unlike `castVotes([])` which actively supersedes). Idempotent.
     */
    async forget(): Promise<void> {
        await this.#deps.store.delete(this.topic);
        this.#lastTombstoneAnnounceBucket = undefined;
    }

    async getTally(options?: TallyOptions): Promise<ContestTally> {
        // With state present, refresh the bucket so the tally's `current()` filters expiry against
        // the live block, then prune the now-decayed nodes. Empty state needs neither, so an
        // empty tally reads no chain (the constant-weight "zero chain reads" property).
        if (this.#crdt.nodeCount() > 0) {
            await this.#refreshBucket();
            await this.#crdt.prune(this.#currentBucketCache);
        }
        return this.#tally.compute(options);
    }

    on(event: "update", cb: () => void): void {
        if (event === "update") this.#updateListeners.push(cb);
    }
}

/**
 * The default `VoteClient`. Construct with the host-injected seams: a `helia` node (the
 * library never starts or assumes a particular node, but it must carry a gossipsub service
 * and a blockstore), a `chains` factory, the `manifest` this voter owns (required — every
 * contest is derived from it and addressed by `contestId`), an optional `signer`, and
 * optional `nameResolvers` (needed once votes carry community names). The library has no
 * knowledge of pkc-js or any other host: a host passes its own running Helia node in directly.
 */
export class PubsubVoter implements VoteClient {
    readonly #deps: ResolvedDeps;
    /** Cache of live contests, keyed by topic so identical criteria share one network. */
    readonly #contests = new Map<string, ContestNetwork>();
    /**
     * Every contest this voter owns, derived from the constructor manifest and keyed by its
     * unique `contestId` (validated at construction). This is the single source of contests;
     * `getContest` and `start()` both read from it, and it fixes `contestIds` order.
     */
    readonly #criteriaById: Map<string, Criteria>;
    /** Live republish timers, one per contest, cleared by `stop()` / `destroy()`. */
    readonly #republishTimers = new Set<ReturnType<typeof setInterval>>();
    /** Wall-clock poll interval (ms) for the republish scheduler. */
    readonly #republishPollIntervalMs: number;

    constructor(options: PubsubVoterOptions) {
        // Fail fast: the node must expose a gossipsub service and a blockstore. Throws
        // MissingPubsubError / MissingBlockstoreError at construction (not a lazy failure
        // on the first publish/fetch) and narrows both handles.
        const { pubsub, blockstore } = requireHeliaServices(options.helia);
        this.#deps = {
            helia: options.helia,
            pubsub,
            blockstore,
            chains: options.chains,
            signer: options.signer,
            registry: resolveRegistry(options.rules),
            nameResolvers: options.nameResolvers ?? [],
            store: selectVoteStore(options.dataPath)
        };
        this.#republishPollIntervalMs = options.republishPollIntervalMs ?? DEFAULT_REPUBLISH_POLL_MS;

        // The manifest is mandatory in v1: derive every contest up front, validate each
        // against the rule registry, and reject a duplicate `contestId` — the id is how a
        // host addresses one contest (`getContest`), so it must be unique.
        if (options.manifest === undefined || options.manifest === null) throw new MissingManifestError();
        this.#criteriaById = new Map();
        for (const criteria of deriveCriteria(options.manifest)) {
            validateCriteriaRules(criteria, this.#deps.registry);
            if (this.#criteriaById.has(criteria.contestId)) throw new DuplicateContestIdError(criteria.contestId);
            this.#criteriaById.set(criteria.contestId, criteria);
        }
    }

    get readOnly(): boolean {
        return this.#deps.signer === undefined;
    }

    get contestIds(): readonly string[] {
        return [...this.#criteriaById.keys()];
    }

    async getContest(args: { contestId: string }): Promise<VoteNetwork> {
        const criteria = this.#criteriaById.get(args.contestId);
        if (!criteria) throw new UnknownContestError(args.contestId, [...this.#criteriaById.keys()]);
        return this.#network(criteria);
    }

    async forget(args: { contestId: string }): Promise<void> {
        const criteria = this.#criteriaById.get(args.contestId);
        if (!criteria) throw new UnknownContestError(args.contestId, [...this.#criteriaById.keys()]);
        const network = await this.#network(criteria);
        await network.forget();
    }

    /** Build (or return the cached) network for one already-validated criteria, keyed by topic. */
    async #network(criteria: Criteria): Promise<ContestNetwork> {
        const cid = await criteriaCid(criteria);
        const topic = TOPIC_PREFIX + cid.toString();
        const existing = this.#contests.get(topic);
        if (existing) return existing;
        const network = new ContestNetwork(criteria, topic, cid.bytes, this.#deps);
        this.#contests.set(topic, network);
        return network;
    }

    async start(): Promise<void> {
        const networks = await Promise.all([...this.#criteriaById.values()].map((criteria) => this.#network(criteria)));
        for (const network of networks) {
            // Joins the topic and installs the forward gate; the cold-start root pull over the
            // libp2p fetch protocol lands with the root-record sync (see ROADMAP.md), so a cold
            // join currently relies on live gossip to converge.
            await network.start();
        }
        await this.#armRepublishScheduler(networks);
    }

    async stop(): Promise<void> {
        this.#clearRepublishTimers();
        await this.stopAll();
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.#contests.values()].map((network) => network.stop()));
    }

    async destroy(): Promise<void> {
        this.#clearRepublishTimers();
        await this.stopAll();
        await this.#deps.store.destroy?.();
    }

    /** Clear every armed republish timer. Safe when none are armed. */
    #clearRepublishTimers(): void {
        for (const timer of this.#republishTimers) clearInterval(timer);
        this.#republishTimers.clear();
    }

    /**
     * Arm the per-contest republish loop that keeps this wallet's votes alive. Each contest's
     * {@link ContestNetwork.republishIfDue} tick reloads its `VoteIntent`, re-signs it on the
     * `republishIntervalBuckets(criteria)` bucket cadence (via `castVotes`, which re-broadcasts
     * and writes the bumped `lastBucket`), and prunes decayed CRDT nodes. Since the cadence is
     * bucket-based but timers are wall-clock, each contest polls on `#republishPollIntervalMs`.
     *
     * On `start()` every stored intent is republished immediately (DESIGN.md "on start() the
     * voter lists every intent and republishes it") so a vote revives after a restart, then a
     * poll timer is armed per contest and tracked in `#republishTimers` for `stop()`/`destroy()`
     * teardown. A read-only voter (no signer) has no intents to keep alive, so it arms nothing.
     */
    async #armRepublishScheduler(networks: ContestNetwork[]): Promise<void> {
        if (this.readOnly) return;
        // Revive every stored intent up front (post-restart catch-up), tolerating per-contest
        // failures so one unreachable chain does not block the others.
        await Promise.allSettled(networks.map((network) => network.republishIfDue()));
        for (const network of networks) {
            const timer = setInterval(() => {
                // Fire-and-forget: a transient failure (RPC read, broadcast) is retried next tick
                // and must never crash the loop or the other contests' timers.
                void network.republishIfDue().catch(() => {});
            }, this.#republishPollIntervalMs);
            // Don't let the scheduler hold a Node process open; no-op in the browser (where
            // setInterval returns a number with no `unref`).
            (timer as { unref?: () => void }).unref?.();
            this.#republishTimers.add(timer);
        }
    }
}
