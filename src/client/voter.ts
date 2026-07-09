import pLimit from "p-limit";
import type { Criteria } from "../schema/criteria.js";
import { VotesBundleSchema, type Vote, type VotesBundle } from "../schema/votes.js";
import type { ChainClient, ChainClientFactory, ChainClients, NameResolver } from "../chain/types.js";
import { makeBucketMath } from "../chain/bucket.js";
import { tickerForRef } from "../chain/ticker.js";
import type { BlockstoreLike, FetchServiceLike, HeliaInstance, PubsubService, VoteTransport } from "../transport/types.js";
import { requireHeliaServices } from "../transport/helia.js";
import { makeBlockstoreBundleStore } from "../transport/bundle-store.js";
import { makeRateLimiter } from "../transport/rate-limit.js";
import { makeGossipGate } from "../transport/gossip-validator.js";
import { makeVoteTransport } from "../transport/transport.js";
import {
    decodeVoteMessage,
    decodeRootRecord,
    encodeRootRecord,
    maxBundleMessageBytes,
    rootFetchKey,
    MAX_ROOT_MESSAGE_BYTES,
    ROOT_FETCH_KEY_SUFFIX,
    ROOT_RECORD_VERSION,
    type RootRecord,
    type FetchRootRecord
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
import { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
import { makeTally } from "../tally/tally.js";
import type { ContestTally, TallyOptions } from "../tally/types.js";
import type { VoteSigner } from "../signer/types.js";
import { ballotTypedData } from "../signer/eip712.js";
import { criteriaCid, TOPIC_PREFIX } from "../topic.js";
import { deriveCriteria, type DirectoryManifest } from "../manifest/manifest.js";
import {
    DuplicateContestIdError,
    MissingManifestError,
    ReadOnlyError,
    UnknownContestError,
    UnknownRuleError,
    VoterDestroyedError
} from "../errors.js";

/**
 * The recommended cadence, in buckets, at which a client should re-publish a live vote to keep
 * it alive: half its expiry window, rounded up. A bundle is valid for `voteExpiryBuckets` after
 * its `blockNumber` (see DESIGN.md "Passive expiry"), so re-signing at the halfway point leaves
 * one full missed cycle of slack before the vote decays. Derived per-contest from the criteria —
 * there is no global interval.
 *
 * This library does NOT re-publish on its own: deciding when (or whether) to refresh a vote is
 * the consuming client's job (see DESIGN.md "Republishing is the client's job"). This helper, the
 * `blockNumber` on a published `VotesBundle`, and `criteria.voteExpiryBuckets` /
 * `criteria.blocksPerBucket` are what a client uses to schedule its own refreshes: a vote sampled
 * at bucket `b` expires once the current bucket exceeds `b + voteExpiryBuckets`; refresh by
 * calling `createContestVote({ contestId, votes }).publish()` again before then.
 */
export function republishIntervalBuckets(criteria: Criteria): number {
    return Math.ceil(criteria.voteExpiryBuckets / 2);
}

/**
 * Public facade — three objects, mirroring pkc-js / plebbit-js:
 *   - {@link PubsubVoter} (`VoteClient`): the factory. Holds the host-injected dependencies once,
 *     derives every contest from the required `manifest`, and owns one engine per contest. This is
 *     what a host like 5chan touches — 63 directory slots = 63 contests = 63 topics from one
 *     manifest, so it should not wire dependencies 63 times.
 *   - {@link Contest} (`createContest`): one contest's reactive **read** view. `update()` starts
 *     syncing and emits `update` (carrying a fresh `tally`) / `error`, like `subplebbit.update()`.
 *   - {@link ContestVote} (`createContestVote`): one publishable **ballot**. `publish()` signs and
 *     broadcasts it once, emitting `publishingstatechange` / `error`, like a plebbit publication.
 *
 * The injected seams (helia, chains, signer, nameResolvers) are the ONLY host contact surface, so
 * the same core runs under pkc-js, plebbit, or a raw node. The host passes its running Helia node
 * directly — no adapter — and the library drives that node's gossipsub service and blockstore
 * itself. A voter built without a `signer` is read-only (tallies readable, publishing disabled).
 *
 * Republishing a live vote so it does not decay is deliberately NOT this library's job — it
 * publishes each vote once and the client decides when to refresh (see
 * {@link republishIntervalBuckets} and DESIGN.md "Republishing is the client's job").
 */

/** A vote publication's lifecycle, walked by {@link ContestVote.publish}. */
export type PublishingState = "stopped" | "signing" | "publishing" | "succeeded" | "failed";

/** What {@link ContestVote.publish} resolves: the signed bundle plus a peer-reach hint. */
export interface PublishOutcome {
    /** The signed bundle; its `blockNumber` drives the client's own refresh schedule. */
    readonly bundle: VotesBundle;
    /**
     * How many peers gossipsub sent this vote *directly* to — first-hop fan-out, not total network
     * reach and not an acceptance confirmation (each recipient still runs the forward-gate before
     * re-forwarding). Handy as a coarse "did this reach anyone?" signal: `0` means the message went
     * nowhere. Note gossipsub instead *rejects* the publish with `NoPeersSubscribedToTopic` when it
     * would reach zero peers, unless the host enables `allowPublishToZeroTopicPeers` — so a
     * resolved `recipientCount === 0` only happens under that host setting.
     */
    readonly recipientCount: number;
}

/** One contest's reactive read view: subscribe, keep the tally in sync, read it. */
export interface Contest {
    /** The criteria document this contest runs (already validated). */
    readonly criteria: Criteria;
    /** The gossipsub topic = "bitsocial-votes/" + CID(dag-cbor(criteria)). */
    readonly topic: string;
    /**
     * The last computed tally, refreshed before each `update` event; `undefined` until the first
     * compute (i.e. before `update()` resolves). For a forced fresh read use {@link getTally}.
     */
    readonly tally: ContestTally | undefined;

    /**
     * Join the topic behind the validate-before-forward gate, pull the cold-start checkpoint, and
     * begin emitting `update` events as incoming votes change the state. Resolves once the initial
     * tally is computed (so {@link tally} is populated). Idempotent.
     */
    update(): Promise<void>;
    /** Stop syncing and leave the topic. Does not stop the host node. Idempotent. */
    stop(): Promise<void>;

    /** Compute the current contest ranking fresh (verified lazily top-down), bypassing the cache. */
    getTally(options?: TallyOptions): Promise<ContestTally>;

    /** Fired when incoming votes change the state; `tally` carries the freshly recomputed ranking. */
    on(event: "update", cb: () => void): void;
    /** Fired on a contest-level failure (e.g. the tally's chain read throws). */
    on(event: "error", cb: (error: unknown) => void): void;
}

/** One publishable ballot for a contest. Create it, then `publish()`. */
export interface ContestVote {
    /** The `contestId` this ballot targets. */
    readonly contestId: string;
    /** The gossipsub topic the bundle publishes to. */
    readonly topic: string;
    /** The votes this ballot will sign and broadcast (empty array = a withdrawal). */
    readonly votes: readonly Vote[];
    /** Where in the publish lifecycle this ballot is. */
    readonly publishingState: PublishingState;
    /** The signed bundle, once `publish()` has produced it (`undefined` before then). */
    readonly bundle: VotesBundle | undefined;

    /**
     * Sign the votes into a bundle for the current bucket, add it to the local CRDT, and broadcast
     * it once as a live delta. Joins the topic first if needed. Resolves a {@link PublishOutcome}:
     * the `VotesBundle` (whose `blockNumber` the client uses to schedule its own refresh — see
     * {@link republishIntervalBuckets}) plus `recipientCount`, the number of peers gossipsub sent
     * the vote directly to. Emits `publishingstatechange` as it goes; throws (and emits `error`) on
     * failure, and `ReadOnlyError` with no signer. This library does not re-publish: to keep the
     * vote alive, call `publish()` again before it expires.
     */
    publish(): Promise<PublishOutcome>;

    /** Fired on each `publishingState` transition. */
    on(event: "publishingstatechange", cb: (state: PublishingState) => void): void;
    /** Fired if publishing fails. */
    on(event: "error", cb: (error: unknown) => void): void;
}

/** The factory: one set of injected dependencies, many contests. */
export interface VoteClient {
    /** True when constructed without a signer: every contest is read-only. */
    readonly readOnly: boolean;
    /** The `contestId`s of every contest in this voter's manifest, in manifest order. */
    readonly contestIds: readonly string[];
    /**
     * Create the reactive read view for one contest by its `contestId`. The id must name a contest
     * in this voter's manifest, else `UnknownContestError`. Returns the stable per-topic object
     * (one CRDT/engine per topic per node), so repeated calls for the same contest return the same
     * `Contest`.
     */
    createContest(args: { contestId: string }): Promise<Contest>;
    /**
     * Create a publishable ballot for one contest. The id must name a contest in this voter's
     * manifest, else `UnknownContestError`. Each call returns a fresh `ContestVote` over the shared
     * per-topic engine; pass `votes: []` to build a withdrawal.
     */
    createContestVote(args: { contestId: string; votes: Vote[] }): Promise<ContestVote>;
    /**
     * Join and sync every contest in the constructor `manifest`, and register the checkpoint fetch
     * responder — the "participate in and serve the whole directory" path a seeder or full host
     * uses. A light client can skip this and just `createContest` / `createContestVote` the slots it
     * cares about. Idempotent to the extent engines join idempotently.
     */
    start(): Promise<void>;
    /**
     * Leave every topic and unregister the fetch responder, resetting each read view so it can
     * `update()` again. The client stays fully reusable — call `start()` / `createContest` after.
     */
    stop(): Promise<void>;
    /** Leave every contest this client joined and reset its read views (no responder change). */
    stopAll(): Promise<void>;
    /**
     * Terminal teardown (mirrors pkc-js `destroy`): leave every topic, unregister the fetch
     * responder, and mark the voter and all its contests destroyed. Unlike `stop`, this is NOT
     * reusable — every subsequent `createContest` / `createContestVote` / `start`, and any
     * pre-existing `Contest.update()` / `ContestVote.publish()`, throws `VoterDestroyedError`.
     * Construct a new `PubsubVoter` to participate again. There is no store to dispose
     * (republishing / persistence is the client's concern).
     */
    destroy(): Promise<void>;
}

/** Construction options for {@link PubsubVoter}. */
export interface PubsubVoterOptions {
    /**
     * The host's running Helia node (the value `createHelia` returns; for pkc-js it is
     * `pkc.clients.libp2pJsClients[key]._helia`). The only host-node seam, passed
     * directly with no adapter. It MUST carry a gossipsub service at
     * `libp2p.services.pubsub`, a usable `blockstore`, and a libp2p fetch service at
     * `libp2p.services.fetch`; the constructor throws `MissingPubsubError` /
     * `MissingBlockstoreError` / `MissingFetchError` otherwise (a plain Helia node has
     * no pubsub). The library never starts or stops this node.
     */
    helia: HeliaInstance;
    /**
     * Builds a chain client from a `{ chain, config }` pair. Each contest builds its
     * own clients from `criteria.requires.chains` via this factory, so chains are
     * per-contest data, not a global injection.
     */
    chains: ChainClientFactory;
    /** Identity. Omit for a read-only voter (renders tallies, cannot publish). */
    signer?: VoteSigner;
    /**
     * The 5chan-style directory manifest this voter owns. Required in v1: the voter derives
     * every contest from it (via `deriveCriteria`) at construction and addresses each by its
     * unique `contestId` (`createContest` / `createContestVote`). Its `contestId`s MUST be
     * unique — a duplicate throws `DuplicateContestIdError` at construction — and a
     * missing/invalid manifest throws `MissingManifestError`.
     */
    manifest: DirectoryManifest;
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
}

interface ResolvedDeps {
    helia: HeliaInstance;
    /** The node's gossipsub service, validated once at construction. */
    pubsub: PubsubService;
    /** The node's blockstore, validated once at construction. */
    blockstore: BlockstoreLike;
    /** The node's libp2p fetch service (root-record pull), validated once at construction. */
    fetch: FetchServiceLike;
    chains: ChainClientFactory;
    signer: VoteSigner | undefined;
    /** Built-ins with any host overrides merged in (overrides shadow by `type`). */
    registry: RuleRegistry;
    /** Community-name resolvers for verifying `community.name` claims at tally time. */
    nameResolvers: NameResolver[];
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
/** Cold-join fan-out: how many peers (per discovery source) we ask for their root record on start. */
const COLD_START_PEERS = 4;
/**
 * Deadline (ms) for the cold-join HTTP content-router lookup. `findProviders` over a delegated
 * router is a network call that can stall; on expiry the abort ends it and cold-start falls back to
 * whatever the gossipsub-subscriber source and live gossip provide.
 */
const COLD_START_ROUTER_TIMEOUT_MS = 10_000;
/**
 * Root-record heartbeat interval (ms): 10 minutes — the IPNS-over-pubsub rebroadcast default
 * (`go-libp2p-pubsub-router`) — jittered ±25% per firing, with suppression on top (skip when a
 * matching root was heard this interval) so a converged topic stays near-silent. See DESIGN.md
 * "Checkpoints" and "Transport constants (v1)".
 */
const HEARTBEAT_INTERVAL_MS = 600_000;
/**
 * Cold-join fetch retry. A shared seeder registers `@libp2p/fetch` with libp2p's default per-protocol
 * `maxInboundStreams` (32 in libp2p 3.3.4), so when a cold peer joins a whole directory at once — one
 * root-record fetch per contest, fired concurrently — the node serves the first 32 and *resets* the
 * rest, and libp2p surfaces the reset as a thrown fetch. Without a retry those boards silently never
 * pull their checkpoint (measured: a naive 63-board join converges only 32/63).
 *
 * The cap is not just briefly exceeded — while more boards want to fetch than the node has slots, it
 * stays *saturated*: every freed slot is instantly retaken, so a fixed handful of retries can lose the
 * race and still strand a board (measured: 5 attempts → 53/63). So we retry a THROWN fetch until a
 * **deadline**, with full-jittered exponential backoff: the jitter spreads retries across the freeing
 * slots and the deadline guarantees a board keeps trying until it wins one, while still bounding a
 * genuinely unreachable peer (cold-start is best-effort — live gossip and the heartbeat converge it
 * regardless). Only a throw retries; a value or a definitive `undefined`/`null` ("no record") is
 * returned as-is. See DESIGN.md "Deferred pkc-js work".
 */
const COLD_START_FETCH_DEADLINE_MS = 30_000;
const COLD_START_FETCH_BACKOFF_MS = 400;
const COLD_START_FETCH_BACKOFF_CAP_MS = 4_000;
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

/**
 * One contest's engine: joins the topic behind the validate-before-forward gate, keeps the CRDT in
 * sync (live gossip + cold-start + chase + heartbeat), computes the tally, and signs/broadcasts this
 * wallet's ballots. Internal — the public {@link Contest} and {@link ContestVote} are thin views
 * over one shared engine per topic. It does NOT keep votes alive: publishing is one-shot and the
 * client decides when to refresh (see DESIGN.md "Republishing is the client's job").
 */
class ContestEngine {
    readonly criteria: Criteria;
    readonly topic: string;
    readonly readOnly: boolean;

    readonly #deps: ResolvedDeps;
    /** Chain clients for this contest, built from `criteria.requires.chains` via the factory. */
    readonly #chainClients: ChainClients;

    readonly #criteriaCid: Uint8Array;
    /** The gating (`rule`) chain's numeric chainId, bound into every ballot signature. */
    readonly #chainId: number;
    /** The gating (`rule`) chain client, also the seed chain for the tally's tie-break block hash. */
    readonly #ruleChain: ChainClient;
    readonly #bucketMath: ReturnType<typeof makeBucketMath>;
    readonly #crdt: VoteCrdt;
    readonly #tally: ReturnType<typeof makeTally>;
    /** Live once joined; the gate + gossip wiring for this topic. */
    #transport: VoteTransport | undefined;
    /** True between `join()` and `leave()`; makes both idempotent so views + `start()` compose. */
    #joined = false;
    /**
     * True once the owning voter was `destroy()`ed. Terminal: {@link join} then throws, so no view
     * or publication over this engine can go live again (see DESIGN.md / `VoterDestroyedError`).
     */
    #destroyed = false;

    /** Subscribers to state changes; a Contest view registers one of each. Tally recompute is gated on these. */
    readonly #updateListeners: Array<() => void> = [];
    readonly #errorListeners: Array<(error: unknown) => void> = [];
    /** The last computed tally, exposed as `Contest.tally`. */
    #cachedTally: ContestTally | undefined;
    /** Coalescing flags for the background tally recompute (one recompute per gossip burst). */
    #tallyDirty = true;
    #tallyRefreshing = false;

    /**
     * Last-known current bucket on the gating chain, refreshed by {@link #refreshBucket} on
     * every chain read the engine already does (join, publish, tally). The CRDT's read-time
     * expiry filter (`current`) reads it, so decayed votes drop without a per-read chain call.
     */
    #currentBucketCache = 0;
    /**
     * The on-demand checkpoint cache: the last encoded root record and the bucket it was encoded
     * at. Invalidated by {@link #markStateChanged} (any merge/publish/chase admit) and by a bucket
     * advance (expiry changes the winner set without any message). See DESIGN.md "Checkpoints".
     */
    #rootRecordCache: { record: FetchRootRecord; bucket: number } | undefined = undefined;
    /** True when the winner-set changed since the last encode; the next `rootRecord()` re-encodes. */
    #checkpointDirty = true;
    /** Live once joined; chases advertised roots that differ from our own. */
    #chaser: RootChaser | undefined;
    /** The armed heartbeat timer (jittered; see {@link #armHeartbeat}), cleared by `leave()`. */
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
        // The gate/transport are (re)built on join(); the store, crdt, caches, and verifier are
        // stable per contest, so they survive re-joins of the topic.
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
     * uncached) until our head advances.
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

    // ---- tally cache + reactive update/error listeners (drive the Contest view) ----

    /** The last computed tally, or `undefined` before the first compute. */
    get cachedTally(): ContestTally | undefined {
        return this.#cachedTally;
    }

    addUpdateListener(cb: () => void): void {
        this.#updateListeners.push(cb);
    }
    removeUpdateListener(cb: () => void): void {
        const i = this.#updateListeners.indexOf(cb);
        if (i >= 0) this.#updateListeners.splice(i, 1);
    }
    addErrorListener(cb: (error: unknown) => void): void {
        this.#errorListeners.push(cb);
    }
    removeErrorListener(cb: (error: unknown) => void): void {
        const i = this.#errorListeners.indexOf(cb);
        if (i >= 0) this.#errorListeners.splice(i, 1);
    }

    /** Compute the current ranking fresh (refreshing the bucket + pruning when state is present). */
    async computeTally(options?: TallyOptions): Promise<ContestTally> {
        // With state present, refresh the bucket so the tally's `current()` filters expiry against
        // the live block, then prune the now-decayed nodes. Empty state needs neither, so an
        // empty tally reads no chain (the constant-weight "zero chain reads" property).
        if (this.#crdt.nodeCount() > 0) {
            await this.#refreshBucket();
            await this.#crdt.prune(this.#currentBucketCache);
        }
        return this.#tally.compute(options);
    }

    /** Compute the tally once, cache it, and emit `update`; on failure emit `error` instead. */
    async #computeAndEmit(): Promise<void> {
        this.#tallyDirty = false;
        let tally: ContestTally;
        try {
            tally = await this.computeTally();
        } catch (error) {
            for (const cb of [...this.#errorListeners]) cb(error);
            return;
        }
        this.#cachedTally = tally;
        for (const cb of [...this.#updateListeners]) cb();
    }

    /** Force one recompute + emit now (used by a view's `update()` for the initial tally). */
    async refreshTallyNow(): Promise<void> {
        await this.#computeAndEmit();
    }

    /**
     * Kick a coalesced background tally recompute. Only runs while a Contest view is subscribed, so
     * an unobserved contest (or `start()` with no read views) does no tally chain reads; the burst
     * loop collapses many state changes into as few recomputes as the compute latency allows.
     */
    #kickTallyRefresh(): void {
        this.#tallyDirty = true;
        if (this.#tallyRefreshing || this.#updateListeners.length === 0) return;
        this.#tallyRefreshing = true;
        void (async () => {
            try {
                while (this.#tallyDirty && this.#updateListeners.length > 0) await this.#computeAndEmit();
            } finally {
                this.#tallyRefreshing = false;
            }
        })();
    }

    /** Any admit (gossip accept, chase merge, local publish) changed the winner set. */
    #onStateChanged(): void {
        this.#markStateChanged();
        this.#kickTallyRefresh();
    }

    /** Mark this engine terminal: a subsequent {@link join} (update/publish) throws. Sync; leave separately. */
    markDestroyed(): void {
        this.#destroyed = true;
    }

    async join(): Promise<void> {
        if (this.#destroyed) throw new VoterDestroyedError();
        if (this.#joined) return;
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
            onAccept: () => this.#onStateChanged(),
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
            onMerged: () => this.#onStateChanged(),
            limit: (fn) => chaseLimit(fn),
            timeoutMs: CHASE_TIMEOUT_MS
        });
        this.#transport = makeVoteTransport({
            pubsub: this.#deps.pubsub,
            topic: this.topic,
            gate
        });
        await this.#transport.start();
        this.#joined = true;
        this.#armHeartbeat();
        // Cold-start / reconnect pull: ask connected topic peers for their root records and
        // chase any divergence. Fire-and-forget — joining must not block on slow peers, and
        // live gossip plus the heartbeat converge regardless; this only shortens the gap.
        void this.#coldStart().catch(() => {});
        // If a re-join left state behind, refresh the bucket and prune the decayed nodes. Gated
        // on non-empty state so an empty join stays network-free (no getBlockNumber read),
        // preserving the "zero chain reads for a constant-weight tally" property.
        if (this.#crdt.nodeCount() > 0) {
            await this.#refreshBucket();
            await this.#crdt.prune(this.#currentBucketCache);
        }
    }

    /**
     * The cold-join pull (DESIGN.md "Checkpoints"): ask up to {@link COLD_START_PEERS} peers, over
     * the libp2p **fetch protocol**, for their current root record, and chase every root that
     * differs from our own. Peers come from **two sources raced concurrently, neither blocking the
     * other**: the gossipsub subscribers of this topic, and the providers of the criteria CID from
     * the host's HTTP content router. Roots are **unioned, never quorum'd** — a record served by a
     * single peer is still chased, so a colluding majority cannot hide a vote.
     */
    async #coldStart(): Promise<void> {
        const seen = new Set<string>();
        const selfId = this.#deps.helia.libp2p.peerId?.toString();
        // Encode our own root only when a peer actually returns one to compare against, so an empty
        // join (no subscribers, no providers) does no checkpoint work.
        let ownRoot: Promise<FetchRootRecord> | undefined;
        const pull = async (peer: PeerId): Promise<void> => {
            const id = peer.toString();
            if (id === selfId || seen.has(id)) return; // skip self and any peer already asked
            seen.add(id);
            try {
                const value = await this.#fetchRootWithRetry(peer);
                if (value === undefined || value === null) return;
                const record = decodeRootRecord(value); // throws on garbage — caught, contributes nothing
                const own = await (ownRoot ??= this.rootRecord());
                // Hand the piggybacked chunk index to the chase: verified against `record.root`, it
                // skips the root-manifest bitswap round-trip (see DESIGN.md "Block pull").
                if (!record.root.equals(own.root)) this.#chaser?.chase(record.root, record.chunks);
            } catch {
                // Peer offline, no record, or malformed answer — best-effort; the other source and
                // live gossip still converge.
            }
        };
        const fromSubscribers = this.#deps.pubsub.getSubscribers(this.topic).slice(0, COLD_START_PEERS).map(pull);
        await Promise.allSettled([...fromSubscribers, this.#discoverProviders(pull)]);
    }

    /**
     * Pull one peer's root record over the fetch protocol, retrying a THROWN fetch with full-jittered
     * exponential backoff until {@link COLD_START_FETCH_DEADLINE_MS} (see the constant's note for the
     * measured seeder-reset failure this rides out). A *definitive* answer never retries; bails if the
     * contest was left mid-retry (`#chaser` is cleared by `leave()`).
     */
    async #fetchRootWithRetry(peer: PeerId): Promise<Uint8Array | undefined | null> {
        const deadline = Date.now() + COLD_START_FETCH_DEADLINE_MS;
        let lastError: unknown;
        for (let attempt = 0; ; attempt++) {
            if (attempt > 0) {
                if (this.#chaser === undefined || Date.now() >= deadline) break; // left or out of time
                const ceiling = Math.min(COLD_START_FETCH_BACKOFF_CAP_MS, COLD_START_FETCH_BACKOFF_MS * 2 ** (attempt - 1));
                await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
                if (this.#chaser === undefined) return undefined; // left mid-backoff — abandon quietly
            }
            try {
                return await this.#deps.fetch.fetch(peer, rootFetchKey(this.topic));
            } catch (error) {
                lastError = error; // transient (e.g. seeder over its inbound-stream cap) — back off and retry
            }
        }
        throw lastError;
    }

    /**
     * Cold-join discovery source 2: ask the injected node's HTTP content router(s) who provides the
     * criteria CID (`libp2p.contentRouting.findProviders`), dial each provider, and hand it to
     * `pull`. This is the pkc-js peer-discovery pattern — delegated Routing V1 over HTTP, no DHT.
     * Best-effort and bounded: a node with no content router, a router error, or an undialable
     * provider contributes nothing and never throws.
     */
    async #discoverProviders(pull: (peer: PeerId) => Promise<void>): Promise<void> {
        const libp2p = this.#deps.helia.libp2p;
        const contentRouting = libp2p.contentRouting;
        if (contentRouting === undefined) return; // the injected node carries no content router
        let cid: CID;
        try {
            cid = CID.decode(this.#criteriaCid);
        } catch {
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), COLD_START_ROUTER_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.();
        // `@libp2p/interface` bundles its own multiformats copy, so its `CID` is nominally distinct
        // from ours despite identical bytes; bridge the two at this one boundary call.
        const routingCid = cid as unknown as Parameters<typeof contentRouting.findProviders>[0];
        try {
            const dials: Promise<void>[] = [];
            let count = 0;
            for await (const provider of contentRouting.findProviders(routingCid, { signal: controller.signal })) {
                if (count >= COLD_START_PEERS) break;
                count += 1;
                dials.push(
                    (async () => {
                        try {
                            if (provider.multiaddrs.length > 0) {
                                await libp2p.dial(provider.multiaddrs, { signal: controller.signal });
                            }
                        } catch {
                            // Undialable via its advertised addrs — `pull` still tries (it may be connected).
                        }
                        await pull(provider.id);
                    })()
                );
            }
            await Promise.allSettled(dials);
        } catch {
            // Router error or abort — treated as "no providers", mirroring pkc-js's findProviders wrap.
        } finally {
            clearTimeout(timer);
        }
    }

    async leave(): Promise<void> {
        if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
        this.#heartbeatTimer = undefined;
        this.#heardMatchingRoot = false;
        this.#publishedRootThisInterval = false;
        this.#chaser = undefined;
        this.#joined = false;
        await this.#transport?.stop();
        this.#transport = undefined;
    }

    /**
     * Sign the votes into a bundle for the current bucket boundary block (the block every verifier
     * reads at), add it to the CRDT, and return the bundle plus its encoded block bytes for
     * broadcast. Throws `ReadOnlyError` with no signer.
     */
    async signVote(votes: Vote[]): Promise<{ bundle: VotesBundle; encoded: Uint8Array }> {
        const signer = this.#deps.signer;
        if (signer === undefined) throw new ReadOnlyError();

        const head = await this.#ruleChain.getBlockNumber();
        const bucket = this.#bucketMath.bucketForBlock(Number(head));
        this.#currentBucketCache = bucket;
        const blockNumber = this.#bucketMath.sampleBlockForBucket(bucket);
        const typedData = ballotTypedData({ criteriaCid: this.#criteriaCid, chainId: this.#chainId, votes, blockNumber });
        const signature = await signer.signBallot(typedData);
        const address = await signer.address();
        const bundle = VotesBundleSchema.parse({ address, votes, blockNumber, signature });

        await this.#crdt.add(bundle);
        this.#onStateChanged();
        return { bundle, encoded: encodeBundle(bundle) };
    }

    /**
     * Broadcast an encoded bundle inline as a live delta (this wallet's own delta, never the set).
     * Returns how many peers gossipsub sent it directly to (0 if there is no live transport).
     */
    async broadcastBundle(encoded: Uint8Array): Promise<{ recipientCount: number }> {
        return (await this.#transport?.publishBundle(encoded)) ?? { recipientCount: 0 };
    }

    /** Invalidate the on-demand checkpoint cache: the winner-set changed (publish/merge/chase). */
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
    async rootRecord(): Promise<FetchRootRecord> {
        const bucket = this.#currentBucketCache;
        const cached = this.#rootRecordCache;
        if (!this.#checkpointDirty && cached !== undefined && cached.bucket === bucket) return cached.record;
        const winners = this.#crdt.current(bucket);
        const { root, chunks, blocks } = await encodeCheckpoint(winners);
        for (const block of blocks) await this.#deps.blockstore.put(block.cid, block.bytes);
        const record: FetchRootRecord = {
            version: ROOT_RECORD_VERSION,
            root,
            // The chunk-CID index rides the fetch-protocol response so a cold joiner skips the
            // root-manifest bitswap round-trip (see DESIGN.md "Block pull"). Stripped from the
            // pubsub heartbeat by `encodeRootMessage`, which keeps that message constant-size.
            chunks,
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
     * matching our own root ⇒ note it for heartbeat suppression; differing ⇒ chase it lazily and
     * answer with our own record at most once per interval. See DESIGN.md "Checkpoints".
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
}

/** The reactive read view over one contest engine ({@link Contest}). */
class ContestView implements Contest {
    readonly #engine: ContestEngine;
    readonly #updateCbs: Array<() => void> = [];
    readonly #errorCbs: Array<(error: unknown) => void> = [];
    /** True between `update()` and `stop()`: our engine listeners are registered. */
    #subscribed = false;

    readonly #onEngineUpdate = (): void => {
        for (const cb of [...this.#updateCbs]) cb();
    };
    readonly #onEngineError = (error: unknown): void => {
        for (const cb of [...this.#errorCbs]) cb(error);
    };

    constructor(engine: ContestEngine) {
        this.#engine = engine;
    }

    get criteria(): Criteria {
        return this.#engine.criteria;
    }
    get topic(): string {
        return this.#engine.topic;
    }
    get tally(): ContestTally | undefined {
        return this.#engine.cachedTally;
    }

    async update(): Promise<void> {
        if (this.#subscribed) return;
        await this.#engine.join();
        this.#engine.addUpdateListener(this.#onEngineUpdate);
        this.#engine.addErrorListener(this.#onEngineError);
        this.#subscribed = true;
        // Populate `tally` and fire an initial `update` for the current state.
        await this.#engine.refreshTallyNow();
    }

    async stop(): Promise<void> {
        if (this.#subscribed) {
            this.#engine.removeUpdateListener(this.#onEngineUpdate);
            this.#engine.removeErrorListener(this.#onEngineError);
            this.#subscribed = false;
        }
        await this.#engine.leave();
    }

    getTally(options?: TallyOptions): Promise<ContestTally> {
        return this.#engine.computeTally(options);
    }

    /**
     * Internal hook (not part of the {@link Contest} interface): this contest's current checkpoint
     * root record, encoded on demand. The fetch responder and heartbeat use the engine directly;
     * this delegate exists so hosts/tests can inspect the checkpoint through the view.
     */
    rootRecord(): Promise<FetchRootRecord> {
        return this.#engine.rootRecord();
    }
    /** Internal hook: the root CID of the last-encoded checkpoint, or `undefined` before the first. */
    latestCheckpointRoot(): CID | undefined {
        return this.#engine.latestCheckpointRoot();
    }

    on(event: "update", cb: () => void): void;
    on(event: "error", cb: (error: unknown) => void): void;
    on(event: "update" | "error", cb: (error?: unknown) => void): void {
        if (event === "update") this.#updateCbs.push(cb as () => void);
        else if (event === "error") this.#errorCbs.push(cb as (error: unknown) => void);
    }
}

/** One publishable ballot over a contest engine ({@link ContestVote}). */
class ContestVotePublication implements ContestVote {
    readonly contestId: string;
    readonly votes: readonly Vote[];
    readonly #engine: ContestEngine;
    readonly #stateCbs: Array<(state: PublishingState) => void> = [];
    readonly #errorCbs: Array<(error: unknown) => void> = [];
    #state: PublishingState = "stopped";
    #bundle: VotesBundle | undefined;

    constructor(engine: ContestEngine, contestId: string, votes: Vote[]) {
        this.#engine = engine;
        this.contestId = contestId;
        this.votes = votes;
    }

    get topic(): string {
        return this.#engine.topic;
    }
    get publishingState(): PublishingState {
        return this.#state;
    }
    get bundle(): VotesBundle | undefined {
        return this.#bundle;
    }

    #setState(state: PublishingState): void {
        this.#state = state;
        for (const cb of [...this.#stateCbs]) cb(state);
    }

    #fail(error: unknown): void {
        this.#setState("failed");
        for (const cb of [...this.#errorCbs]) cb(error);
    }

    async publish(): Promise<PublishOutcome> {
        // Fail before joining a read-only voter needlessly to the topic.
        if (this.#engine.readOnly) {
            const error = new ReadOnlyError();
            this.#fail(error);
            throw error;
        }
        try {
            await this.#engine.join();
            this.#setState("signing");
            const { bundle, encoded } = await this.#engine.signVote([...this.votes]);
            this.#bundle = bundle;
            this.#setState("publishing");
            const { recipientCount } = await this.#engine.broadcastBundle(encoded);
            this.#setState("succeeded");
            return { bundle, recipientCount };
        } catch (error) {
            this.#fail(error);
            throw error;
        }
    }

    on(event: "publishingstatechange", cb: (state: PublishingState) => void): void;
    on(event: "error", cb: (error: unknown) => void): void;
    on(event: "publishingstatechange" | "error", cb: (arg: never) => void): void {
        if (event === "publishingstatechange") this.#stateCbs.push(cb as (state: PublishingState) => void);
        else if (event === "error") this.#errorCbs.push(cb as (error: unknown) => void);
    }
}

/**
 * The default `VoteClient`. Construct with the host-injected seams: a `helia` node (must carry a
 * gossipsub service, a blockstore, and a libp2p fetch service), a `chains` factory, the `manifest`
 * this voter owns (required — every contest is derived from it and addressed by `contestId`), an
 * optional `signer`, and optional `nameResolvers` (needed once votes carry community names). The
 * library has no knowledge of pkc-js or any other host: a host passes its own running Helia node
 * in directly. Republishing a live vote is the client's concern — see
 * {@link republishIntervalBuckets} and DESIGN.md "Republishing is the client's job".
 */
export class PubsubVoter implements VoteClient {
    readonly #deps: ResolvedDeps;
    /** One engine per contest, keyed by topic so identical criteria share one CRDT/transport. */
    readonly #engines = new Map<string, ContestEngine>();
    /** Cached read views, one per topic (stable per-contest object). */
    readonly #views = new Map<string, ContestView>();
    /**
     * Every contest this voter owns, derived from the constructor manifest and keyed by its
     * unique `contestId` (validated at construction). This is the single source of contests;
     * `createContest`/`createContestVote`/`start()` all read from it, and it fixes `contestIds` order.
     */
    readonly #criteriaById: Map<string, Criteria>;
    /** True once the fetch responder is registered (by `start()`), so teardown can unregister once. */
    #responderRegistered = false;
    /** True once `destroy()` ran. Terminal: every create/start path then throws (mirrors pkc-js). */
    #destroyed = false;

    constructor(options: PubsubVoterOptions) {
        // Fail fast: the node must expose a gossipsub service, a blockstore, and a libp2p
        // fetch service. Throws MissingPubsubError / MissingBlockstoreError / MissingFetchError
        // at construction (not a lazy failure on the first publish/fetch) and narrows the handles.
        const { pubsub, blockstore, fetch } = requireHeliaServices(options.helia);
        this.#deps = {
            helia: options.helia,
            pubsub,
            blockstore,
            fetch,
            chains: options.chains,
            signer: options.signer,
            registry: resolveRegistry(options.rules),
            nameResolvers: options.nameResolvers ?? []
        };

        // The manifest is mandatory in v1: derive every contest up front, validate each
        // against the rule registry, and reject a duplicate `contestId` — the id is how a
        // host addresses one contest, so it must be unique.
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

    /** Guard the create/start paths after {@link destroy}: a destroyed voter is terminal. */
    #assertLive(): void {
        if (this.#destroyed) throw new VoterDestroyedError();
    }

    async createContest(args: { contestId: string }): Promise<Contest> {
        this.#assertLive();
        const engine = await this.#engineFor(this.#criteriaOrThrow(args.contestId));
        const existing = this.#views.get(engine.topic);
        if (existing) return existing;
        const view = new ContestView(engine);
        this.#views.set(engine.topic, view);
        return view;
    }

    async createContestVote(args: { contestId: string; votes: Vote[] }): Promise<ContestVote> {
        this.#assertLive();
        const engine = await this.#engineFor(this.#criteriaOrThrow(args.contestId));
        return new ContestVotePublication(engine, args.contestId, args.votes);
    }

    #criteriaOrThrow(contestId: string): Criteria {
        const criteria = this.#criteriaById.get(contestId);
        if (!criteria) throw new UnknownContestError(contestId, [...this.#criteriaById.keys()]);
        return criteria;
    }

    /** Build (or return the cached) engine for one already-validated criteria, keyed by topic. */
    async #engineFor(criteria: Criteria): Promise<ContestEngine> {
        const cid = await criteriaCid(criteria);
        const topic = TOPIC_PREFIX + cid.toString();
        const existing = this.#engines.get(topic);
        if (existing) return existing;
        const engine = new ContestEngine(criteria, topic, cid.bytes, this.#deps);
        this.#engines.set(topic, engine);
        return engine;
    }

    /**
     * The fetch-protocol responder: answer `"<topic>/root"` with that contest's current root
     * record, encoded on demand (see DESIGN.md "Checkpoints"). Unauthenticated and tiny by
     * design — a request can never compel blocks; those travel over directed bitswap. An
     * unknown topic, foreign key shape, or encode failure answers nothing.
     */
    readonly #rootLookup = async (keyBytes: Uint8Array): Promise<Uint8Array | undefined> => {
        // `@libp2p/fetch` hands the lookup the requested key as raw bytes; decode the utf8 topic
        // string the requester sent (`rootFetchKey(topic)`) before matching.
        const key = new TextDecoder().decode(keyBytes);
        if (!key.endsWith(ROOT_FETCH_KEY_SUFFIX)) return undefined;
        const engine = this.#engines.get(key.slice(0, -ROOT_FETCH_KEY_SUFFIX.length));
        if (!engine) return undefined;
        try {
            return encodeRootRecord(await engine.rootRecord());
        } catch {
            return undefined;
        }
    };

    async start(): Promise<void> {
        this.#assertLive();
        const engines = await Promise.all([...this.#criteriaById.values()].map((criteria) => this.#engineFor(criteria)));
        // One responder for every contest this voter serves, keyed by the shared topic prefix.
        if (!this.#responderRegistered) {
            this.#deps.fetch.registerLookupFunction(TOPIC_PREFIX, this.#rootLookup);
            this.#responderRegistered = true;
        }
        // Join each topic (installs the forward gate, arms the heartbeat, fires cold-start).
        for (const engine of engines) await engine.join();
    }

    async stop(): Promise<void> {
        this.#unregisterResponder();
        await this.stopAll();
    }

    async stopAll(): Promise<void> {
        // Reset each read view (detach its engine listeners, clear `#subscribed`) so it can
        // `update()` again — this is what keeps `stop()` reusable. Then leave any engine with no
        // view (created via `createContestVote` / `start`); `leave()` is idempotent, so
        // double-leaving a view's engine is a no-op.
        await Promise.all([...this.#views.values()].map((view) => view.stop()));
        await Promise.all([...this.#engines.values()].map((engine) => engine.leave()));
    }

    async destroy(): Promise<void> {
        // Terminal, mirroring pkc-js: mark the voter and every engine destroyed BEFORE tearing
        // down, so any create/start path and any pre-existing view/publication (whose `update()` /
        // `publish()` funnels through `engine.join()`) now throws `VoterDestroyedError`. `stopAll()`
        // then resets the views and leaves every topic. Unlike `stop()`, the client does not come back.
        this.#destroyed = true;
        for (const engine of this.#engines.values()) engine.markDestroyed();
        this.#unregisterResponder();
        await this.stopAll();
    }

    #unregisterResponder(): void {
        if (!this.#responderRegistered) return;
        this.#deps.fetch.unregisterLookupFunction(TOPIC_PREFIX, this.#rootLookup);
        this.#responderRegistered = false;
    }
}
