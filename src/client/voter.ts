import pLimit from "p-limit";
import { CriteriaSchema, type Criteria } from "../schema/criteria.js";
import { VotesBundleSchema, type Vote, type VotesBundle } from "../schema/votes.js";
import type { ChainClient, ChainClientFactory, ChainClients, NameResolver } from "../chain/types.js";
import { coalescingChainFactory } from "../chain/coalescer.js";
import { makeBucketMath } from "../chain/bucket.js";
import { tickerForRef } from "../chain/ticker.js";
import type {
    BlockstoreLike,
    FetchServiceLike,
    HeliaInstance,
    PubsubService,
    SubscriptionChangeListener,
    VoteTransport
} from "../transport/types.js";
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
    decodeBulkRootRecords,
    encodeBulkRootRecords,
    BULK_ROOTS_FETCH_KEY,
    BULK_ROOTS_MAX_RECORDS,
    BULK_ROOTS_MAX_INLINE_BYTES,
    MAX_ROOT_MESSAGE_BYTES,
    ROOT_FETCH_KEY_SUFFIX,
    ROOT_RECORD_VERSION,
    type RootRecord,
    type FetchRootRecord,
    type BulkRootRecords
} from "../transport/messages.js";
import { makeRootChaser, toChaseSession, type RootChaser } from "../transport/chase.js";
import { encodeBundle, decodeBundle, bundleCidForBytes } from "../crdt/codec.js";
import type { RuleRegistry } from "../rules/types.js";
import { resolveRegistry, validateCriteriaRules } from "../rules/registry.js";
import { makeVoteCrdt } from "../crdt/crdt.js";
import type { VoteCrdt } from "../crdt/types.js";
import { makeBundleVerifier } from "../verify/bundle.js";
import { makeVerdictCache } from "../verify/cache.js";
import { makePersistentGateResultCache, purgeExpiredGateResults } from "../verify/gate-result-cache.js";
import { makeNameResolutionCache, type NameResolutionCache } from "../verify/name-resolution-cache.js";
import { makeStorage } from "../storage/node.js";
import type { LruStorage, SnapshotStorage } from "../storage/types.js";
import { makeAnnouncer } from "../transport/announce/node.js";
import type { Announcer } from "../transport/announce/types.js";
import { encode as encodeDagCbor } from "@ipld/dag-cbor";
import { sha256 } from "viem";
import { makeBackgroundVerifier, type BackgroundChainVerifier, type PendingBundle } from "../verify/background.js";
import type { BundleChecks, VerifyFail } from "../verify/types.js";
import { preflightCommunityNames } from "../verify/name-preflight.js";
import { makeAcceptedDedup } from "../transport/accepted-dedup.js";
import { blockForBytes, decodeCheckpoint, encodeCheckpoint, type CheckpointBlock } from "../checkpoint/codec.js";
import { decodeSnapshot, encodeSnapshot } from "../checkpoint/snapshot.js";
import { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
import { makeTally } from "../tally/tally.js";
import type { ContestTally } from "../tally/types.js";
import type { VoteSigner } from "../signer/types.js";
import { ballotTypedData } from "../signer/eip712.js";
import { criteriaCid, TOPIC_PREFIX } from "../topic.js";
import {
    InvalidCommunityNameError,
    MissingChainClientError,
    ReadOnlyError,
    UnknownRuleError,
    VoteEvictedError,
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
 * calling `createContestVote({ criteria, votes }).publish()` again before then.
 */
export function republishIntervalBuckets(criteria: Criteria): number {
    return Math.ceil(criteria.voteExpiryBuckets / 2);
}

/**
 * Public facade — three objects, mirroring pkc-js / plebbit-js:
 *   - {@link PubsubVoter} (`VoteClient`): the factory. Holds the host-injected dependencies once
 *     and owns one engine per contest, keyed by topic. A contest is addressed by its full criteria
 *     document — `createContest({ criteria })` validates it and derives the topic — so a directory
 *     host like 5chan authors its 63 documents however it likes (e.g. merged from a local
 *     manifest) and creates each contest, without wiring dependencies 63 times.
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

/**
 * A vote publication's lifecycle, walked by {@link ContestVote.publish}. `"succeeded"` means
 * signed, admitted locally, and broadcast — NOT accepted by the network (gossipsub gives a
 * publisher no acceptance/rejection feedback). It can therefore still flip to `"failed"`
 * afterwards: if this node's own deferred checks — the same checks every peer runs — evict the
 * bundle, the vote emits a `VoteEvictedError` and fails post hoc (see DESIGN.md "Background
 * chain verification", publisher feedback).
 */
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

    /** Compute the current contest ranking fresh, bypassing the cache. */
    getTally(): Promise<ContestTally>;

    /**
     * Fired when incoming votes change the state; `tally` carries the freshly recomputed
     * ranking. Background check settlements fire it too: a cold join emits a first tally with
     * `chainVerified: false` rows immediately, then re-emits as the batched gate reads and name
     * resolutions land (see DESIGN.md "Background chain verification").
     */
    on(event: "update", cb: () => void): void;
    /**
     * Fired on a contest-level failure: the tally's chain read throws, the background chain
     * verifier hits an infra-class failure (RPC/resolver down — its bundles stay pending and
     * retry, but the degradation is surfaced here instead of silently stalling), or a deferred
     * check evicts THIS wallet's own published vote (`VoteEvictedError` — the same error the
     * publishing `ContestVote` emits; here so a long-lived view hears it too).
     */
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
     * failure: `ReadOnlyError` with no signer, and `InvalidCommunityNameError` when a vote's
     * carried `community.name` definitively does not resolve to its claimed `publicKey` (checked
     * BEFORE signing or joining — every verifier drops such a bundle silently, so it is refused
     * here instead of published into a network-wide silent drop; a resolver outage does not block
     * the publish). This library does not re-publish: to keep the vote alive, call `publish()`
     * again before it expires.
     */
    publish(): Promise<PublishOutcome>;

    /** Fired on each `publishingState` transition. */
    on(event: "publishingstatechange", cb: (state: PublishingState) => void): void;
    /**
     * Fired if publishing fails — including POST HOC, after `publish()` resolved: gossipsub
     * peers reject a bad bundle silently, but this node runs the same deferred checks (gate
     * chain read, name resolution) on its own publish, and if they evict it a `VoteEvictedError`
     * fires here (and `publishingState` flips to `"failed"`) carrying the exact verdict every
     * honest verifier would produce. See DESIGN.md "Background chain verification".
     */
    on(event: "error", cb: (error: unknown) => void): void;
}

/** The factory: one set of injected dependencies, many contests. */
export interface VoteClient {
    /** True when constructed without a signer: every contest is read-only. */
    readonly readOnly: boolean;
    /**
     * Create the reactive read view for one contest from its full criteria document. The document
     * is strictly validated (`CriteriaSchema` + the rule registry — an unimplemented rule throws
     * `UnknownRuleError`) and its topic derived (`topic = CID(dag-cbor(criteria))`). Returns the
     * stable per-topic object (one CRDT/engine per topic per node), so repeated calls with
     * byte-identical criteria return the same `Contest`.
     */
    createContest(args: { criteria: Criteria }): Promise<Contest>;
    /**
     * Create a publishable ballot for one contest, validated and addressed exactly like
     * `createContest`. Each call returns a fresh `ContestVote` over the shared per-topic engine;
     * pass `votes: []` to build a withdrawal.
     */
    createContestVote(args: { criteria: Criteria; votes: Vote[] }): Promise<ContestVote>;
    /**
     * Leave every topic this client joined, resetting each read view so it can `update()` again.
     * The checkpoint fetch responder unregisters itself once the last topic is left (see
     * `PubsubVoter`'s lazy responder lifecycle). The client stays fully reusable — call
     * `createContest` / `update()` after.
     */
    stop(): Promise<void>;
    /**
     * Terminal teardown (mirrors pkc-js `destroy`): leave every topic, unregister the fetch
     * responder, and mark the voter and all its contests destroyed. Unlike `stop`, this is NOT
     * reusable — every subsequent `createContest` / `createContestVote`, and any pre-existing
     * `Contest.update()` / `ContestVote.publish()`, throws `VoterDestroyedError`. Construct a new
     * `PubsubVoter` to participate again. There is no store to dispose (republishing / persistence
     * is the client's concern).
     */
    destroy(): Promise<void>;
}

/** Construction options for {@link PubsubVoter}. */
export interface PubsubVoterOptions {
    /**
     * The host's running Helia node (the value `createHelia` returns; for pkc-js it is
     * `pkc.clients.libp2pJsClients[key].heliaNode`). The only host-node seam, passed
     * directly with no adapter. It MUST carry a gossipsub service at
     * `libp2p.services.pubsub`, a usable `blockstore`, and a libp2p fetch service at
     * `libp2p.services.fetch`; the constructor throws `MissingPubsubError` /
     * `MissingBlockstoreError` / `MissingFetchError` otherwise (a plain Helia node has
     * no pubsub). The library never starts or stops this node.
     */
    helia: HeliaInstance;
    /**
     * Resolves a chain named by a contest's criteria (`requires.chains`, ticker + chainId)
     * to a viem `PublicClient`. Which RPC gateway to use is THIS client's setting — RPC URLs
     * are deliberately not part of the criteria document, so this factory is where the host
     * maps chains to the endpoints it trusts. Return one shared client per chain (memoized),
     * and `undefined` for a chain with no RPC configured — `createContest` /
     * `createContestVote` then throws `MissingChainClientError` (recuse, don't miscount).
     * See `ChainClientFactory` (src/chain/types.ts) for the full contract.
     */
    chains: ChainClientFactory;
    /** Identity. Omit for a read-only voter (renders tallies, cannot publish). */
    signer?: VoteSigner;
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
     * Delegated Routing V1 router base URLs to ANNOUNCE provider records to (one unsigned
     * `PUT /routing/v1/providers` per router, `Keys` batched across all joined contests:
     * each contest's criteria CID + current checkpoint root + chunk CIDs — hourly, debounced
     * on checkpoint/root changes, and on `self:peer:update` address changes). Absent or empty
     * means never announce — the default, correct for plain clients: only a publicly dialable
     * node (a seeder) should set this, and the browser build never announces regardless (the
     * announcer is a Node-only module, stubbed inert by the package.json `browser` remap).
     * QUERYING needs no URLs here — `#discoverProviders` rides the injected node's
     * `libp2p.contentRouting`, which the host wires its routers into; this option exists only
     * because the pinned js stack has no working announce path (`provide()` is a noop). See
     * DESIGN.md "Deferred pkc-js work", provider-record announces.
     */
    httpRouterUrls?: string[];
    /**
     * Directory for the voter's persistent state, the pkc-js `dataPath` equivalent: the
     * gate-result and name-resolution caches, plus each joined contest's **checkpoint
     * snapshot** — the node's own last fully-verified winner-set, written debounced on
     * changes and reloaded at join, so a seeder restarting with no other peer online does
     * not lose the tally. On Node this is better-sqlite3 databases under
     * `{dataPath}/lru-storage/` plus `{dataPath}/checkpoints.db`; in the browser the path
     * is ignored and everything lives in IndexedDB (via localforage) either way. Defaults
     * to `{cwd}/.bitsocial-pubsub-voting` on Node. Pass `false` for in-memory-only (no
     * disk, no IndexedDB — the pkc-js `noData` equivalent): nothing survives the process,
     * but nothing is written either. A seeder should ALWAYS set a stable path.
     */
    dataPath?: string | false;
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
    /**
     * Engine → voter notifications, fired exactly once per real topic join / leave transition.
     * They drive the voter's lazy fetch-responder lifecycle: the responder is registered while
     * at least one engine is joined, so a node serves root records for exactly the contests it
     * participates in, for exactly as long as it participates.
     */
    onTopicJoined: () => void;
    onTopicLeft: () => void;
    /**
     * Engine → voter notification that the checkpoint winner-set changed (any merge, publish,
     * chase admit, or background settlement — the same transitions that dirty the on-demand
     * encode cache). Drives the provider-record announcer's debounced re-announce, so router
     * records track the current root without polling. A cheap no-op when no announcer is
     * configured.
     */
    onCheckpointChanged: () => void;
    /**
     * Voter-wide per-peer budget for cold-start root fetches: runs `task` once fewer than
     * {@link COLD_START_PEER_FETCH_LIMIT} fetches to `peerId` are in flight across ALL engines,
     * so a directory-wide join never trips a peer's per-protocol inbound-stream cap by itself.
     * Lives on the voter (not the engine) because the cap it protects is per peer, not per topic.
     */
    fetchBudget: <T>(peerId: string, task: () => Promise<T>) => Promise<T>;
    /**
     * Fetch one contest's root record from a peer, batched voter-wide: concurrent pulls against the
     * same peer collapse into a single bulk request (see {@link makeRootPuller}). Engines call this
     * instead of the fetch service directly, so a directory-wide cold start costs one round trip per
     * peer rather than one per contest. Returns the encoded record, or `undefined`/`null` when the
     * peer has none for that topic.
     */
    pullRoot: (peer: PeerId, topic: string) => Promise<Uint8Array | undefined | null>;
    /**
     * Read one chain's current head block number, coalescing concurrent callers onto a single
     * in-flight `getBlockNumber` (keyed on the shared client instance). A directory-wide burst of
     * tally recomputes — every one of which refreshes its expiry bucket (see
     * {@link ContestEngine#refreshBucket}) — shares one head read per chain instead of each firing
     * its own, without ever serving a stale head to a later read. See {@link makeHeadReader}.
     */
    readHead: (chain: ChainClient) => Promise<bigint>;
    /**
     * The voter's persisted gate results, shared across ALL contests (keys carry each
     * contest's rule hash, so two contests over one gate — a 5chan-style directory — share
     * each other's reads; different rules cannot collide). See verify/gate-result-cache.ts.
     */
    gateStore: LruStorage;
    /** The voter's persisted name resolutions, shared across all contests (pkc-js rule). */
    nameResolutionCache: NameResolutionCache;
    /**
     * The voter's persisted checkpoint snapshots, one blob per topic: each engine's own last
     * fully-verified checkpoint, written debounced on winner-set changes and reloaded at
     * `join()`, so a seeder restarting with no other peer online does not lose the tally
     * (see DESIGN.md "Persistent caches", checkpoint snapshots).
     */
    snapshots: SnapshotStorage;
}

/**
 * LRU bound for the voter's persisted gate results (all contests share the store; entries are a
 * short key + a decimal score, so this is single-digit MB at worst). Deliberately far above the
 * name cache's pkc-js-parity 5000: one directory join can write `boards × wallets` entries in a
 * bucket, and the deterministic sample-block purge (not this bound) is the intended eviction.
 */
const GATE_RESULTS_MAX_ITEMS = 50_000;
/** LRU bound for persisted name resolutions — pkc-js's `CACHE_MAX_ITEMS` for the same cache. */
const NAME_RESOLUTIONS_MAX_ITEMS = 5_000;
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
 * Per-provider dial deadline (ms) for cold-join discovery source 2. Each provider dial shares the
 * router-lookup {@link COLD_START_ROUTER_TIMEOUT_MS} signal, but is ALSO bounded on its own by this
 * shorter timeout — because a browser WSS dial can HANG (neither resolve nor reject) indefinitely,
 * and since the root-record `pull` only runs after the dial await settles, a hung dial otherwise
 * gates the pull for the full 10s router timeout even when a connection to that peer opens by other
 * means in the meantime. Measured in production browser traces: 4 of 32 recent cold-start rounds hit
 * the hang, turning ~6s loads into 8.7–22s totals. Bounding the dial at 3s lets the catch swallow the
 * timeout and fire `pull` at ≤3s instead of ≤10s; only the dial is cut, never the pull.
 */
const COLD_START_DIAL_TIMEOUT_MS = 3_000;
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
/**
 * Per-peer budget for concurrent cold-start root fetches, shared across ALL contests on one
 * voter (see {@link ResolvedDeps.fetchBudget}). The retry above rides out a saturated responder,
 * but a directory-wide join should not be the one saturating it: this budget caps how many fetch
 * streams *we* hold open to any single peer, under libp2p's default per-protocol caps (32 inbound
 * on the responder, 64 outbound on us — both enforced PER CONNECTION per direction, so one
 * connection's budget is exactly the scope of the remote cap; other users of a shared seeder
 * arrive on their own connections and do not eat these slots). 24 rather than the full 32
 * because running at the cliff still resets: our slot frees when the response lands, but the
 * responder only decrements its count when it sees the stream *close*, so back-to-back reuse
 * races that bookkeeping — and the same connection can carry fetch streams this budget cannot
 * see (the host's own IPNS-over-pubsub record fetches ride the same protocol; so would a second
 * voter on the shared node). The retry covers those residuals. Excess contests queue per peer
 * instead of getting reset — and because cold-start also shuffles which peers it asks (see the
 * shuffle in `#coldStart`), a multi-peer topic spreads a directory join across serving peers
 * instead of funnelling every contest through the same first-listed peer's cap while the
 * others idle.
 */
const COLD_START_PEER_FETCH_LIMIT = 24;
/**
 * How long after `join()` the cold-start pull stays armed on gossipsub's `subscription-change`
 * (see `#armSubscriptionRepull`). One heartbeat interval: the window exists to close the
 * join-races-subscription-gossip gap (issue #15), and past the first heartbeat the passive
 * root-record heartbeat covers divergence detection anyway — an unbounded listener would
 * instead pay one root fetch per churning subscriber for the node's whole lifetime.
 */
const COLD_START_REPULL_WINDOW_MS = HEARTBEAT_INTERVAL_MS;
/**
 * Debounce (ms) for persisting the checkpoint snapshot after a winner-set change, mirroring the
 * announcer's cadence on the same transition: a gossip burst costs one write per window, and
 * `leave()` flushes whatever is still pending so a clean shutdown never loses the tail.
 */
const SNAPSHOT_DEBOUNCE_MS = 10_000;
/** Per-root chase deadline (ms): a multi-block directed-bitswap pull, coarser than one message. */
const CHASE_TIMEOUT_MS = 30_000;
/** Concurrent root chases; a spray of divergent roots queues, never floods. */
const CHASE_CONCURRENCY = 2;
/**
 * Chase-session provider slots above the advertiser seeds: the headroom keeps the session's
 * background provider discovery running, so the HTTP routers are queried ONCE per chased root —
 * in parallel with the seeded wants, instead of once per block — and a provider found there
 * (a seeder announcing root/chunk records need not be a topic subscriber) joins the pull if the
 * advertiser drops mid-chase. See DESIGN.md "Block pull".
 */
const CHASE_SESSION_PROVIDER_HEADROOM = 1;
/**
 * Bound on the per-contest peer→last-advertised-root map that seeds chase sessions (insertion-
 * refreshed, oldest evicted): enough for any real topic mesh, small enough that a peer-id spray
 * cannot grow memory.
 */
const PEER_ROOTS_MAX = 256;
/**
 * How long a gating-chain head read stays fresh (ms) for the gate's freshness guard. Steady-
 * state votes cost no read (they resolve against the cached bucket); only a look-ahead bundle
 * consults the head, and this TTL caps that to ≤1 `getBlockNumber` per window under a flood of
 * future-dated bundles.
 */
const HEAD_BUCKET_TTL_MS = 1_000;

/**
 * The {@link ResolvedDeps.fetchBudget} factory: one `pLimit(limitPerPeer)` per peer id, created on
 * first use and dropped once its queue drains, so a long-lived voter does not accumulate limiters
 * for every peer it ever cold-started against.
 */
function makePerPeerBudget(limitPerPeer: number): <T>(peerId: string, task: () => Promise<T>) => Promise<T> {
    const limiters = new Map<string, ReturnType<typeof pLimit>>();
    return async (peerId, task) => {
        let limiter = limiters.get(peerId);
        if (limiter === undefined) {
            limiter = pLimit(limitPerPeer);
            limiters.set(peerId, limiter);
        }
        try {
            return await limiter(task);
        } finally {
            if (limiter.activeCount === 0 && limiter.pendingCount === 0) limiters.delete(peerId);
        }
    };
}

/**
 * The {@link ResolvedDeps.readHead} factory: coalesce CONCURRENT `getBlockNumber` calls to one chain
 * onto a single in-flight read, keyed on the client instance (a `WeakMap`, so a chain the voter stops
 * using is collected). It deliberately does NOT cache across time — the moment a read settles its
 * slot clears, so the next caller reads a fresh head. Only callers that arrive WHILE a read is in
 * flight share it.
 *
 * In-flight sharing curbs the cold-start `getBlockNumber` storm. Every tally recompute refreshes its
 * expiry bucket off the gating chain's head, and a directory join drives ~4 recomputes per contest (a
 * chased-bundle admit plus two deferred-check settlements) across dozens of contests that all share
 * ONE gating-chain client — so the reads land in overlapping bursts. Measured on the production 5chan
 * cold start (63 contests, Chromium): 252 `readHead` calls collapse to 66 actual `getBlockNumber`
 * posts (−74%), a real cut in redundant RPC to the shared endpoint (which the read coalescer's own
 * notes show throttles concurrent posts) and in main-thread promise churn.
 *
 * It is NOT a first-tally latency win, and the commit is careful not to claim one: the first contest
 * to admit still awaits its own (uncoalesced) head read on the critical path, and the measured
 * bulk→first-tally wall is unchanged within noise — that window is network- and scheduling-bound, not
 * head-read-bound (the 82s of `getBlockNumber` "wall" a naive probe attributes here is an async-overlap
 * artifact: the true per-read CPU is negligible). This is a load/tidiness fix, banked because the
 * redundancy is real and the change is cheap and safe.
 *
 * Coalescing is correct here without any staleness: `getBlockNumber` is a pure current-head read, so
 * two callers overlapping in time genuinely want the same answer. A settled result is never reused, so
 * a later recompute after the head has moved still sees the move (the expiry tests pin this), and a
 * REJECTED read clears its slot too, so a transient RPC failure is retried on the next call rather than
 * shared by latecomers to the same failed read.
 */
export function makeHeadReader(): (chain: ChainClient) => Promise<bigint> {
    const inFlight = new WeakMap<ChainClient, Promise<bigint>>();
    return (chain) => {
        const existing = inFlight.get(chain);
        if (existing !== undefined) return existing; // a read is already in flight — share it
        const head = chain.getBlockNumber();
        inFlight.set(chain, head);
        // Clear the slot the instant the read settles (fulfilled OR rejected), but only if it is
        // still ours — a defensive guard, though nothing replaces an entry before it settles.
        const clear = (): void => {
            if (inFlight.get(chain) === head) inFlight.delete(chain);
        };
        head.then(clear, clear);
        return head;
    };
}

/**
 * How long the root-record batcher holds a peer's first request open, waiting for its siblings.
 * A directory join fans out in one tick, so this only has to survive the microtask queue and the
 * engines' pre-fetch awaits; it is latency added to every cold start, so it stays small.
 */
const BULK_ROOTS_COALESCE_MS = 50;
/**
 * How long a decoded (non-empty) bulk answer stays reusable for later pulls against the same peer.
 * A directory cold start does NOT arrive in one batch: each contest's pull fires when its own
 * router lookup returns, and lookups straggle over seconds — measured against production, a
 * 63-contest cold start coalesced into 3 batches, the last two refetching the byte-identical
 * answer (and the first tally waited on batch 3, not batch 1). Within this window a straggler is
 * served from the previous answer without touching the wire. Staleness is bounded and harmless:
 * a root is an unverifiable hint wherever it comes from, a re-pull that chases an already-chased
 * root dedups in the chaser, and real divergence is what the 10-minute heartbeat exists for.
 * Empty answers are never cached ("I serve nothing yet" expires in seconds on a booting seeder).
 */
const BULK_ROOTS_CACHE_MS = 10_000;
/** Bound on cached bulk answers (one per peer): cold start touches a handful of peers, not 32. */
const BULK_ROOTS_CACHE_MAX_PEERS = 32;

/** The seams a bulk answer feeds beyond its own waiters (both optional; see {@link makeRootPuller}). */
interface RootPullerHooks {
    /**
     * Store one hash-verified inlined chunk block (see `BulkFetchRootRecord.chunkBlocks`). Wired to
     * the host blockstore so the subsequent chase resolves every chunk locally instead of over
     * bitswap. Blocks are verified against their CID BEFORE this is called.
     */
    putBlock?: (cid: CID, bytes: Uint8Array) => Promise<void>;
    /**
     * Hand a record to a contest that did NOT ask for it. A bulk answer names every contest the
     * peer serves — not just the batch that happened to ask — and a directory cold start straggles
     * (each contest pulls only after its own discovery returns), so without this the contests whose
     * router lookup drew a slow path sit idle next to an answer that already covers them. `encoded`
     * is the same re-encoded record bytes a waiter would have received.
     */
    onRecord?: (peer: PeerId, topic: string, encoded: Uint8Array) => void;
}

/**
 * The {@link ResolvedDeps.pullRoot} factory: turn N per-contest root fetches against one peer into
 * ONE bulk fetch (see {@link BULK_ROOTS_FETCH_KEY}), transparently to the engines.
 *
 * Requests to the same peer that arrive within {@link BULK_ROOTS_COALESCE_MS} share one bulk
 * request. Its answer is authoritative for what it contains: a topic PRESENT resolves to that
 * record, and a topic ABSENT from a non-empty answer resolves to "no record" — the peer told us it
 * does not serve that contest, and re-asking individually would rebuild the very fan-out this
 * exists to remove.
 *
 * The one case that does fall back is a peer that answers the bulk key with NOTHING. Those waiters
 * re-issue per-topic fetches — and that verdict is deliberately NOT remembered.
 *
 * Not remembering looks wasteful and is the important part. "Nothing" does not only mean "old
 * peer": the responder registers lazily on the first topic join, so a node that has not joined
 * anything yet has no handler for this prefix at all and answers nothing for a reason that expires
 * in seconds. Caching that verdict would strand a browser that happened to probe a seeder mid
 * startup on the per-contest path for its whole session, long after the seeder began serving the
 * whole directory in one reply. Re-probing per batch costs one wasted round trip per batch against
 * a genuinely old peer (measured: ~3 batches in a cold start) and self-heals against a young one,
 * which is the better trade in both directions.
 *
 * Throws propagate to every waiter in the batch: the engines' own retry loop
 * (`#fetchRootWithRetry`) treats a throw as transient and backs off, which is the correct response
 * to a saturated or resetting peer whether one contest asked or sixty-three did.
 *
 * On top of the batching, one answered request is squeezed for everything it is worth, because a
 * directory cold start does NOT arrive as one tidy batch — each contest pulls only when its own
 * router lookup returns, and lookups straggle over seconds (measured: 3 batches, the last two
 * refetching the byte-identical answer while the first tally waited on them):
 *
 *   - a fresh non-empty answer is CACHED ({@link BULK_ROOTS_CACHE_MS}), so a straggler's pull is
 *     served without touching the wire;
 *   - a pull arriving while a bulk request is already in flight JOINS it;
 *   - topics present in the answer that nobody in the batch asked about fan out to their engines
 *     through {@link RootPullerHooks.onRecord}, so the slowest lookup no longer gates the last
 *     contest's chase;
 *   - inlined checkpoint chunk blocks are hash-verified and stored through
 *     {@link RootPullerHooks.putBlock} BEFORE any waiter resolves, so the chases the answer
 *     triggers find their blocks locally instead of over bitswap.
 */
function makeRootPuller(fetch: FetchServiceLike, hooks: RootPullerHooks = {}): (peer: PeerId, topic: string) => Promise<Uint8Array | undefined | null> {
    type Waiter = { topic: string; resolve: (value: Uint8Array | undefined | null) => void; reject: (error: unknown) => void };
    /** A decoded answer with inline blocks already stripped (verified + stored via `putBlock`). */
    type StrippedRecords = Record<string, FetchRootRecord>;
    const batches = new Map<string, { waiters: Waiter[]; timer: ReturnType<typeof setTimeout> }>();
    /** Non-empty answers kept for {@link BULK_ROOTS_CACHE_MS} so stragglers skip the wire. */
    const cached = new Map<string, { at: number; records: StrippedRecords }>();
    /** In-flight bulk requests: a pull arriving mid-request joins it instead of starting another. */
    const inflight = new Map<string, Promise<StrippedRecords | null>>();

    const fetchOne = async (peer: PeerId, topic: string) => await fetch.fetch(peer, rootFetchKey(topic));

    const serve = (waiter: Waiter, records: StrippedRecords): void => {
        const record = records[waiter.topic];
        // Re-encode rather than thread a decoded record through: the engines' pull path decodes
        // what it receives, so handing back bytes keeps the bulk and per-topic paths identical
        // (and re-validates the entry through the same schema on the way out). A topic ABSENT
        // from a non-empty answer is a definitive "no record" — the peer just told us what it
        // serves, and re-asking individually would rebuild the fan-out this exists to remove.
        if (record === undefined) {
            waiter.resolve(undefined);
            return;
        }
        try {
            waiter.resolve(encodeRootRecord(record));
        } catch (error) {
            waiter.reject(error);
        }
    };

    /**
     * Strip, verify and distribute one decoded bulk answer: inlined chunk blocks are re-hashed and
     * (only when the hash matches their record's chunk CID) stored via `putBlock` — content
     * addressing is the verification, so a lying block simply falls back to the chase — then the
     * answer is cached for stragglers and every topic nobody in this batch asked about is fanned
     * out through `onRecord`. Returns the stripped records the waiters are served from.
     */
    const accept = async (peer: PeerId, id: string, decoded: BulkRootRecords, askedTopics: Set<string>): Promise<StrippedRecords> => {
        const records: StrippedRecords = {};
        const puts: Promise<void>[] = [];
        for (const [topic, entry] of Object.entries(decoded)) {
            const { chunkBlocks, ...record } = entry;
            records[topic] = record;
            // All-or-nothing per record (mirrors the responder): a partial set cannot skip the
            // chase anyway, and a length mismatch means the answer is not what the encoder sends.
            if (chunkBlocks === undefined || hooks.putBlock === undefined || chunkBlocks.length !== record.chunks.length) continue;
            for (let i = 0; i < chunkBlocks.length; i++) {
                const bytes = chunkBlocks[i]!;
                const expected = record.chunks[i]!;
                puts.push(
                    (async () => {
                        try {
                            const block = await blockForBytes(bytes);
                            if (block.cid.equals(expected)) await hooks.putBlock!(block.cid, block.bytes);
                        } catch {
                            // A bad inline block contributes nothing; the chase fetches it instead.
                        }
                    })()
                );
            }
        }
        // Blocks land BEFORE any waiter resolves or record fans out, so the chases they trigger
        // find every verified chunk already local.
        await Promise.all(puts);
        if (Object.keys(records).length > 0) {
            if (cached.size >= BULK_ROOTS_CACHE_MAX_PEERS && !cached.has(id)) {
                const oldest = cached.keys().next().value;
                if (oldest !== undefined) cached.delete(oldest);
            }
            cached.set(id, { at: Date.now(), records });
        }
        if (hooks.onRecord !== undefined) {
            for (const [topic, record] of Object.entries(records)) {
                if (askedTopics.has(topic)) continue;
                try {
                    hooks.onRecord(peer, topic, encodeRootRecord(record));
                } catch {
                    // One unservable record must not stop the fan-out (mirrors `serve`).
                }
            }
        }
        return records;
    };

    const flush = async (peer: PeerId, id: string): Promise<void> => {
        const batch = batches.get(id);
        if (batch === undefined) return;
        batches.delete(id);
        const { waiters } = batch;
        const run = (async (): Promise<StrippedRecords | null> => {
            const answer = await fetch.fetch(peer, BULK_ROOTS_FETCH_KEY);
            if (answer === undefined || answer === null) return null;
            // A malformed bulk answer throws here — this peer's problem, not a reason to re-ask
            // it 63 times: the throw rejects every waiter and the engines' retry loop backs off.
            return await accept(peer, id, decodeBulkRootRecords(answer), new Set(waiters.map((waiter) => waiter.topic)));
        })();
        // Registered synchronously (before any await), so a pull landing after this batch closed
        // but before the answer joins THIS request instead of opening a redundant second one.
        inflight.set(id, run);
        let records: StrippedRecords | null;
        try {
            records = await run;
        } catch (error) {
            for (const waiter of waiters) waiter.reject(error);
            return;
        } finally {
            inflight.delete(id);
        }
        if (records === null) {
            // Either a pre-bulk peer or one whose responder is not registered yet (it has joined
            // nothing so far). Indistinguishable here, and deliberately not cached as a verdict —
            // see this factory's note. Serve this batch per-topic; the next batch re-probes.
            for (const waiter of waiters) {
                fetchOne(peer, waiter.topic).then(waiter.resolve, waiter.reject);
            }
            return;
        }
        for (const waiter of waiters) serve(waiter, records);
    };

    return async (peer, topic) => {
        const id = peer.toString();
        // Freshness first: a straggler whose discovery returned after an earlier batch answered is
        // served from that answer without touching the wire (see BULK_ROOTS_CACHE_MS). Deliberately
        // asymmetric with `serve`: only a topic PRESENT in the cached answer is served from it. The
        // "absent = definitive no record" contract holds within one answer, but a cached answer
        // predates contests joined after it was taken — a fresh batch (one coalesced round trip)
        // re-asks for those instead of handing a late-created contest a stale "no" that would
        // strand it until the heartbeat.
        const fresh = cached.get(id);
        if (fresh !== undefined) {
            if (Date.now() - fresh.at <= BULK_ROOTS_CACHE_MS) {
                const record = fresh.records[topic];
                if (record !== undefined) {
                    return await new Promise<Uint8Array | undefined | null>((resolve, reject) => serve({ topic, resolve, reject }, fresh.records));
                }
            } else {
                cached.delete(id);
            }
        }
        const running = inflight.get(id);
        if (running !== undefined) {
            const records = await running; // a throw propagates: same failure the batch saw
            if (records !== null) {
                return await new Promise<Uint8Array | undefined | null>((resolve, reject) => serve({ topic, resolve, reject }, records));
            }
            return await fetchOne(peer, topic); // the in-flight probe said "no bulk" — go per-topic
        }
        return await new Promise<Uint8Array | undefined | null>((resolve, reject) => {
            const existing = batches.get(id);
            if (existing !== undefined) {
                existing.waiters.push({ topic, resolve, reject });
                return;
            }
            const timer = setTimeout(() => void flush(peer, id), BULK_ROOTS_COALESCE_MS);
            // Don't hold a Node process open for a coalesce window; no-op in the browser.
            (timer as { unref?: () => void }).unref?.();
            batches.set(id, { waiters: [{ topic, resolve, reject }], timer });
        });
    };
}

/** Fisher–Yates copy-shuffle (cold-start peer selection; see `#coldStart`). */
function shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const swap = out[i]!;
        out[i] = out[j]!;
        out[j] = swap;
    }
    return out;
}

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
    /** True between `join()` and `leave()`; makes both idempotent so views and ballots compose. */
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
     * The on-demand checkpoint cache: the last encoded root record, the bucket it was encoded
     * at, and the encoded blocks themselves (also in the blockstore; kept here so the snapshot
     * writer never has to read them back through a seam that can fall back to a network want).
     * Invalidated by {@link #markStateChanged} (any merge/publish/chase admit) and by a bucket
     * advance (expiry changes the winner set without any message). See DESIGN.md "Checkpoints".
     */
    #rootRecordCache: { record: FetchRootRecord; bucket: number; blocks: CheckpointBlock[] } | undefined = undefined;
    /** True when the winner-set changed since the last encode; the next `rootRecord()` re-encodes. */
    #checkpointDirty = true;
    /** Live once joined; chases advertised roots that differ from our own. */
    #chaser: RootChaser | undefined;
    /**
     * Peer id → last root that peer advertised (heartbeat, divergence response, or cold-start
     * pull), bounded by {@link PEER_ROOTS_MAX}. Chasing root R seeds its bitswap session with
     * every still-connected peer whose entry is R — the subscribers who provably converged on
     * the state being pulled — not just the hint's sender. See DESIGN.md "Block pull".
     */
    #peerRoots = new Map<string, string>();
    /** The armed heartbeat timer (jittered; see {@link #armHeartbeat}), cleared by `leave()`. */
    #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    /** The armed (debounced) snapshot-write timer; flushed by `leave()`. See {@link #writeSnapshot}. */
    #snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Tears down the per-join `subscription-change` re-pull (listener + window timer); set by
     * {@link #armSubscriptionRepull}, cleared by `leave()` or by the window expiring.
     */
    #subscriptionRepullDisarm: (() => void) | undefined;
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
        // Resolve every chain the manifest requires, eagerly: a client with no RPC configured
        // for one of them must find out at the create seam (recuse), not on its first verify.
        this.#chainClients = Object.fromEntries(
            Object.entries(criteria.requires.chains).map(([chain, config]): [string, ChainClient] => {
                const client = deps.chains({ chain, chainId: config.chainId });
                if (client === undefined) throw new MissingChainClientError(chain, config.chainId);
                return [chain, client];
            })
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
        // The CRDT keeps a superseded bundle alive while its superseder's deferred checks are
        // pending — the fallback winner if the background verifier evicts the newer bundle.
        this.#crdt = makeVoteCrdt({
            store,
            bucketMath: this.#bucketMath,
            voteExpiryBuckets: criteria.voteExpiryBuckets,
            isProvisional: (cid) => this.#isPending(cid)
        });

        // One gate-result cache shared between the inline forward-gate verifier and the
        // background chain verifier, so neither re-reads a (wallet, sampleBlock) the other
        // settled — layered over the voter's persistent store, keyed under this contest's rule
        // hash: the gate score is a pure function of (rule, chainId, wallet, sampleBlock), so
        // hashing the canonical rule document + chainId is exactly the sharing boundary (two
        // contests over one gate share reads; different gates cannot collide).
        this.#ruleHash = sha256(encodeDagCbor({ chainId: this.#chainId, rule: criteria.rule }));
        const gateResultCache = makePersistentGateResultCache({ store: deps.gateStore, ruleHash: this.#ruleHash });
        const verifier = makeBundleVerifier({
            criteria,
            criteriaCid: criteriaCidBytes,
            chainId: this.#chainId,
            registry: deps.registry,
            chainFor: (ticker) => this.#chainFor(ticker),
            bucketMath: this.#bucketMath,
            nameResolvers: deps.nameResolvers,
            gateResultCache,
            nameResolutionCache: deps.nameResolutionCache
        });
        // The gate/transport are (re)built on join(); the store, crdt, caches, verifier, and
        // background verifier are stable per contest, so they survive re-joins of the topic.
        this.#store = store;
        this.#cache = makeVerdictCache();
        this.#acceptedDedup = makeAcceptedDedup(this.#bucketMath);
        this.#verifier = verifier;
        this.#background = makeBackgroundVerifier({
            criteria,
            registry: deps.registry,
            chainFor: (ticker) => this.#chainFor(ticker),
            bucketMath: this.#bucketMath,
            nameResolvers: deps.nameResolvers,
            gateResultCache,
            nameResolutionCache: deps.nameResolutionCache,
            cache: this.#cache,
            onGateVerified: (cid) => this.#settleCheck(cid, "chainVerified"),
            onNameResolved: (cid) => this.#settleCheck(cid, "nameResolved"),
            onEvict: (cid, verdict) => this.#evictBundle(cid, verdict),
            onError: (error) => this.#emitError(error),
            limit: (fn) => this.#backgroundLimit(fn)
        });

        this.#tally = makeTally({
            criteria,
            registry: deps.registry,
            chainFor: (ticker) => this.#chainFor(ticker),
            bucketMath: this.#bucketMath,
            current: () =>
                this.#crdt
                    .currentEntries(this.#currentBucketCache)
                    .map(({ cid, bundle }) => ({ bundle, checks: this.#checksFor(cid, bundle) })),
            bucketBlockHash: () => this.#bucketBlockHash()
        });
    }

    readonly #store: ReturnType<typeof makeBlockstoreBundleStore>;
    /** Hash of the canonical gate rule + chainId — this contest's keyspace in the shared gate store. */
    readonly #ruleHash: string;
    readonly #cache: ReturnType<typeof makeVerdictCache>;
    readonly #acceptedDedup: ReturnType<typeof makeAcceptedDedup>;
    readonly #verifier: ReturnType<typeof makeBundleVerifier>;
    /** Deferred network checks for provisionally admitted bundles (see verify/background.ts). */
    readonly #background: BackgroundChainVerifier;
    /** Bounds the background verifier's un-batched RPC fallbacks (per-wallet reads, name lookups). */
    readonly #backgroundLimit = pLimit(GATE_CONCURRENCY);
    /**
     * Per-bundle deferred-check state, keyed by bundle CID string. Written at every admit
     * (settled for a gate-verified live bundle or a cached-verdict hit; pending for a chased
     * checkpoint bundle or this wallet's own publish), flipped by the background verifier's
     * settlements, dropped on evict/prune. The tally folds it into each row's
     * `chainVerified` / `nameResolved`, and the checkpoint encoder serves only fully
     * settled bundles (never re-serve what we have not verified).
     */
    readonly #checks = new Map<string, BundleChecks>();
    /**
     * This wallet's own published bundles still awaiting their deferred checks, keyed by CID
     * string — the bundles whose background EVICTION must be reported instead of silent (see
     * {@link #evictBundle} / `VoteEvictedError`; remote evictions are normal operation). An
     * entry is dropped once its checks settle, on evict (after reporting), and on expiry prune.
     */
    readonly #ownPublishes = new Map<string, VotesBundle>();
    /** Per-own-CID eviction callbacks: the publishing `ContestVote` registers one at sign time. */
    readonly #ownEvictionCbs = new Map<string, (error: VoteEvictedError) => void>();

    /** Does any vote in the bundle carry a `community.name` claim (needing resolution)? */
    #carriesName(bundle: VotesBundle): boolean {
        return bundle.votes.some((v) => v.community.name !== undefined);
    }

    /**
     * Record a bundle's deferred-check state at admit: fully settled, pending both checks, or —
     * for an own publish whose name preflight already resolved every carried name — pending the
     * gate read only (`nameSettled`).
     */
    #recordChecks(cid: CID, bundle: VotesBundle, settled: boolean, nameSettled = settled): void {
        this.#checks.set(
            cid.toString(),
            this.#carriesName(bundle) ? { chainVerified: settled, nameResolved: nameSettled } : { chainVerified: settled }
        );
    }

    /** The bundle's check state, pessimistic (all pending) if somehow unrecorded. */
    #checksFor(cid: CID, bundle: VotesBundle): BundleChecks {
        return (
            this.#checks.get(cid.toString()) ??
            (this.#carriesName(bundle) ? { chainVerified: false, nameResolved: false } : { chainVerified: false })
        );
    }

    /** Admitted but at least one deferred network check unsettled (the CRDT's prune shield). */
    #isPending(cid: CID): boolean {
        const checks = this.#checks.get(cid.toString());
        return checks !== undefined && (!checks.chainVerified || checks.nameResolved === false);
    }

    /** Every deferred check settled — the bundle may be served in our checkpoint. */
    #isFullyVerified(cid: CID): boolean {
        const checks = this.#checks.get(cid.toString());
        return checks !== undefined && checks.chainVerified && checks.nameResolved !== false;
    }

    /** A background check confirmed: flip the flag, re-encode the checkpoint, recount the tally. */
    #settleCheck(cid: CID, key: "chainVerified" | "nameResolved"): void {
        const checks = this.#checks.get(cid.toString());
        if (!checks) return; // evicted or pruned while its check was in flight
        checks[key] = true;
        // A fully settled own publish can no longer be evicted — its verdict is terminal — so
        // its eviction-reporting entries are done (see #ownPublishes).
        if (this.#isFullyVerified(cid)) this.#dropOwnTracking(cid.toString());
        this.#onStateChanged();
    }

    /**
     * A deferred check failed: drop the bundle (its verified predecessor, if any, wins again).
     * Evicting this wallet's OWN publish is the one rejection a publisher can ever hear about —
     * gossipsub peers drop a bad bundle silently, but this node runs the same checks (see
     * DESIGN.md "Background chain verification") — so it is reported as a `VoteEvictedError`
     * through the publishing `ContestVote` and the contest `error` event instead of silent.
     */
    #evictBundle(cid: CID, verdict: VerifyFail): void {
        this.#crdt.remove(cid);
        const key = cid.toString();
        this.#checks.delete(key);
        const own = this.#ownPublishes.get(key);
        if (own) {
            const error = new VoteEvictedError(own, verdict);
            const notifyVote = this.#ownEvictionCbs.get(key);
            this.#dropOwnTracking(key);
            notifyVote?.(error);
            this.#emitError(error);
        }
        this.#onStateChanged();
    }

    /** Forget an own publish's eviction-reporting entries (settled, evicted, or expired). */
    #dropOwnTracking(key: string): void {
        this.#ownPublishes.delete(key);
        this.#ownEvictionCbs.delete(key);
    }

    #emitError(error: unknown): void {
        for (const cb of [...this.#errorListeners]) cb(error);
    }

    /** Surface a voter-level failure (e.g. a provider announce) through this contest's error event. */
    emitError(error: unknown): void {
        this.#emitError(error);
    }

    #chainFor(ticker: string): ChainClient {
        const client = this.#chainClients[ticker];
        if (!client) throw new Error(`no chain client configured for chain "${ticker}"`);
        return client;
    }

    /**
     * Read the gating-chain head and update {@link #currentBucketCache}; returns the bucket.
     *
     * The head read goes through the voter-wide {@link ResolvedDeps.readHead} coalescer, NOT the raw
     * client, because the tally recompute calls this on EVERY state change: a cold directory join
     * admits ~one chased bundle per contest and then settles two deferred checks per bundle, so a
     * 63-contest join drives ~4 recomputes per contest ≈ 250 tally computes in a couple of seconds,
     * each of which — before this — fired its own `eth_blockNumber`. The gating chain is shared by
     * every contest (one `ruleChain` per chain across the directory), so those reads land in
     * overlapping bursts; coalescing collapses concurrent callers to a single in-flight read (see
     * {@link makeHeadReader}) without ever serving a stale head. The signing path ({@link signVote})
     * and the tie-break block-hash read ({@link #bucketBlockHash}) still read the client directly.
     * Measured on the production 5chan cold start: 252 head-read requests → 66 actual `getBlockNumber`
     * (−74%). This is an RPC-load / churn reduction, not a first-tally latency win (see the commit).
     */
    async #refreshBucket(): Promise<number> {
        const head = await this.#deps.readHead(this.#ruleChain);
        this.#currentBucketCache = this.#bucketMath.bucketForBlock(Number(head));
        this.#headReadMs = Date.now();
        this.#maybePurgeGateResults();
        return this.#currentBucketCache;
    }

    /** The last purge's expiry boundary (oldest admissible sample block); 0 = never purged. */
    #purgedSampleBlock = 0;

    /**
     * Drop this rule's persisted gate results older than the oldest admissible sample block —
     * provably dead: a score at bucket B is only ever consulted while bundles from B are within
     * `voteExpiryBuckets` of head (see verify/gate-result-cache.ts `purgeExpiredGateResults`).
     * Piggybacks on the head reads the engine does anyway (join-with-state, publish, tally)
     * and re-runs only when the boundary advances past the last purged one — so an idle
     * engine costs no chain read and no purge, and a steady head costs no key scan, but a
     * long-lived engine still sheds entries as they expire instead of leaving them to the
     * LRU backstop. Fire-and-forget by design.
     */
    #maybePurgeGateResults(): void {
        const oldestBucket = this.#currentBucketCache - this.criteria.voteExpiryBuckets;
        if (oldestBucket <= 0) return;
        const oldestSampleBlock = this.#bucketMath.sampleBlockForBucket(oldestBucket);
        if (oldestSampleBlock <= this.#purgedSampleBlock) return;
        this.#purgedSampleBlock = oldestSampleBlock;
        void purgeExpiredGateResults({
            store: this.#deps.gateStore,
            ruleHash: this.#ruleHash,
            oldestSampleBlock
        });
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
    async computeTally(): Promise<ContestTally> {
        // With state present, refresh the bucket so the tally's `current()` filters expiry against
        // the live block, then prune the now-decayed nodes (dropping their check state with them).
        // Empty state needs neither, so an empty tally reads no chain (the constant-weight "zero
        // chain reads" property).
        if (this.#crdt.nodeCount() > 0) {
            await this.#refreshBucket();
            for (const removed of await this.#crdt.prune(this.#currentBucketCache)) {
                const key = removed.toString();
                this.#checks.delete(key);
                this.#dropOwnTracking(key); // expiry is decay, not an eviction — no error
            }
        }
        return this.#tally.compute();
    }

    /** Compute the tally once, cache it, and emit `update`; on failure emit `error` instead. */
    async #computeAndEmit(): Promise<void> {
        this.#tallyDirty = false;
        let tally: ContestTally;
        try {
            tally = await this.computeTally();
        } catch (error) {
            this.#emitError(error);
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

    /** True while joined to the topic (between `join()` and `leave()`); gates the fetch responder. */
    get joined(): boolean {
        return this.#joined;
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
            // The forward-gate ran the FULL pipeline inline, so the checks arrive settled.
            admit: async ({ cid, bytes, bundle }) => {
                await this.#deps.blockstore.put(cid, bytes);
                await this.#crdt.merge([cid]);
                this.#recordChecks(cid, bundle, true);
            },
            limit: (fn) => limit(fn),
            allowBundlePeer: makeRateLimiter(GATE_RATE),
            allowRootPeer: makeRateLimiter(GATE_ROOT_RATE),
            onAccept: () => this.#onStateChanged(),
            // Root records surface as unverifiable hints: compare to our own root, chase a
            // divergence lazily, answer it once per interval. Never awaited by the validator.
            // `from` seeds the chase's bitswap session — the sender provably holds the
            // advertised root's blocks (see DESIGN.md "Block pull").
            onRootRecord: (record, from) => {
                void this.#handleRootRecord(record, from).catch(() => {});
            },
            maxBundleMessageBytes: maxBundleMessageBytes(this.criteria),
            maxRootMessageBytes: MAX_ROOT_MESSAGE_BYTES,
            timeoutMs: GATE_TIMEOUT_MS
        });
        const chaseLimit = pLimit(CHASE_CONCURRENCY);
        this.#chaser = makeRootChaser({
            // The broadcast fallback: a plain want that any connected topic peer can answer.
            // The seeded session below is tried first when the blockstore can make one.
            getBlock: async (cid, signal) => {
                try {
                    return await this.#deps.blockstore.get(cid, { signal });
                } catch {
                    return undefined;
                }
            },
            // A directed session per chased root, seeded with its advertisers: wants go to the
            // peers that provably hold the blocks instead of every connection, and the routers
            // are queried once per root (the headroom slot) instead of once per block. Absent
            // `createSession` (a plain blockstore) declines, and the chase broadcasts as before.
            openSession: (root, providers) => {
                const createSession = this.#deps.blockstore.createSession?.bind(this.#deps.blockstore);
                if (createSession === undefined) return undefined;
                // `toChaseSession` enforces the ChaseSession never-throw contracts on the raw session.
                return toChaseSession(
                    createSession(root, {
                        providers,
                        maxProviders: providers.length + CHASE_SESSION_PROVIDER_HEADROOM
                    })
                );
            },
            verifyOffline: (bundle) => this.#verifier.verifyOffline(bundle),
            cache: this.#cache,
            isEvaluableNow: (bundle) => this.#isEvaluableNow(bundle),
            hasBundle: (cid) => this.#store.has(cid),
            // `verified: false` is a provisional admit (offline checks only) whose deferred gate
            // read + name resolution ride `deferVerify`; `true` means a cached terminal verdict
            // already covers the full pipeline.
            admit: async ({ cid, bytes, bundle, verified }) => {
                await this.#deps.blockstore.put(cid, bytes);
                await this.#crdt.merge([cid]);
                this.#recordChecks(cid, bundle, verified);
                this.#markStateChanged();
            },
            deferVerify: (entries) => this.#background.enqueue(entries),
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
        // Re-kick any deferred checks a previous leave() paused (their bundles are still pending).
        this.#background.resume();
        // Notify the voter of the real join transition (drives lazy responder registration):
        // a node that participates in a topic serves its root record, symmetric with the
        // heartbeat it broadcasts there.
        this.#deps.onTopicJoined();
        this.#armHeartbeat();
        // Reload our own persisted checkpoint BEFORE any network activity, and awaited — so a
        // seeder restarting with no other peer online serves its restored state immediately
        // (the initial tally after `update()` already carries it), and the cold-start pull
        // below compares peers' roots against the restored root instead of an empty one.
        // No snapshot ⇒ no cost (one store miss); a non-empty one costs one head read (the
        // bucket-admissibility check), consistent with the state-present rule below.
        await this.#restoreSnapshot();
        // Cold-start / reconnect pull: ask connected topic peers for their root records and
        // chase any divergence. Fire-and-forget — joining must not block on slow peers, and
        // live gossip plus the heartbeat converge regardless; this only shortens the gap.
        void this.#coldStart().catch(() => {});
        // If a re-join left state behind (or the snapshot restore just reloaded some), refresh
        // the bucket and prune the decayed nodes. Gated on non-empty state so an empty join
        // stays network-free (no getBlockNumber read), preserving the "zero chain reads for a
        // constant-weight tally" property.
        if (this.#crdt.nodeCount() > 0) {
            await this.#refreshBucket();
            await this.#crdt.prune(this.#currentBucketCache);
        }
    }

    /**
     * The cold-join pull (DESIGN.md "Checkpoints"): ask up to {@link COLD_START_PEERS} peers, over
     * the libp2p **fetch protocol**, for their current root record, and chase every root that
     * differs from our own. Peers come from **two sources raced concurrently, neither blocking the
     * other**: a random {@link COLD_START_PEERS} of the gossipsub subscribers of this topic, and
     * the providers of the criteria CID from the host's HTTP content router. Roots are **unioned,
     * never quorum'd** — a record served by a single peer is still chased, so a colluding majority
     * cannot hide a vote.
     *
     * The `getSubscribers` source is an instantaneous snapshot, and a joiner that dials a seeder
     * and joins immediately (the normal browser boot order) races subscription gossip: at the
     * instant of `join()` it sees zero subscribers, pulls nothing, and would idle until the topic
     * heartbeat (issue #15 — measured 90+ s vs ~4 s). So the pull closure (and its `seen` dedup)
     * stays armed on gossipsub's `subscription-change` for {@link COLD_START_REPULL_WINDOW_MS}:
     * each peer whose subscription to this topic becomes visible inside the window is asked once,
     * closing the race for router-less clients too. See {@link #armSubscriptionRepull}.
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
                this.#notePeerRoot(id, record.root);
                // Hand the piggybacked chunk index to the chase: verified against `record.root`, it
                // skips the root-manifest bitswap round-trip (see DESIGN.md "Block pull"). The
                // pulled peer seeds the chase's session — it provably holds what it just served.
                if (!record.root.equals(own.root)) {
                    this.#chaser?.chase(record.root, record.chunks, this.#sessionProvidersFor(record.root, peer));
                }
            } catch {
                // Peer offline, no record, or malformed answer — best-effort; the other source and
                // live gossip still converge.
            }
        };
        // Arm the re-pull BEFORE the initial fan-out so no subscriber can land in the gap
        // between the snapshot below and the listener; `seen` dedups any overlap.
        this.#armSubscriptionRepull(pull);
        // Shuffle before slicing: a deterministic first-N pick would funnel a whole directory
        // join through the same peers' stream caps while other subscribers idle; a random N
        // spreads contests across the topic's serving peers (see COLD_START_PEER_FETCH_LIMIT).
        const fromSubscribers = shuffled(this.#deps.pubsub.getSubscribers(this.topic)).slice(0, COLD_START_PEERS).map(pull);
        await Promise.allSettled([...fromSubscribers, this.#discoverProviders(pull)]);
    }

    /**
     * Keep the cold-start pull live on gossipsub's `subscription-change` for one re-pull window:
     * a peer whose subscription to this topic becomes visible after `join()`'s instantaneous
     * `getSubscribers` snapshot is pulled the moment it appears (once — the shared `seen` set
     * dedups), instead of waiting for the heartbeat. Bounded by {@link COLD_START_REPULL_WINDOW_MS}:
     * past the first heartbeat interval the passive heartbeat already covers divergence detection,
     * so a long-lived node does not pay one fetch per churning subscriber forever. Disarmed by
     * `leave()`; a re-join arms a fresh window.
     */
    #armSubscriptionRepull(pull: (peer: PeerId) => Promise<void>): void {
        this.#disarmSubscriptionRepull(); // a stale listener from a prior join must not leak
        const pubsub = this.#deps.pubsub;
        const listener: SubscriptionChangeListener = (evt) => {
            if (!evt.detail.subscriptions.some((s) => s.topic === this.topic && s.subscribe)) return;
            void pull(evt.detail.peerId).catch(() => {});
        };
        pubsub.addEventListener("subscription-change", listener);
        const timer = setTimeout(() => this.#disarmSubscriptionRepull(), COLD_START_REPULL_WINDOW_MS);
        // Don't hold a Node process open; no-op in the browser.
        (timer as { unref?: () => void }).unref?.();
        this.#subscriptionRepullDisarm = () => {
            clearTimeout(timer);
            pubsub.removeEventListener("subscription-change", listener);
        };
    }

    #disarmSubscriptionRepull(): void {
        this.#subscriptionRepullDisarm?.();
        this.#subscriptionRepullDisarm = undefined;
    }

    /**
     * Pull one peer's root record over the fetch protocol, retrying a THROWN fetch with full-jittered
     * exponential backoff until {@link COLD_START_FETCH_DEADLINE_MS} (see the constant's note for the
     * measured seeder-reset failure this rides out). A *definitive* answer never retries; bails if the
     * contest was left mid-retry (`#chaser` is cleared by `leave()`). Each attempt — not the whole
     * retry loop, so a backoff sleep never holds a slot — passes through the voter-wide per-peer
     * budget, which keeps our own concurrent streams to this peer under its inbound cap; queue wait
     * counts against the same deadline.
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
                return await this.#deps.fetchBudget(peer.toString(), () => this.#deps.pullRoot(peer, this.topic));
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
                                // Bound each dial by its own COLD_START_DIAL_TIMEOUT_MS in addition to the
                                // shared router signal: a hung WSS dial that never settles must not gate the
                                // pull for the full router timeout (see COLD_START_DIAL_TIMEOUT_MS). Only the
                                // dial carries this signal — `pull` below is never aborted by it.
                                const dialSignal = AbortSignal.any([
                                    controller.signal,
                                    AbortSignal.timeout(COLD_START_DIAL_TIMEOUT_MS)
                                ]);
                                await libp2p.dial(provider.multiaddrs, { signal: dialSignal });
                            }
                        } catch {
                            // Undialable, timed out, or router-aborted — `pull` still tries (it may be connected).
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
        // Flush the debounced snapshot write so a clean shutdown persists the latest state
        // (still skipped if checks are pending — the stale-but-good snapshot stays put).
        if (this.#snapshotTimer !== undefined) {
            clearTimeout(this.#snapshotTimer);
            this.#snapshotTimer = undefined;
            await this.#writeSnapshot();
        }
        // Pause the background verifier's retry timer; pending state survives for a re-join.
        this.#background.stop();
        this.#disarmSubscriptionRepull();
        this.#heardMatchingRoot = false;
        this.#publishedRootThisInterval = false;
        this.#chaser = undefined;
        // Advertised roots go stale the moment we stop hearing heartbeats; a re-join re-learns.
        this.#peerRoots.clear();
        const wasJoined = this.#joined;
        this.#joined = false;
        await this.#transport?.stop();
        this.#transport = undefined;
        // Fire once per real transition only: `leave()` is idempotent and also runs on engines
        // that never joined, so the voter's joined-count must not underflow.
        if (wasJoined) this.#deps.onTopicLeft();
    }

    /**
     * Publish-time community-name preflight (see verify/name-preflight.ts): throws
     * `InvalidCommunityNameError` when a carried name definitively fails to resolve to its
     * vote's claimed key — before signing, before the caller joins the topic — because every
     * verifier would silently drop such a bundle. Returns whether every carried name settled
     * (false = a resolver outage skipped one; the background verifier still owns that check).
     */
    async preflightNames(votes: readonly Vote[]): Promise<boolean> {
        const result = await preflightCommunityNames({
            votes,
            nameResolvers: this.#deps.nameResolvers,
            cache: this.#deps.nameResolutionCache
        });
        if (!result.ok) {
            throw new InvalidCommunityNameError(result.communityName, result.claimedPublicKey, result.resolvedPublicKey, result.reason);
        }
        return result.settled;
    }

    /**
     * Sign the votes into a bundle for the current bucket boundary block (the block every verifier
     * reads at), add it to the CRDT, and return the bundle plus its encoded block bytes for
     * broadcast. Throws `ReadOnlyError` with no signer. `namesSettled` carries the
     * {@link preflightNames} outcome (default false: name checks still owed to the background
     * verifier); `onEvicted` is told if a deferred check later evicts THIS bundle — registered
     * here, before the background verifier can possibly settle, so the report cannot be missed.
     */
    async signVote(
        votes: Vote[],
        opts: { namesSettled?: boolean; onEvicted?: (error: VoteEvictedError) => void } = {}
    ): Promise<{ bundle: VotesBundle; encoded: Uint8Array }> {
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

        const cid = await this.#crdt.add(bundle);
        // Own bundles take the same deferred path as a chased checkpoint's: admitted
        // provisionally, then confirmed (or evicted) by the background gate read — so an
        // ineligible wallet's local tally does not silently disagree with the network's, and
        // our checkpoint never serves a vote we have not verified (even our own). A name the
        // preflight already resolved is recorded settled, so it renders verified immediately.
        this.#recordChecks(cid, bundle, false, opts.namesSettled ?? false);
        this.#ownPublishes.set(cid.toString(), bundle);
        if (opts.onEvicted) this.#ownEvictionCbs.set(cid.toString(), opts.onEvicted);
        this.#background.enqueue([{ cid, bundle }]);
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
        // The same transition the encode cache invalidates on is what makes router provider
        // records stale, so the announcer's debounced re-announce rides it (see ResolvedDeps),
        // and what makes the persisted snapshot stale, so the debounced write rides it too.
        this.#deps.onCheckpointChanged();
        this.#scheduleSnapshotWrite();
    }

    /**
     * Arm the debounced snapshot write (announcer-style: the first change in a window arms the
     * timer, the rest coalesce into it). Only while joined — a never-joined engine (a ballot
     * created but never published) holds no view worth persisting, and `leave()` flushes the
     * armed timer so nothing fires after teardown.
     */
    #scheduleSnapshotWrite(): void {
        if (!this.#joined || this.#snapshotTimer !== undefined) return;
        const timer = setTimeout(() => {
            this.#snapshotTimer = undefined;
            void this.#writeSnapshot();
        }, SNAPSHOT_DEBOUNCE_MS);
        // Don't hold a Node process open; no-op in the browser.
        (timer as { unref?: () => void }).unref?.();
        this.#snapshotTimer = timer;
    }

    /** Any admitted bundle with a deferred check still pending (same predicate as {@link #isPending}). */
    #hasUnsettledChecks(): boolean {
        for (const checks of this.#checks.values()) {
            if (!checks.chainVerified || checks.nameResolved === false) return true;
        }
        return false;
    }

    /**
     * Persist this contest's current checkpoint under the voter's `dataPath`: the root record's
     * wire bytes plus the blocks it references (just re-put by the encode, read back from the
     * blockstore so no second copy is held in memory). Best-effort like every persistent-cache
     * write — a broken store degrades to the pre-persistence behavior (the cold-start pull),
     * never an error.
     *
     * Skipped while ANY admitted bundle has a deferred check pending: the encoder serves only
     * fully verified bundles, so writing mid-settlement would persist a snapshot that OMITS the
     * pending ones — right after a restore (where every reloaded bundle is provisional) that
     * would clobber a good snapshot with a near-empty one, and a crash in that window would lose
     * the very votes persistence exists to keep. Every settlement and eviction re-marks the
     * state changed, so the write that was skipped here is re-armed by the last one to land.
     */
    async #writeSnapshot(): Promise<void> {
        if (this.#hasUnsettledChecks()) return;
        try {
            await this.rootRecord(); // (re-)encode so the cache reflects the current winner-set
            // Read record + blocks from the cache as one unit: a state change racing the encode
            // above can only leave a NEWER consistent pair here, never a torn one.
            const cached = this.#rootRecordCache;
            if (cached === undefined) return;
            await this.#deps.snapshots.set(
                this.topic,
                encodeSnapshot({ record: encodeRootRecord(cached.record), blocks: cached.blocks.map((block) => block.bytes) })
            );
        } catch {
            // Best-effort: a failed write leaves the previous snapshot in place; the next
            // state change re-arms the debounce and retries.
        }
    }

    /**
     * Reload this node's own persisted checkpoint at `join()`, before any network activity: the
     * fix for the seeder-restart vote loss (issue #14). The blob is decoded through the SAME
     * pipeline as a chased remote checkpoint — block CIDs re-derived (a corrupted block
     * self-invalidates), `decodeCheckpoint` re-derives the chunk index against the root, each
     * bundle re-passes the offline signature/constraint checks, and the deferred gate read +
     * name resolution ride the background verifier (mostly persisted-gate-cache hits on a
     * restart) — so the trust model is unchanged: this is the node's own previously-validated
     * state, re-validated on load. A corrupt or version-mismatched blob is removed and the join
     * proceeds empty, exactly as before persistence; the cold-start pull then still runs, so a
     * stale snapshot self-heals by union with the live topic.
     */
    async #restoreSnapshot(): Promise<void> {
        let blob: Uint8Array | undefined;
        try {
            blob = await this.#deps.snapshots.get(this.topic);
        } catch {
            return; // unreadable store — degrade to a plain cold join
        }
        if (blob === undefined) return;
        try {
            const snapshot = decodeSnapshot(blob);
            const record = decodeRootRecord(snapshot.record);
            const byCid = new Map<string, Uint8Array>();
            for (const bytes of snapshot.blocks) byCid.set((await blockForBytes(bytes)).cid.toString(), bytes);
            const winners = await decodeCheckpoint(record.root, async (cid) => byCid.get(cid.toString()), record.chunks);

            const pending: PendingBundle[] = [];
            for (const bundle of winners) {
                // Same two-stage admit as the chase (see transport/chase.ts): offline checks
                // synchronously before admit, chain/name checks deferred and batched. Admission
                // goes through `crdt.add` (which stores the block AND registers the bundle) — a
                // merge-by-CID would re-read through the blockstore, which the restore must not
                // depend on: it may be fresh (the incident's in-memory case) or hold the block
                // already (a persistent one), neither of which says the CRDT knows the bundle.
                const cid = await bundleCidForBytes(encodeBundle(bundle));
                if (this.#checks.has(cid.toString())) continue; // already admitted (a re-join)
                if (!(await this.#isEvaluableNow(bundle))) continue;
                const offline = await this.#verifier.verifyOffline(bundle);
                if (!offline.valid) continue;
                await this.#crdt.add(bundle);
                this.#recordChecks(cid, bundle, false);
                pending.push({ cid, bundle });
            }
            if (pending.length > 0) {
                this.#background.enqueue(pending);
                this.#onStateChanged();
            }
        } catch {
            // Corrupt, truncated, or version-mismatched blob: discard it and join empty — the
            // pre-persistence behavior. Never let a bad snapshot block the join.
            void this.#deps.snapshots.remove(this.topic).catch(() => {});
        }
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
        // Serve only fully verified bundles: a provisional admit must not propagate through our
        // checkpoint, and the eligibility-filtered LWW reduction falls back to a wallet's newest
        // VERIFIED bundle when its newest overall is still pending (see crdt/types.ts).
        //
        // Consume the dirty flag HERE, in the same synchronous window as the winner snapshot —
        // not after the encode. The encode below awaits, and a state change landing mid-encode
        // (e.g. a background settlement) re-dirties the flag; clearing it after the awaits would
        // silently clobber that invalidation and pin this record until the next state change.
        this.#checkpointDirty = false;
        const winners = this.#crdt.currentEntries(bucket, (cid) => this.#isFullyVerified(cid)).map((e) => e.bundle);
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
        this.#rootRecordCache = { record, bucket, blocks };
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
     * The current root record plus its checkpoint chunk blocks, for the bulk responder's inline
     * path (see `BulkFetchRootRecord.chunkBlocks`): the blocks are already in hand from the same
     * on-demand encode that produced the record, so inlining them is a copy, never extra encoding
     * work. `chunkBlocks` aligns positionally with `record.chunks`; the root-manifest block is
     * excluded (a receiver handed a verified chunk index never fetches the manifest).
     */
    async rootRecordWithBlocks(): Promise<{ record: FetchRootRecord; chunkBlocks: CheckpointBlock[] }> {
        const record = await this.rootRecord();
        // No await between the encode above and this read, so the cache is the one that made
        // `record`; the by-CID lookup is still belt-and-braces over positional slicing.
        const blocks = new Map((this.#rootRecordCache?.blocks ?? []).map((block) => [block.cid.toString(), block]));
        const chunkBlocks: CheckpointBlock[] = [];
        for (const chunk of record.chunks) {
            const block = blocks.get(chunk.toString());
            if (block === undefined) return { record, chunkBlocks: [] }; // can't inline coherently — serve the record alone
            chunkBlocks.push(block);
        }
        return { record, chunkBlocks };
    }

    /**
     * Ingest a root record fetched on this engine's behalf by the voter-wide bulk puller: a bulk
     * answer names every contest the peer serves, not just the batch that asked, so the voter fans
     * the surplus records out here (see {@link RootPullerHooks.onRecord}) instead of letting each
     * contest wait out its own discovery to ask for bytes already in hand. Identical handling to a
     * cold-start pull result — note the advertiser, chase a divergence — minus the fetch. A no-op
     * before join()/after leave() (no chaser to hand the hint to); throws surface to the caller's
     * catch exactly like a malformed pull.
     */
    async ingestRootRecord(peer: PeerId, encoded: Uint8Array): Promise<void> {
        if (this.#chaser === undefined) return;
        const record = decodeRootRecord(encoded);
        const own = await this.rootRecord();
        this.#notePeerRoot(peer.toString(), record.root);
        if (!record.root.equals(own.root)) {
            this.#chaser.chase(record.root, record.chunks, this.#sessionProvidersFor(record.root, peer));
        }
    }

    /**
     * Handle a heard root record (an unverifiable hint, surfaced by the gate at layer 1):
     * matching our own root ⇒ note it for heartbeat suppression; differing ⇒ chase it lazily and
     * answer with our own record at most once per interval. See DESIGN.md "Checkpoints".
     */
    async #handleRootRecord(record: RootRecord, from?: string): Promise<void> {
        if (from !== undefined) this.#notePeerRoot(from, record.root);
        const own = await this.rootRecord();
        if (own.root.equals(record.root)) {
            this.#heardMatchingRoot = true;
            return;
        }
        this.#chaser?.chase(record.root, undefined, this.#sessionProvidersFor(record.root));
        if (!this.#publishedRootThisInterval) {
            this.#publishedRootThisInterval = true;
            await this.#transport?.publishRootRecord(own);
        }
    }

    /** Note `peerId`'s latest advertised root (see {@link #peerRoots}); refreshes its eviction slot. */
    #notePeerRoot(peerId: string, root: CID): void {
        if (this.#peerRoots.has(peerId)) {
            this.#peerRoots.delete(peerId); // re-insert to refresh insertion order
        } else if (this.#peerRoots.size >= PEER_ROOTS_MAX) {
            const oldest = this.#peerRoots.keys().next().value;
            if (oldest !== undefined) this.#peerRoots.delete(oldest);
        }
        this.#peerRoots.set(peerId, root.toString());
    }

    /**
     * The session seeds for chasing `root`: every still-connected peer whose last advertised
     * root is exactly `root` (see {@link #peerRoots}) — resolved against the node's live
     * connections both to recover the `PeerId` handle (the gate surfaces senders as strings)
     * and because seeding a gone peer is a wasted dial. `known` (the cold-start pull peer,
     * already in hand as a `PeerId`) is included unconditionally. Order is deterministic; the
     * session fans wants across its providers itself.
     */
    #sessionProvidersFor(root: CID, known?: PeerId): PeerId[] {
        const rootKey = root.toString();
        const providers: PeerId[] = known !== undefined ? [known] : [];
        const wanted = new Set<string>();
        for (const [peer, advertised] of this.#peerRoots) {
            if (advertised === rootKey && peer !== known?.toString()) wanted.add(peer);
        }
        if (wanted.size > 0) {
            // Optional call: unit-test fakes inject a bare `libp2p` without connection APIs.
            for (const connection of this.#deps.helia.libp2p.getConnections?.() ?? []) {
                if (!wanted.delete(connection.remotePeer.toString())) continue;
                providers.push(connection.remotePeer);
                if (wanted.size === 0) break;
            }
        }
        return providers;
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

    getTally(): Promise<ContestTally> {
        return this.#engine.computeTally();
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
    /**
     * True once the background verifier evicted the current publish's bundle. The eviction can
     * land WHILE `publish()` is still broadcasting (the deferred checks run concurrently), and
     * its `"failed"` is terminal for this attempt — the in-flight publish must not stomp it
     * with `"publishing"`/`"succeeded"`. Reset by the next `publish()` call.
     */
    #evicted = false;

    constructor(engine: ContestEngine, votes: Vote[]) {
        this.#engine = engine;
        this.contestId = engine.criteria.contestId;
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
            // Name preflight, also before joining: a vote whose carried community name
            // definitively fails to resolve to its claimed key would be silently dropped by
            // every verifier, so it is refused here (`InvalidCommunityNameError`) instead of
            // broadcast. A resolver outage does not block the publish (namesSettled: false —
            // the background verifier owns the deferred check).
            const namesSettled = await this.#engine.preflightNames(this.votes);
            await this.#engine.join();
            this.#evicted = false;
            this.#setState("signing");
            const { bundle, encoded } = await this.#engine.signVote([...this.votes], {
                namesSettled,
                // The one rejection a publisher can hear about (peers drop silently): our own
                // node's deferred checks evicting this bundle. Usually post hoc — publish() has
                // already resolved — so it surfaces as `error` + `publishingState: "failed"`.
                onEvicted: (error) => {
                    this.#evicted = true;
                    this.#fail(error);
                }
            });
            this.#bundle = bundle;
            if (!this.#evicted) this.#setState("publishing");
            const { recipientCount } = await this.#engine.broadcastBundle(encoded);
            // An eviction that landed mid-broadcast already failed this attempt; the outcome
            // still resolves (the bundle DID hit the wire) but the state stays "failed".
            if (!this.#evicted) this.#setState("succeeded");
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
 * gossipsub service, a blockstore, and a libp2p fetch service), a `chains` factory, an optional
 * `signer`, and optional `nameResolvers` (needed once votes carry community names). Contests are
 * addressed by their full criteria document at `createContest` / `createContestVote`; the library
 * has no knowledge of pkc-js or any other host: a host passes its own running Helia node in
 * directly. Republishing a live vote is the client's concern — see
 * {@link republishIntervalBuckets} and DESIGN.md "Republishing is the client's job".
 */
export class PubsubVoter implements VoteClient {
    readonly #deps: ResolvedDeps;
    /** One engine per contest, keyed by topic so byte-identical criteria share one CRDT/transport. */
    readonly #engines = new Map<string, ContestEngine>();
    /** Cached read views, one per topic (stable per-contest object). */
    readonly #views = new Map<string, ContestView>();
    /** True while the fetch responder is registered, making register/unregister idempotent. */
    #responderRegistered = false;
    /**
     * How many engines are currently joined to their topic. The fetch responder is registered
     * lazily while this is > 0 (see {@link ResolvedDeps.onTopicJoined}): no constructor work, no
     * public API — a node serves root records for exactly the contests it participates in.
     */
    #joinedEngines = 0;
    /** True once `destroy()` ran. Terminal: every create path then throws (mirrors pkc-js). */
    #destroyed = false;
    /** The voter's persistent caches (see {@link PubsubVoterOptions.dataPath}); closed on destroy. */
    readonly #storage: ReturnType<typeof makeStorage>;
    /**
     * The provider-record announcer, present only when {@link PubsubVoterOptions.httpRouterUrls}
     * names at least one router (and inert in the browser build regardless — see
     * `src/transport/announce/`). Started with the first joined topic and stopped with the last,
     * the same transitions that drive the lazy fetch responder: a node announces records for
     * exactly the contests it participates in, for exactly as long as it participates.
     */
    readonly #announcer: Announcer | undefined;

    constructor(options: PubsubVoterOptions) {
        // Fail fast: the node must expose a gossipsub service, a blockstore, and a libp2p
        // fetch service. Throws MissingPubsubError / MissingBlockstoreError / MissingFetchError
        // at construction (not a lazy failure on the first publish/fetch) and narrows the handles.
        const { pubsub, blockstore, fetch } = requireHeliaServices(options.helia);
        // Persistent caches, opened lazily (no disk is touched until a contest verifies): the
        // gate-result store and the name-resolution cache, both shared across every contest on
        // this voter. sqlite under dataPath on Node, IndexedDB in the browser, in-memory for
        // `dataPath: false` — see src/storage/.
        this.#storage = makeStorage({ dataPath: options.dataPath });
        this.#deps = {
            helia: options.helia,
            pubsub,
            blockstore,
            fetch,
            // Every chain client is handed out through the read coalescer: pinned-block
            // `readContract` calls from ALL consumers (every contest, the gossip forward-gate,
            // the background verifier) merge into shared multicall3 round trips under one
            // per-client in-flight budget — see src/chain/coalescer.ts.
            chains: coalescingChainFactory(options.chains),
            signer: options.signer,
            registry: resolveRegistry(options.rules),
            nameResolvers: options.nameResolvers ?? [],
            onTopicJoined: this.#onTopicJoined,
            onTopicLeft: this.#onTopicLeft,
            onCheckpointChanged: () => this.#announcer?.notifyChange(),
            fetchBudget: makePerPeerBudget(COLD_START_PEER_FETCH_LIMIT),
            pullRoot: makeRootPuller(fetch, {
                // Verified inline chunk blocks land in the host blockstore, so the chases a bulk
                // answer triggers resolve locally instead of over bitswap (see RootPullerHooks).
                putBlock: async (cid, bytes) => {
                    await blockstore.put(cid, bytes);
                },
                // Fan surplus records out to the contests that did not ask (see RootPullerHooks):
                // fire-and-forget like the cold-start pull it substitutes for — an ingest failure
                // loses an optimisation, never a correctness property (live gossip + the heartbeat
                // still converge that contest).
                onRecord: (peer, topic, encoded) => {
                    const engine = this.#engines.get(topic);
                    if (engine?.joined) void engine.ingestRootRecord(peer, encoded).catch(() => {});
                }
            }),
            // One head-read coalescer per voter, shared by every contest on the (shared) gating
            // chain: a cold-start burst of concurrent tally recomputes shares one in-flight
            // getBlockNumber per chain instead of each firing its own (see makeHeadReader /
            // #refreshBucket).
            readHead: makeHeadReader(),
            gateStore: this.#storage.openLru({ cacheName: "gate-results", maxItems: GATE_RESULTS_MAX_ITEMS }),
            nameResolutionCache: makeNameResolutionCache(
                this.#storage.openLru({ cacheName: "name-resolutions", maxItems: NAME_RESOLUTIONS_MAX_ITEMS })
            ),
            snapshots: this.#storage.openSnapshots()
        };
        // The announcer touches libp2p (peer id, addresses, address events) only when routers are
        // configured, so a host that never announces pays nothing and injects nothing extra.
        if (options.httpRouterUrls !== undefined && options.httpRouterUrls.length > 0) {
            this.#announcer = makeAnnouncer({
                routerUrls: [...options.httpRouterUrls],
                libp2p: options.helia.libp2p,
                keys: this.#announceKeys,
                // An announce failure is a discoverability degradation for every joined contest,
                // so it surfaces through each one's error event (observational, like the announce
                // itself: never retried, never thrown) — a silent announce failure otherwise looks
                // exactly like a healthy seeder that nobody can find.
                onError: (url, error) => {
                    const announceError = new Error(
                        `provider announce to router ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
                        { cause: error }
                    );
                    for (const engine of this.#engines.values()) {
                        if (engine.joined) engine.emitError(announceError);
                    }
                }
            });
        }
    }

    /**
     * The CIDs the announcer publishes, collected fresh per tick and batched into one record:
     * every JOINED contest's criteria CID (the discovery key — a provider record for it means
     * "I run this contest") plus its current checkpoint root + chunk CIDs (what the chase-time
     * parallel router lookup finds; converged seeders share identical chunk CIDs, so any of
     * them can serve a block). `rootRecord()` is the same on-demand, cached encode the fetch
     * responder serves — an encode failure still announces the criteria key alone.
     */
    readonly #announceKeys = async (): Promise<string[]> => {
        const keys: string[] = [];
        for (const engine of this.#engines.values()) {
            if (!engine.joined) continue;
            keys.push(engine.topic.slice(TOPIC_PREFIX.length));
            try {
                const record = await engine.rootRecord();
                keys.push(record.root.toString());
                for (const chunk of record.chunks) keys.push(chunk.toString());
            } catch {
                // Encode failure — best-effort: the criteria CID (the discovery key) still goes out.
            }
        }
        // Contests can share CIDs (e.g. two vote-less contests share the empty-checkpoint root).
        return [...new Set(keys)];
    };

    get readOnly(): boolean {
        return this.#deps.signer === undefined;
    }

    /** Guard the create paths after {@link destroy}: a destroyed voter is terminal. */
    #assertLive(): void {
        if (this.#destroyed) throw new VoterDestroyedError();
    }

    async createContest(args: { criteria: Criteria }): Promise<Contest> {
        this.#assertLive();
        const engine = await this.#engineFor(this.#validateCriteria(args.criteria));
        const existing = this.#views.get(engine.topic);
        if (existing) return existing;
        const view = new ContestView(engine);
        this.#views.set(engine.topic, view);
        return view;
    }

    async createContestVote(args: { criteria: Criteria; votes: Vote[] }): Promise<ContestVote> {
        this.#assertLive();
        const engine = await this.#engineFor(this.#validateCriteria(args.criteria));
        return new ContestVotePublication(engine, args.votes);
    }

    /**
     * Strictly validate one criteria document at the create seam: `CriteriaSchema` (shape,
     * canonical encodability) plus the rule registry (an unimplemented rule must recuse, not
     * miscount — `UnknownRuleError`). The parsed result is what gets encoded, so the engine and
     * the topic always derive from a schema-clean document.
     */
    #validateCriteria(input: Criteria): Criteria {
        const criteria = CriteriaSchema.parse(input);
        validateCriteriaRules(criteria, this.#deps.registry);
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
     * unknown topic, foreign key shape, or encode failure answers nothing. So does a contest
     * whose engine exists but is not joined (e.g. a ballot created but never published): this
     * node holds no view of that contest, and an empty record would masquerade as one.
     */
    readonly #rootLookup = async (keyBytes: Uint8Array): Promise<Uint8Array | undefined> => {
        // `@libp2p/fetch` hands the lookup the requested key as raw bytes; decode the utf8 topic
        // string the requester sent (`rootFetchKey(topic)`) before matching.
        const key = new TextDecoder().decode(keyBytes);
        if (key === BULK_ROOTS_FETCH_KEY) return await this.#bulkRootsAnswer();
        if (!key.endsWith(ROOT_FETCH_KEY_SUFFIX)) return undefined;
        const engine = this.#engines.get(key.slice(0, -ROOT_FETCH_KEY_SUFFIX.length));
        if (!engine?.joined) return undefined;
        try {
            return encodeRootRecord(await engine.rootRecord());
        } catch {
            return undefined;
        }
    };

    /**
     * The bulk half of the responder (see {@link BULK_ROOTS_FETCH_KEY}): one reply carrying the
     * root record of every joined contest, so a directory-sized cold joiner pays one round trip
     * instead of one per contest. Same rules as the per-topic answer, applied per entry — an
     * unjoined engine or an encode failure contributes nothing rather than a zero record that
     * would masquerade as an empty contest.
     *
     * Capped at {@link BULK_ROOTS_MAX_RECORDS}: a request must never be able to compel unbounded
     * encoding work. Truncation is safe and invisible to correctness — a caller that wanted a
     * topic missing from the answer falls back to fetching it individually.
     *
     * Answers an EMPTY map rather than nothing when it serves no contest, and that distinction is
     * load-bearing. A pre-bulk peer has this prefix registered but does not know this key, so it
     * answers nothing; if "serves nothing" also answered nothing, a seeder caught mid-startup would
     * be indistinguishable from one that will never support bulk, and the caller — which remembers
     * that verdict for the session — would fall back to one fetch per contest against a peer that
     * was about to serve the whole directory in one. An empty map says "I speak bulk, I have
     * nothing yet", which is a different and recoverable answer.
     */
    async #bulkRootsAnswer(): Promise<Uint8Array | undefined> {
        const joined = [...this.#engines.entries()].filter(([, engine]) => engine.joined).slice(0, BULK_ROOTS_MAX_RECORDS);
        const records: BulkRootRecords = {};
        // The checkpoint payload rides along while the budget lasts (see BULK_ROOTS_MAX_INLINE_BYTES):
        // chunk blocks come from the same encode cache as the record, so inlining is a copy, and a
        // record past the budget simply answers without blocks — its chase fetches them as before.
        let inlineBudget = BULK_ROOTS_MAX_INLINE_BYTES;
        // Sequential on purpose: `rootRecord()` is served from the engine's on-demand encode cache
        // and this runs on the serving side of an unauthenticated request, so it must not fan out.
        for (const [topic, engine] of joined) {
            try {
                const { record, chunkBlocks } = await engine.rootRecordWithBlocks();
                const inlineBytes = chunkBlocks.reduce((total, block) => total + block.bytes.length, 0);
                if (chunkBlocks.length > 0 && inlineBytes <= inlineBudget) {
                    inlineBudget -= inlineBytes;
                    records[topic] = { ...record, chunkBlocks: chunkBlocks.map((block) => block.bytes) };
                } else {
                    records[topic] = record;
                }
            } catch {
                // This contest contributes nothing; the rest of the directory still answers.
            }
        }
        try {
            return encodeBulkRootRecords(records);
        } catch {
            return undefined;
        }
    }

    /**
     * Lazy responder lifecycle, driven by the engines' real join/leave transitions: the first
     * joined topic registers the fetch responder, the last left topic unregisters it. This is an
     * invariant, not an opt-in — any node participating in a topic answers root-record fetches
     * there, symmetric with the heartbeat it already broadcasts.
     */
    readonly #onTopicJoined = (): void => {
        this.#joinedEngines += 1;
        // A join adds a criteria CID to the announced key set (and the first join starts the
        // announcer's timers/listeners) — the debounce coalesces a directory-wide join into one
        // announce per router.
        this.#announcer?.start();
        this.#announcer?.notifyChange();
        if (this.#responderRegistered) return;
        this.#deps.fetch.registerLookupFunction(TOPIC_PREFIX, this.#rootLookup);
        this.#responderRegistered = true;
    };

    readonly #onTopicLeft = (): void => {
        this.#joinedEngines -= 1;
        // Last topic left: stop refreshing records; what is already written ages out by the
        // router's TTL (there is no un-announce), symmetric with the responder unregistering.
        if (this.#joinedEngines <= 0) {
            this.#announcer?.stop();
            this.#unregisterResponder();
        }
    };

    async stop(): Promise<void> {
        // Reset each read view (detach its engine listeners, clear `#subscribed`) so it can
        // `update()` again — this is what keeps `stop()` reusable. Then leave any engine with no
        // view (created via `createContestVote`); `leave()` is idempotent, so double-leaving a
        // view's engine is a no-op. Each real leave notifies `#onTopicLeft`, so the responder
        // unregisters exactly when the last joined topic is left.
        await Promise.all([...this.#views.values()].map((view) => view.stop()));
        await Promise.all([...this.#engines.values()].map((engine) => engine.leave()));
    }

    async destroy(): Promise<void> {
        // Terminal, mirroring pkc-js: mark the voter and every engine destroyed BEFORE tearing
        // down, so any create path and any pre-existing view/publication (whose `update()` /
        // `publish()` funnels through `engine.join()`) now throws `VoterDestroyedError`. `stop()`
        // then resets the views and leaves every topic (unregistering the responder via the
        // counted release); the explicit unregister first is the terminal-path safety net.
        // Unlike `stop()`, the client does not come back.
        this.#destroyed = true;
        for (const engine of this.#engines.values()) engine.markDestroyed();
        this.#announcer?.stop();
        this.#unregisterResponder();
        await this.stop();
        // Close the persistent caches last (Node: the sqlite handles) — engines are already
        // terminal, so nothing can race a write. `stop()` deliberately leaves them open: a
        // stopped voter is reusable and its caches stay warm.
        await this.#storage.destroy();
    }

    #unregisterResponder(): void {
        if (!this.#responderRegistered) return;
        this.#deps.fetch.unregisterLookupFunction(TOPIC_PREFIX, this.#rootLookup);
        this.#responderRegistered = false;
    }
}
