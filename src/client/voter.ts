import pLimit from "p-limit";
import { CriteriaSchema, type Criteria } from "../schema/criteria.js";
import { VotesBundleSchema, type Vote, type VotesBundle } from "../schema/votes.js";
import type { ChainClient, ChainClientFactory, ChainClients, NameResolver } from "../chain/types.js";
import { makeBucketMath } from "../chain/bucket.js";
import { tickerForRef } from "../chain/ticker.js";
import type { BlockstoreLike, HeliaInstance, PubsubService, VoteTransport } from "../transport/types.js";
import { requireHeliaServices } from "../transport/helia.js";
import { makeBlockstoreDagNodeStore } from "../transport/dag-store.js";
import { makeRateLimiter } from "../transport/rate-limit.js";
import { makeGossipGate } from "../transport/gossip-validator.js";
import { makeVoteTransport } from "../transport/transport.js";
import { encodeHeads, decodeHeads } from "../transport/heads.js";
import type { RuleRegistry } from "../rules/types.js";
import { resolveRegistry, validateCriteriaRules } from "../rules/registry.js";
import { makeVoteCrdt } from "../crdt/crdt.js";
import type { VoteCrdt } from "../crdt/types.js";
import { makeBundleVerifier } from "../verify/bundle.js";
import { makeVerdictCache } from "../verify/cache.js";
import { makeTally } from "../tally/tally.js";
import type { ContestTally, TallyOptions } from "../tally/types.js";
import type { VoteSigner } from "../signer/types.js";
import { ballotTypedData } from "../signer/eip712.js";
import { criteriaCid, TOPIC_PREFIX } from "../topic.js";
import { deriveCriteria } from "../manifest/manifest.js";
import type { VoteStore } from "../store/types.js";
import { selectVoteStore } from "../store/select.js";
import { NotImplementedError, ReadOnlyError, UnknownRuleError } from "../errors.js";

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

    /** Join the topic, fetch and union heads from peers, subscribe to gossip. */
    start(): Promise<void>;
    /** Leave the topic and release the transport. Does not stop the host node. */
    stop(): Promise<void>;

    /**
     * Sign the given votes into a bundle for the current bucket, add it to the CRDT,
     * and broadcast the new heads. Pass an empty array to withdraw (a newer empty
     * bundle supersedes the prior one under LWW). Throws `ReadOnlyError` with no signer.
     */
    castVotes(votes: Vote[]): Promise<VotesBundle>;

    /** Current contest ranking, verified lazily top-down. */
    getTally(options?: TallyOptions): Promise<ContestTally>;

    /** Fired when incoming votes change the state. */
    on(event: "update", cb: () => void): void;
}

/** Manager: one set of injected dependencies, many contests. */
export interface VoteClient {
    /** True when constructed without a signer: every contest is read-only. */
    readonly readOnly: boolean;
    /** Get (or create and cache) the network for one contest, keyed by its topic. */
    contest(criteria: Criteria): Promise<VoteNetwork>;
    /** Derive every contest from a 5chan-style manifest and return one network each. */
    contestsFromManifest(manifest: unknown): Promise<VoteNetwork[]>;
    /**
     * Join every contest from the constructor `manifest` (if one was given, else the
     * already-cached contests), start each network, and arm the republish scheduler that
     * keeps this wallet's own votes alive by re-signing them with a fresh `blockNumber` on
     * the liveness cadence (`ceil(voteExpiryBuckets / 2)` buckets per contest). Idempotent
     * to the extent contests cache by topic.
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
     * A 5chan-style directory manifest this voter owns. When given, `start()` derives every
     * contest from it (via `deriveCriteria`) and keeps them all republished under one
     * lifecycle. Optional: a voter can instead mint contests ad hoc through `contest()` /
     * `contestsFromManifest()` and never set this.
     */
    manifest?: unknown;
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
     * Board-name resolvers, same instances a host gives pkc-js (e.g.
     * `@bitsocial/bso-resolver` for `name.bso`). The tally resolves each vote's
     * `board.name` claim through the first resolver whose `canResolve` matches and
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
    chains: ChainClientFactory;
    signer: VoteSigner | undefined;
    /** Built-ins with any host overrides merged in (overrides shadow by `type`). */
    registry: RuleRegistry;
    /** Board-name resolvers for verifying `board.name` claims at tally time. */
    nameResolvers: NameResolver[];
    /** Persistence for this voter's own vote intents (in-memory unless a host injects one). */
    store: VoteStore;
}

/** Hard per-message validation deadline (ms): the 10s budget for fetch + verify in the gate. */
const GATE_TIMEOUT_MS = 10_000;
/** Forward-gate layer-1 / walk bounds (see DESIGN.md "Transport"). */
const GATE_BOUNDS = { maxHeadsPerMessage: 64, maxMessageBytes: 1 << 20, maxClosureNodes: 1024 };
/** Concurrent in-flight fetch/verify operations across the gate. */
const GATE_CONCURRENCY = 8;
/** Per-peer rate window: how many messages one peer may make us validate per interval. */
const GATE_RATE = { limit: 256, intervalMs: 10_000 };

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
     * expiry filter (`current`/`heads`) reads it, so the sync transport `getHeads` closure
     * stays sync while still dropping decayed votes. Coarse-stale is fine — buckets are large.
     */
    #currentBucketCache = 0;

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
        const store = makeBlockstoreDagNodeStore(deps.blockstore);
        this.#crdt = makeVoteCrdt({ store, bucketMath: this.#bucketMath, voteExpiryBuckets: criteria.voteExpiryBuckets });

        const verifier = makeBundleVerifier({
            criteria,
            criteriaCid: criteriaCidBytes,
            chainId: this.#chainId,
            registry: deps.registry,
            chainFor: (ticker) => this.#chainFor(ticker),
            bucketMath: this.#bucketMath,
            nameResolvers: deps.nameResolvers
        });
        // The gate/transport are (re)built in start(); the store, crdt, cache, and verifier are
        // stable per contest, so a cache and verifier bound here survive restarts of the topic.
        this.#store = store;
        this.#cache = makeVerdictCache();
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

    readonly #store: ReturnType<typeof makeBlockstoreDagNodeStore>;
    readonly #cache: ReturnType<typeof makeVerdictCache>;
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
        return this.#currentBucketCache;
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
            decodeHeads,
            fetchNode: (cid) => this.#store.get(cid),
            verifier: this.#verifier,
            cache: this.#cache,
            merge: (heads) => this.#crdt.merge(heads),
            limit: (fn) => limit(fn),
            allowPeer: makeRateLimiter(GATE_RATE),
            onAccept: () => this.#notifyUpdate(),
            bounds: GATE_BOUNDS,
            timeoutMs: GATE_TIMEOUT_MS
        });
        this.#transport = makeVoteTransport({
            pubsub: this.#deps.pubsub,
            topic: this.topic,
            gate,
            encodeHeads,
            decodeHeads,
            getHeads: () => this.#crdt.heads(this.#currentBucketCache)
        });
        await this.#transport.start();
        // If cold start merged any heads, refresh the bucket and prune the decayed nodes it
        // pulled in. Gated on non-empty state so an empty join stays network-free (no getBlockNumber
        // read), preserving the "zero chain reads for a constant-weight tally" property. Periodic
        // pruning should ride the republish scheduler tick once that lands.
        if (this.#crdt.nodeCount() > 0) {
            await this.#refreshBucket();
            await this.#crdt.prune(this.#currentBucketCache);
        }
    }

    async stop(): Promise<void> {
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
        await this.#transport?.broadcastHeads(this.#crdt.heads(bucket));
        // Persist the re-signable intent so the republish scheduler can revive it after restart.
        await this.#deps.store.put({ topic: this.topic, address, votes, lastBucket: this.#bucketMath.bucketForBlock(blockNumber) });
        this.#notifyUpdate();
        return bundle;
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
 * The default `VoteClient`. Construct with the host-injected seams: a `helia` node
 * (the only mandatory one — the library never starts or assumes a particular node, but
 * the node must carry a gossipsub service and a blockstore), a `chains` factory, an
 * optional `signer`, and optional `nameResolvers` (needed once votes carry board
 * names). The library has no knowledge of pkc-js or any other host: a host passes its
 * own running Helia node in directly.
 */
export class PubsubVoter implements VoteClient {
    readonly #deps: ResolvedDeps;
    /** Cache of live contests, keyed by topic so identical criteria share one network. */
    readonly #contests = new Map<string, ContestNetwork>();
    /** The directory manifest this voter owns, if any; `start()` derives its contests. */
    readonly #manifest: unknown;
    /**
     * Live republish timers, one per contest, cleared by `stop()` / `destroy()`. The
     * registry and its teardown are real now; arming it (the re-sign tick) lands with the
     * engine — see `#armRepublishScheduler`.
     */
    readonly #republishTimers = new Set<ReturnType<typeof setInterval>>();

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
        this.#manifest = options.manifest;
    }

    get readOnly(): boolean {
        return this.#deps.signer === undefined;
    }

    async contest(criteria: Criteria): Promise<VoteNetwork> {
        const validated = CriteriaSchema.parse(criteria);
        validateCriteriaRules(validated, this.#deps.registry);
        const cid = await criteriaCid(validated);
        const topic = TOPIC_PREFIX + cid.toString();
        const existing = this.#contests.get(topic);
        if (existing) return existing;
        const network = new ContestNetwork(validated, topic, cid.bytes, this.#deps);
        this.#contests.set(topic, network);
        return network;
    }

    async contestsFromManifest(manifest: unknown): Promise<VoteNetwork[]> {
        return Promise.all(deriveCriteria(manifest).map((criteria) => this.contest(criteria)));
    }

    async start(): Promise<void> {
        const networks =
            this.#manifest !== undefined
                ? await this.contestsFromManifest(this.#manifest)
                : [...this.#contests.values()];
        for (const network of networks) {
            // Joins the topic and installs the forward gate; cold-start head sync over the
            // libp2p fetch protocol (`fetchHeadsFromPeer`) is still unset, so this returns
            // local heads and relies on live gossip to converge. See ROADMAP.md.
            await network.start();
        }
        // NOTE: still throws NotImplementedError — the client-level republish scheduler is
        // the one remaining stub, so `PubsubVoter.start()` is not yet usable end-to-end.
        this.#armRepublishScheduler(networks);
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
     * Arm the per-contest republish loop. Deferred with the engine: each contest's tick
     * will reload its `VoteIntent` from `this.#deps.store`, re-sign it with a fresh
     * `blockNumber` via `castVotes`, and `store.put` the bumped `lastBucket`, on the
     * `republishIntervalBuckets(criteria)` cadence — populating `#republishTimers` so
     * `stop()` / `destroy()` can tear it down. Throws until built.
     */
    #armRepublishScheduler(_networks: VoteNetwork[]): void {
        throw new NotImplementedError(
            "PubsubVoter republish scheduler (re-sign + rebroadcast on the liveness cadence)"
        );
    }
}
