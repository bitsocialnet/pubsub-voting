import { CriteriaSchema, type Criteria } from "../schema/criteria.js";
import type { Vote, VotesBundle } from "../schema/votes.js";
import type { ChainClient, ChainClientFactory, ChainClients, NameResolver } from "../chain/types.js";
import type { BlockstoreLike, HeliaInstance, PubsubService } from "../transport/types.js";
import { requireHeliaServices } from "../transport/helia.js";
import type { InterpreterRegistry } from "../interpreters/types.js";
import { resolveRegistry, validateCriteriaInterpreters } from "../interpreters/registry.js";
import type { ContestTally, TallyOptions } from "../tally/types.js";
import type { VoteSigner } from "../signer/types.js";
import { topicFor } from "../topic.js";
import { deriveCriteria } from "../manifest/manifest.js";
import { NotImplementedError, ReadOnlyError } from "../errors.js";

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
    /** Stop every contest this client started. */
    stopAll(): Promise<void>;
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
    /** Interpreter overrides that shadow built-ins by `type` (a flat `type -> interpreter` map). */
    interpreters?: InterpreterRegistry;
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
    registry: InterpreterRegistry;
    /** Board-name resolvers for verifying `board.name` claims at tally time. */
    nameResolvers: NameResolver[];
}

/** One contest. The pure parts (criteria, topic, read-only) are live; the engine is pending. */
class ContestNetwork implements VoteNetwork {
    readonly criteria: Criteria;
    readonly topic: string;
    readonly readOnly: boolean;

    readonly #deps: ResolvedDeps;
    /** Chain clients for this contest, built from `criteria.requires.chains` via the factory. */
    readonly #chainClients: ChainClients;
    readonly #updateListeners: Array<() => void> = [];

    constructor(criteria: Criteria, topic: string, deps: ResolvedDeps) {
        this.criteria = criteria;
        this.topic = topic;
        this.readOnly = deps.signer === undefined;
        this.#deps = deps;
        this.#chainClients = Object.fromEntries(
            Object.entries(criteria.requires.chains).map(
                ([chain, config]): [string, ChainClient] => [chain, deps.chains({ chain, config })]
            )
        );
    }

    async start(): Promise<void> {
        throw new NotImplementedError("VoteNetwork.start (transport + CRDT sync)");
    }

    async stop(): Promise<void> {
        // Nothing is started yet, so stopping is a no-op until the transport lands.
    }

    async castVotes(_votes: Vote[]): Promise<VotesBundle> {
        if (this.#deps.signer === undefined) throw new ReadOnlyError();
        throw new NotImplementedError("VoteNetwork.castVotes (sign + CRDT add + broadcast)");
    }

    async getTally(_options?: TallyOptions): Promise<ContestTally> {
        void this.#chainClients;
        throw new NotImplementedError("VoteNetwork.getTally (lazy top-down verify)");
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
            registry: resolveRegistry(options.interpreters),
            nameResolvers: options.nameResolvers ?? []
        };
    }

    get readOnly(): boolean {
        return this.#deps.signer === undefined;
    }

    async contest(criteria: Criteria): Promise<VoteNetwork> {
        const validated = CriteriaSchema.parse(criteria);
        validateCriteriaInterpreters(validated, this.#deps.registry);
        const topic = await topicFor(validated);
        const existing = this.#contests.get(topic);
        if (existing) return existing;
        const network = new ContestNetwork(validated, topic, this.#deps);
        this.#contests.set(topic, network);
        return network;
    }

    async contestsFromManifest(manifest: unknown): Promise<VoteNetwork[]> {
        return Promise.all(deriveCriteria(manifest).map((criteria) => this.contest(criteria)));
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.#contests.values()].map((network) => network.stop()));
    }
}
