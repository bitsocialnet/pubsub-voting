import type { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
import type { PubsubService, GossipTopicValidator, VoteTransport } from "./types.js";
import type { GossipGate } from "./gossip-validator.js";

/**
 * The live transport: wires the host's gossipsub to the forward-gate and the CRDT. This is
 * the only place the async validator is installed on a real topic; the decision logic lives
 * in the pure {@link GossipGate} (gossip-validator.ts), so this module is thin glue.
 *
 * On `start` it installs the gate as the topic validator (gossipsub awaits it before
 * re-forwarding — see DESIGN.md "Transport"), subscribes, and cold-starts by unioning heads
 * from up to `k` peers through the SAME gate (so cold-start heads are validated too, not
 * trusted). Cold-start reuses `gate.validate(encodeHeads(heads), …)` rather than a second
 * verification path.
 */

export interface VoteTransportDeps {
    pubsub: PubsubService;
    topic: string;
    /** The forward-gate; validates + merges accepted messages. */
    gate: GossipGate;
    encodeHeads: (heads: CID[]) => Uint8Array;
    decodeHeads: (data: Uint8Array) => CID[];
    /** Our current DAG heads (crdt.heads), for broadcasting and cold-start return. */
    getHeads: () => CID[];
    /** Cold start: fetch a peer's current heads via the libp2p fetch protocol. Omit to skip. */
    fetchHeadsFromPeer?: (peer: PeerId) => Promise<CID[]>;
}

export function makeVoteTransport(deps: VoteTransportDeps): VoteTransport {
    const { pubsub, topic, gate, encodeHeads, decodeHeads, getHeads, fetchHeadsFromPeer } = deps;
    const headsListeners = new Set<(heads: CID[], from: PeerId) => void>();

    // The installed gossipsub validator: filter to our topic, run the gate, and on accept
    // notify head listeners (the gate has already merged into the CRDT). Returning a promise
    // makes gossipsub await the full pipeline before forwarding.
    const validator: GossipTopicValidator = async (peer, message) => {
        if (message.topic !== topic) return "ignore";
        const verdict = await gate.validate(message.data, peer.toString());
        if (verdict === "accept") {
            try {
                const heads = decodeHeads(message.data);
                for (const cb of headsListeners) cb(heads, peer);
            } catch {
                // Accepted messages always decode; guard defensively without failing the verdict.
            }
        }
        return verdict;
    };

    return {
        async start() {
            if (!pubsub.topicValidators) {
                throw new Error(
                    "the injected pubsub has no `topicValidators` map; a gossipsub service is required to " +
                        "install the validate-before-forward gate. See DESIGN.md \"Transport\"."
                );
            }
            pubsub.topicValidators.set(topic, validator);
            pubsub.subscribe(topic);
            await this.fetchHeadsFromPeers(4);
        },

        async stop() {
            pubsub.topicValidators?.delete(topic);
            pubsub.unsubscribe(topic);
        },

        async broadcastHeads(heads: CID[]) {
            await pubsub.publish(topic, encodeHeads(heads));
        },

        onHeads(cb: (heads: CID[], from: PeerId) => void) {
            headsListeners.add(cb);
        },

        async fetchHeadsFromPeers(k: number): Promise<CID[]> {
            if (fetchHeadsFromPeer) {
                const peers = pubsub.getSubscribers(topic).slice(0, k);
                for (const peer of peers) {
                    try {
                        const heads = await fetchHeadsFromPeer(peer);
                        if (heads.length > 0) {
                            // Validate + merge through the gate; a single liar cannot inject a
                            // bad vote, and union-only means it cannot hide an honest one.
                            await gate.validate(encodeHeads(heads), peer.toString());
                        }
                    } catch {
                        // A flaky peer just contributes nothing; other peers still union in.
                    }
                }
            }
            return getHeads();
        }
    };
}
