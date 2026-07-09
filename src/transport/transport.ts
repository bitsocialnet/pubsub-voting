import type { PubsubService, GossipTopicValidator, VoteTransport } from "./types.js";
import type { GossipGate } from "./gossip-validator.js";
import { encodeBundleMessage, encodeRootMessage, type RootRecord } from "./messages.js";

/**
 * The live transport: wires the host's gossipsub to the forward-gate. This is the only place
 * the async validator is installed on a real topic; the decision logic lives in the pure
 * {@link GossipGate} (gossip-validator.ts), so this module is thin glue.
 *
 * On `start` it installs the gate as the topic validator (gossipsub awaits it before
 * re-forwarding — see DESIGN.md "Transport") and subscribes. Publishing is the live-delta
 * model: one inline bundle per message (a new vote, a client re-publish, or a withdrawal), or a
 * root-record heartbeat. Cold-start root pulls ride the libp2p fetch protocol, not pubsub
 * (see DESIGN.md "Checkpoints").
 */

export interface VoteTransportDeps {
    pubsub: PubsubService;
    topic: string;
    /** The forward-gate; validates + merges accepted bundles, surfaces root records. */
    gate: GossipGate;
}

export function makeVoteTransport(deps: VoteTransportDeps): VoteTransport {
    const { pubsub, topic, gate } = deps;

    // The installed gossipsub validator: filter to our topic and run the gate. Returning a
    // promise makes gossipsub await the full pipeline before forwarding. Accepted bundles are
    // merged (and root records surfaced) by the gate's own callbacks.
    const validator: GossipTopicValidator = async (peer, message) => {
        if (message.topic !== topic) return "ignore";
        return gate.validate(message.data, peer.toString());
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
        },

        async stop() {
            pubsub.topicValidators?.delete(topic);
            pubsub.unsubscribe(topic);
        },

        async publishBundle(blockBytes: Uint8Array) {
            // gossipsub resolves `{ recipients }`; a non-gossipsub pubsub may resolve nothing —
            // fall back to 0 rather than assume the shape.
            const result = await pubsub.publish(topic, encodeBundleMessage(blockBytes));
            return { recipientCount: result?.recipients?.length ?? 0 };
        },

        async publishRootRecord(record: RootRecord) {
            await pubsub.publish(topic, encodeRootMessage(record));
        }
    };
}
