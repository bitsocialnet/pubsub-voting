import type { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
import type { Helia } from "helia";

/**
 * Transport interfaces, design only. This is the ONLY part of the library that
 * touches libp2p/helia. The core (schema/verify/crdt/tally) does not import it, so the
 * engine is testable without a network.
 *
 * Two transports:
 *   - pubsub: broadcast and receive head CIDs (gossipsub), with a topic validator
 *     that drops invalid messages before the mesh re-forwards them.
 *   - fetch: resolve vote bundles by CID through the host's blockstore, and pull a
 *     peer's current heads on cold start, then union across peers so a single liar
 *     cannot hide a vote.
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
    /** Broadcast bytes to a topic mesh. */
    publish(topic: string, data: Uint8Array): Promise<unknown>;
    /** Join a topic; received messages arrive via the "message" event. */
    subscribe(topic: string): void;
    /** Leave a topic. */
    unsubscribe(topic: string): void;
    /** Peers we currently see subscribed to a topic, used to pick fetch targets. */
    getSubscribers(topic: string): PeerId[];
    addEventListener(type: "message", listener: (evt: { detail: { topic: string; data: Uint8Array; from?: PeerId } }) => void): void;
    removeEventListener(type: "message", listener: (evt: { detail: { topic: string; data: Uint8Array; from?: PeerId } }) => void): void;
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
 * The subset of a Helia blockstore this library drives, declared structurally. Vote
 * bundles are content-addressed blocks fetched/stored by CID through it (bitswap
 * retrieves through the blockstore). The full `Blocks` type carries progress-event
 * generics we do not need here.
 */
export interface BlockstoreLike {
    get(cid: CID): Promise<Uint8Array>;
    put(cid: CID, block: Uint8Array): Promise<CID>;
    has(cid: CID): Promise<boolean>;
}

/**
 * The host's running Helia node, as injected into {@link PubsubVoter}. Typed with the
 * default libp2p `ServiceMap`, so `libp2p.services.pubsub` is `unknown` and cannot be
 * trusted at compile time (a plain Helia node has no pubsub) — `requireHeliaServices`
 * validates the gossipsub service and the blockstore at construction and narrows them.
 */
export type HeliaInstance = Helia;

/** Live head propagation over pubsub. */
export interface VoteTransport {
    /**
     * Subscribe to the topic and install the cheap topic validator, built from the
     * criteria (max CIDs per message, size cap, per-peer rate), then fetch and union
     * heads from peers. See DESIGN.md "Transport: gossipsub topic + validation".
     */
    start(): Promise<void>;
    stop(): Promise<void>;

    /** Announce our current heads to the topic. */
    broadcastHeads(heads: CID[]): Promise<void>;

    /** Called when a peer announces heads. */
    onHeads(cb: (heads: CID[], from: PeerId) => void): void;

    /**
     * Cold-start sync: fetch current heads from up to `k` peers and union them.
     * Union is safe because more sources can only add knowledge; this is the
     * anti-censorship guarantee. See DESIGN.md "Can always-online peers drop votes?".
     */
    fetchHeadsFromPeers(k: number): Promise<CID[]>;
}
