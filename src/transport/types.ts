import type { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";

/**
 * Transport interfaces, design only. This is the ONLY part of the library that
 * touches libp2p. The core (schema/verify/crdt/tally) does not import it, so the
 * engine is testable without a network.
 *
 * Two transports:
 *   - pubsub: broadcast and receive head CIDs (gossipsub).
 *   - fetch: pull a peer's current heads on cold start (libp2p fetch protocol),
 *     then union across several peers so a single liar cannot hide a vote.
 *
 * The library does not start a node. It receives an injected handle from the host;
 * today that is pkc.clients.libp2pJsClients[key]._helia, replaced later by a
 * version-stable accessor on pkc-js (see DESIGN.md "Deferred pkc-js work").
 */

/** The minimal injected handle the transport needs from the host node. */
export interface Libp2pHandle {
    /** Publish bytes to a gossipsub topic. */
    publish(topic: string, data: Uint8Array): Promise<void>;
    /** Subscribe to a gossipsub topic; `onMessage` fires per received message. */
    subscribe(topic: string, onMessage: (data: Uint8Array, from: PeerId) => void): Promise<void>;
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
