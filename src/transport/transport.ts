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
 * re-forwarding — see DESIGN.md "Transport"), subscribes, and cold-starts by unioning the
 * current winner CIDs from up to `k` peers through the SAME gate (so cold-start CIDs are
 * validated too, not trusted). Cold-start reuses `gate.validate(encodeWinnerCids(cids), …)`
 * rather than a second verification path.
 */

export interface VoteTransportDeps {
    pubsub: PubsubService;
    topic: string;
    /** The forward-gate; validates + merges accepted messages. */
    gate: GossipGate;
    encodeWinnerCids: (cids: CID[]) => Uint8Array;
    decodeWinnerCids: (data: Uint8Array) => CID[];
    /** Our current winner CIDs (crdt.winnerCids), for broadcasting and cold-start return. */
    getWinnerCids: () => CID[];
    /** Cold start: fetch a peer's current winner CIDs via the libp2p fetch protocol. Omit to skip. */
    fetchWinnerCidsFromPeer?: (peer: PeerId) => Promise<CID[]>;
}

export function makeVoteTransport(deps: VoteTransportDeps): VoteTransport {
    const { pubsub, topic, gate, encodeWinnerCids, decodeWinnerCids, getWinnerCids, fetchWinnerCidsFromPeer } = deps;
    const winnerCidsListeners = new Set<(cids: CID[], from: PeerId) => void>();

    // The installed gossipsub validator: filter to our topic, run the gate, and on accept
    // notify winner-CID listeners (the gate has already merged into the CRDT). Returning a
    // promise makes gossipsub await the full pipeline before forwarding.
    const validator: GossipTopicValidator = async (peer, message) => {
        if (message.topic !== topic) return "ignore";
        const verdict = await gate.validate(message.data, peer.toString());
        if (verdict === "accept") {
            try {
                const cids = decodeWinnerCids(message.data);
                for (const cb of winnerCidsListeners) cb(cids, peer);
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
            await this.fetchWinnerCidsFromPeers(4);
        },

        async stop() {
            pubsub.topicValidators?.delete(topic);
            pubsub.unsubscribe(topic);
        },

        async broadcastWinnerCids(cids: CID[]) {
            await pubsub.publish(topic, encodeWinnerCids(cids));
        },

        onWinnerCids(cb: (cids: CID[], from: PeerId) => void) {
            winnerCidsListeners.add(cb);
        },

        async fetchWinnerCidsFromPeers(k: number): Promise<CID[]> {
            if (fetchWinnerCidsFromPeer) {
                const peers = pubsub.getSubscribers(topic).slice(0, k);
                for (const peer of peers) {
                    try {
                        const cids = await fetchWinnerCidsFromPeer(peer);
                        if (cids.length > 0) {
                            // Validate + merge through the gate; a single liar cannot inject a
                            // bad vote, and union-only means it cannot hide an honest one.
                            await gate.validate(encodeWinnerCids(cids), peer.toString());
                        }
                    } catch {
                        // A flaky peer just contributes nothing; other peers still union in.
                    }
                }
            }
            return getWinnerCids();
        }
    };
}
