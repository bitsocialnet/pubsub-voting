import type { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";

/**
 * Transport interfaces, design only. This is the ONLY part of the library that
 * touches libp2p. The core (schema/verify/crdt/tally) does not import it, so the
 * engine is testable without a network.
 *
 * Two transports:
 *   - pubsub: broadcast and receive head CIDs (gossipsub), with a topic validator
 *     that drops invalid messages before the mesh re-forwards them.
 *   - fetch: pull a peer's current heads on cold start (libp2p fetch protocol),
 *     then union across several peers so a single liar cannot hide a vote.
 *
 * The library does not start a node. It receives an injected handle from the host;
 * today that is pkc.clients.libp2pJsClients[key]._helia, replaced later by a
 * version-stable accessor on pkc-js (see DESIGN.md "Deferred pkc-js work").
 */

/**
 * Verdict from a gossipsub topic validator. Mirrors the semantics of libp2p's
 * `TopicValidatorResult` (accept / reject / ignore) but is declared locally:
 * `@libp2p/interface` 3.x no longer re-exports the pubsub types, so the
 * implementation maps these onto whatever enum the host's gossipsub uses.
 *   - "accept": valid; deliver to `onMessage` and let the mesh re-forward it.
 *   - "reject": invalid; drop, do not forward, and penalize the sender's peer score.
 *   - "ignore": drop and do not forward, without penalizing (well-formed but not useful).
 */
export type TopicValidatorResult = "accept" | "reject" | "ignore";

/** The minimal injected handle the transport needs from the host node. */
export interface Libp2pHandle {
    /** Publish bytes to a gossipsub topic. */
    publish(topic: string, data: Uint8Array): Promise<void>;
    /**
     * Subscribe to a gossipsub topic; `onMessage` fires per received message.
     *
     * If `validate` is supplied it is installed as the topic validator, run on every
     * received message *before* the mesh re-forwards it, so a "reject"/"ignore" stops
     * an invalid message from propagating. It is installed atomically with the
     * subscription (no window where unvalidated messages flow), and `onMessage` only
     * fires for messages it accepts. The validator sees just the raw bytes, so it does
     * cheap structural checks (well-formed, bounded list of CIDs, size, per-peer rate);
     * full vote verification happens later, after the bundle is fetched by CID.
     * See DESIGN.md "Transport: gossipsub topic + validation".
     */
    subscribe(
        topic: string,
        onMessage: (data: Uint8Array, from: PeerId) => void,
        validate?: (data: Uint8Array, from: PeerId) => TopicValidatorResult | Promise<TopicValidatorResult>
    ): Promise<void>;
    unsubscribe(topic: string): Promise<void>;
    /** Connected peers on a topic, used to pick fetch targets. */
    peers(topic: string): Promise<PeerId[]>;
    /** libp2p fetch protocol: request a key from a specific peer. */
    fetch(peer: PeerId, key: string): Promise<Uint8Array | undefined>;
    /** Register a libp2p fetch responder for a key prefix (to serve our heads). */
    handleFetch(keyPrefix: string, handler: (key: string) => Promise<Uint8Array | undefined>): Promise<void>;
}

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
