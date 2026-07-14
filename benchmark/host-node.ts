import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { fetch as fetchService } from "@libp2p/fetch";
import { delegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { createHelia, type Helia } from "helia";
import type { PubsubService } from "../dist/transport/types.js";

/**
 * The real libp2p + Helia node the cold-join **latency benchmark** stands up — the same stack a
 * host injects (`@libp2p/gossipsub`, `@libp2p/fetch`, tcp/noise/yamux/identify, Helia's blockstore
 * + bitswap), factored out of the two-node integration harness so the seeder, its feeders, and the
 * cold joiner all build identical nodes. A real Helia node already satisfies `HeliaInstance`
 * (`libp2p.services.pubsub`/`.fetch`, `blockstore`), so it drops straight into `PubsubVoter`.
 *
 * Unlike the unit-test harness this measures wall-clock latency, so the config leans realistic: no
 * heartbeat override unless asked (gossipsub's own default), and the ONE score tweak the benchmark
 * genuinely needs — `IPColocationFactorWeight: 0`. The seeder's in-process feeders all connect to it
 * over 127.0.0.1, so the colocation penalty would graylist them mid-seed and stall the checkpoint;
 * the two-node harness zeroes it for the same loopback reason. (The cold joiner now dials the seeder
 * at its real public IP, so that path no longer colocates regardless.)
 */

/** The gossipsub introspection the benchmark reads (mesh + subscriber views), beyond `PubsubService`. */
interface GossipView {
    getMeshPeers(topic: string): string[];
    getSubscribers(topic: string): { toString(): string }[];
    subscribe(topic: string): void;
    unsubscribe(topic: string): void;
    publish(topic: string, data: Uint8Array): Promise<unknown>;
}

export interface HostNode {
    libp2p: Libp2p;
    helia: Helia;
    /** The gossipsub service, structurally typed to the subset the library drives. */
    pubsub: PubsubService;
    peerId: string;
    /** This node's dialable listen addresses (TCP), as strings for printing/forwarding. */
    multiaddrs(): string[];
    /** Peers currently grafted into this node's mesh for `topic`. */
    meshPeers(topic: string): string[];
    /** Peers this node currently sees subscribed to `topic` (drives the cold-start fetch fan-out). */
    subscribers(topic: string): string[];
    /** Subscribe + publish directly on the gossipsub service (used by seeding feeders). */
    subscribe(topic: string): void;
    publish(topic: string, data: Uint8Array): Promise<unknown>;
    stop(): Promise<void>;
}

export interface HostNodeOptions {
    /** TCP listen port; 0 (default) picks an ephemeral port. */
    port?: number;
    /** Listen host; default 0.0.0.0 so a public seeder is dialable from off-box. */
    host?: string;
    /**
     * libp2p announce addresses (`addresses.announce`): what `getMultiaddrs()` — and therefore the
     * provider-record announcer — advertises instead of the interface addrs. The bench seeder sets
     * its public `/ip4|dns4/<host>/tcp/<port>` here, modelling a real deployment where the host
     * configures its dialable address (a NATed box's interface addrs are private and would be
     * filtered out of the announce entirely).
     */
    announce?: string[];
    /** gossipsub heartbeat (ms); omit to use gossipsub's own default (realistic mesh timing). */
    heartbeatInterval?: number;
    /**
     * Delegated Routing V1 HTTP router URL(s) to wire as content router(s), exactly as pkc-js does
     * (`delegatedRoutingV1HttpApiClient`). With this set, `libp2p.contentRouting.findProviders(cid)`
     * queries the router — which is how the cold joiner discovers the seeder.
     */
    routerUrls?: string[];
    /**
     * Override the libp2p **fetch** service's `maxInboundStreams`/`maxOutboundStreams`. libp2p 3.3.4
     * defaults every protocol handler to 32 inbound (registrar.js `DEFAULT_MAX_INBOUND_STREAMS`), so a
     * shared seeder rejects the 33rd concurrent root-record fetch — which strands a big directory that
     * cold-joins all its contests at once. Raising this on the SEEDER lets a naive all-at-once join
     * pull every checkpoint. Models the host-side (pkc-js) config that would ship in production.
     */
    fetchMaxStreams?: number;
}

/** Build one real libp2p + Helia node with gossipsub + fetch, ready to back a `PubsubVoter`. */
export async function makeHostNode(options: HostNodeOptions = {}): Promise<HostNode> {
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? 0;
    const routers = Object.fromEntries(
        (options.routerUrls ?? []).map((url, i) => [`delegatedRouting${i}`, delegatedRoutingV1HttpApiClient({ url })])
    );
    const libp2p = await createLibp2p({
        addresses: {
            listen: [`/ip4/${host}/tcp/${port}`],
            ...(options.announce !== undefined ? { announce: options.announce } : {})
        },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            ...routers,
            identify: identify(),
            fetch: fetchService(
                options.fetchMaxStreams !== undefined
                    ? { maxInboundStreams: options.fetchMaxStreams, maxOutboundStreams: options.fetchMaxStreams }
                    : {}
            ),
            pubsub: gossipsub({
                allowPublishToZeroTopicPeers: true,
                ...(options.heartbeatInterval !== undefined ? { heartbeatInterval: options.heartbeatInterval } : {}),
                // Both ends appear as 127.0.0.1 over an SSH port-forward (and on loopback): the
                // IP-colocation penalty would graylist an honest peer, so zero it.
                scoreParams: { IPColocationFactorWeight: 0 }
            })
        }
    });
    const helia = await createHelia({ libp2p });
    const gossip = libp2p.services.pubsub as unknown as GossipView;
    const pubsub = libp2p.services.pubsub as unknown as PubsubService;
    return {
        libp2p,
        helia,
        pubsub,
        peerId: libp2p.peerId.toString(),
        multiaddrs: () => libp2p.getMultiaddrs().map((addr) => addr.toString()),
        meshPeers: (topic) => gossip.getMeshPeers(topic),
        subscribers: (topic) => gossip.getSubscribers(topic).map((p) => p.toString()),
        subscribe: (topic) => gossip.subscribe(topic),
        publish: (topic, data) => gossip.publish(topic, data),
        stop: async () => {
            await helia.stop();
        }
    };
}

/** Poll `predicate` until truthy or `timeoutMs` elapses (then throw with `description`). */
export async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 30_000,
    description = "condition"
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
        await delay(50);
    }
}

/** Resolve after `ms`; used only to space out polls. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dial `target` from `dialer` and wait until gossipsub has grafted them into each other's mesh for
 * `topic`, so a subsequent publish is reliably delivered. Both must already be subscribed to
 * `topic`.
 */
export async function connectPeers(dialer: HostNode, target: HostNode, topic: string, timeoutMs = 30_000): Promise<void> {
    await dialer.libp2p.dial(target.libp2p.getMultiaddrs());
    await waitFor(
        () => dialer.meshPeers(topic).includes(target.peerId) && target.meshPeers(topic).includes(dialer.peerId),
        timeoutMs,
        "gossipsub mesh to form between the two nodes"
    );
}
