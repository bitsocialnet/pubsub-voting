import type { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
import type { Helia } from "helia";
import type { RootRecord } from "./messages.js";

/**
 * Transport interfaces. This is the ONLY part of the library that
 * touches libp2p/helia. The core (schema/verify/crdt/tally) does not import it, so the
 * engine is testable without a network.
 *
 * Three exchanges (see DESIGN.md "Transport"):
 *   - pubsub: broadcast and receive **inline bundle deltas** and **root-record heartbeats**
 *     (gossipsub), with a topic validator that drops invalid messages before the mesh
 *     re-forwards them.
 *   - fetch protocol: pull a connected peer's current root record on cold start / reconnect,
 *     then union across peers so a single liar cannot hide a vote.
 *   - directed bitswap: pull the checkpoint blocks behind an advertised root from the
 *     connected peers that advertised it (through the blockstore) — the only bitswap use.
 *
 * The library does not start a node and does not take a host SDK. It receives the
 * host's already-running **Helia node** directly (e.g. the value `createHelia` returns,
 * which for a pkc-js host is `pkc.clients.libp2pJsClients[key]._helia`) and drives its
 * libp2p pubsub + blockstore itself — there is no host-written adapter. The node must
 * carry a gossipsub service at `libp2p.services.pubsub` and a usable `blockstore`;
 * construction enforces both (see `requireHeliaServices` / `MissingPubsubError` /
 * `MissingBlockstoreError`).
 */

/**
 * Verdict from a gossipsub topic validator. Mirrors the semantics of libp2p's
 * `TopicValidatorResult` (accept / reject / ignore) but is declared locally:
 * `@libp2p/interface` 3.x no longer re-exports the pubsub types, so the
 * implementation maps these onto whatever enum the host's gossipsub uses.
 *   - "accept": valid; deliver to subscribers and let the mesh re-forward it.
 *   - "reject": invalid; drop, do not forward, and penalize the sender's peer score.
 *   - "ignore": drop and do not forward, without penalizing (well-formed but not useful).
 */
export type TopicValidatorResult = "accept" | "reject" | "ignore";

/**
 * The subset of a libp2p pubsub (gossipsub) service this library drives, declared
 * structurally because `@libp2p/interface` 3.x no longer re-exports `PubSub`. Any
 * gossipsub implementation the host registers at `services.pubsub` satisfies this
 * (e.g. `@chainsafe/libp2p-gossipsub`). Kept minimal on purpose; the full transport
 * (topic validators, fetch protocol) is design-only and may widen this as it lands.
 */
export interface PubsubService {
    /**
     * Broadcast bytes to a topic mesh. gossipsub resolves to `{ recipients }` — the peers it
     * *directly sent the RPC to* at publish time (first-hop fan-out, filtered for send failures),
     * NOT total network reach and NOT an acceptance confirmation (each recipient still runs the
     * forward-gate). With the host's default `floodPublish`, that's every connected topic peer
     * above the publish score threshold. Typed loosely (`recipients` optional) so a non-gossipsub
     * pubsub still satisfies it; the transport reads `recipients?.length ?? 0`. Note gossipsub
     * *rejects* with `NoPeersSubscribedToTopic` when it would send to zero peers unless the host
     * sets `allowPublishToZeroTopicPeers`.
     */
    publish(topic: string, data: Uint8Array): Promise<{ recipients?: readonly PeerId[] }>;
    /** Join a topic; received messages arrive via the "message" event. */
    subscribe(topic: string): void;
    /** Leave a topic. */
    unsubscribe(topic: string): void;
    /** Peers we currently see subscribed to a topic, used to pick fetch targets. */
    getSubscribers(topic: string): PeerId[];
    addEventListener(type: "message", listener: (evt: { detail: { topic: string; data: Uint8Array; from?: PeerId } }) => void): void;
    removeEventListener(type: "message", listener: (evt: { detail: { topic: string; data: Uint8Array; from?: PeerId } }) => void): void;
    /**
     * gossipsub's "a peer's subscription set changed" notification. The cold-start pull
     * re-runs off it (see client/voter.ts `#armSubscriptionRepull`): a joiner that dials a
     * seeder and joins immediately sees zero subscribers at the instant of `join()` — the
     * seeder only appears here once subscription gossip lands — so without this trigger it
     * would idle until the topic heartbeat.
     */
    addEventListener(type: "subscription-change", listener: SubscriptionChangeListener): void;
    removeEventListener(type: "subscription-change", listener: SubscriptionChangeListener): void;
    /**
     * gossipsub's per-topic validator map. The transport installs the async forward-gate
     * here (`topicValidators.set(topic, gate)`); gossipsub awaits the returned promise
     * before re-forwarding the message to the mesh, which is what makes `reject` land on the
     * sender for semantic invalidity. Optional because a non-gossipsub pubsub lacks it — the
     * transport checks for it at `start()` and throws if absent. `@libp2p/gossipsub` exposes
     * it as a mutable `Map`. See DESIGN.md "Transport".
     */
    topicValidators?: Map<string, GossipTopicValidator>;
}

/** Listener for gossipsub's `subscription-change` (the libp2p `SubscriptionChangeData` shape). */
export type SubscriptionChangeListener = (evt: {
    detail: { peerId: PeerId; subscriptions: Array<{ topic: string; subscribe: boolean }> };
}) => void;

/** A received pubsub message, as passed to a gossipsub topic validator. */
export interface GossipMessage {
    topic: string;
    data: Uint8Array;
    from?: PeerId;
}

/**
 * A gossipsub topic validator: run on every received message BEFORE re-forwarding, returning
 * (or resolving to) a {@link TopicValidatorResult}. Returning a promise makes the gate async —
 * gossipsub awaits it, so the full fetch + verify pipeline can run before the message is
 * forwarded (see DESIGN.md "Transport"). Declared structurally so the library imports no
 * gossipsub package; `@libp2p/gossipsub`'s `TopicValidatorFn` satisfies it.
 */
export type GossipTopicValidator = (
    peer: PeerId,
    message: GossipMessage
) => TopicValidatorResult | Promise<TopicValidatorResult>;

/**
 * The subset of the libp2p **fetch service** (`@libp2p/fetch`) this library drives,
 * declared structurally so no runtime dependency on the package is needed. The host MUST
 * register it at `libp2p.services.fetch`; construction throws `MissingFetchError`
 * otherwise. Used for the root-record pull (see DESIGN.md "Checkpoints"): this library
 * registers a lookup for its own key prefix (the responder) and fetches connected topic
 * peers' records on cold start (the requester).
 */
export interface FetchServiceLike {
    /** Request the value for `key` from a connected peer; nullish when the peer has none. */
    fetch(peer: PeerId, key: string, options?: { signal?: AbortSignal }): Promise<Uint8Array | undefined | null>;
    /**
     * Register the responder for every key starting with `prefix`. `@libp2p/fetch` invokes the
     * lookup with the requested key as **raw bytes** (`Uint8Array`), not a string — it matches the
     * `prefix` against the utf8-decoded key but hands the callback the identifier bytes. The
     * responder decodes them itself (see `PubsubVoter.#rootLookup`).
     */
    registerLookupFunction(prefix: string, lookup: (key: Uint8Array) => Promise<Uint8Array | undefined>): void;
    /** Remove a registered responder (all of the prefix's, when `lookup` is omitted). */
    unregisterLookupFunction(prefix: string, lookup?: (key: Uint8Array) => Promise<Uint8Array | undefined>): void;
}

/**
 * The subset of a Helia blockstore this library drives, declared structurally. Vote
 * bundles are content-addressed blocks fetched/stored by CID through it (bitswap
 * retrieves through the blockstore). The full `Blocks` type carries progress-event
 * generics we do not need here.
 */
export interface BlockstoreLike {
    /** `options.signal` cancels an in-flight bitswap fetch — see the chase deadline (DESIGN.md "Checkpoints"). */
    get(cid: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
    put(cid: CID, block: Uint8Array): Promise<CID>;
    has(cid: CID): Promise<boolean>;
    /**
     * Open a provider-scoped bitswap session rooted at `root`: wants go to the session's
     * providers as targeted session wants instead of a broadcast to every connected peer, and
     * provider discovery runs once per session instead of once per block (see DESIGN.md "Block
     * pull"). Optional — plain blockstores (and the unit tests' mocks) lack it; callers MUST
     * feature-detect and fall back to the broadcast `get`.
     */
    createSession?(root: CID, options: { providers: PeerId[]; maxProviders?: number }): BlockSessionLike;
}

/**
 * A session-scoped view of {@link BlockstoreLike.get}, mirroring Helia's `SessionBlockstore`.
 * Blocks fetched through it still land in the underlying blockstore.
 */
export interface BlockSessionLike {
    get(cid: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
    /** Add a late-arriving provider to the running session (rejections are the caller's to swallow). */
    addPeer(peer: PeerId): Promise<void> | void;
    /** Abort the session's in-flight wants and release it. */
    close(): void;
}

/**
 * The host's running Helia node, as injected into {@link PubsubVoter}. Typed with the
 * default libp2p `ServiceMap`, so `libp2p.services.pubsub` is `unknown` and cannot be
 * trusted at compile time (a plain Helia node has no pubsub) — `requireHeliaServices`
 * validates the gossipsub service and the blockstore at construction and narrows them.
 */
export type HeliaInstance = Helia;

/** Live-delta propagation over pubsub (one inline bundle per message + root heartbeats). */
export interface VoteTransport {
    /**
     * Subscribe to the topic and install the async validate-before-forward gate as the
     * topic validator. See DESIGN.md "Transport: gossipsub topic + validation".
     */
    start(): Promise<void>;
    stop(): Promise<void>;

    /**
     * Publish one bundle's exact binary block bytes as a live delta (a new vote, a client
     * re-publish, or a withdrawal). Resolves `recipientCount`: how many peers gossipsub sent the
     * message directly to (see {@link PubsubService.publish} for what that number does and does not
     * mean).
     */
    publishBundle(blockBytes: Uint8Array): Promise<{ recipientCount: number }>;

    /** Publish a root-record heartbeat (see DESIGN.md "Checkpoints"). */
    publishRootRecord(record: RootRecord): Promise<void>;
}
