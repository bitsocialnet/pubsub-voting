import { PubsubVoter, type Contest } from "../dist/client/voter.js";
import { encodeBundle } from "../dist/crdt/codec.js";
import { encodeBundleMessage } from "../dist/transport/messages.js";
import { makeHostNode, connectPeers, waitFor, delay, type HostNode } from "./host-node.js";
import { benchChains, benchCriteria, makeSigningContext, signRandomVoter } from "./signing.js";

/**
 * Cold-join benchmark — SEEDER side (runs on the remote WAN host).
 *
 * Stands up ONE real `PubsubVoter` (read-only) over a real libp2p+Helia node, seeds its contest with
 * `N` real-signed voters through the REAL forward gate (no private-state access), waits until its
 * tally reflects all `N`, then prints a single `SEEDER_READY ...` line and stays alive so a cold
 * joiner can pull its checkpoint over the WAN. Killed with SIGINT/SIGTERM between sweep points.
 *
 * Seeding uses multiple in-process **feeder** nodes rather than one: the gate rate-limits bundle
 * messages to 256 per 10s PER PEER (over-rate ⇒ `ignore`, silently dropped), so one feeder could not
 * push 1000 bundles. Chunking across feeders (each ≤ {@link FEED_CHUNK}) keeps every bundle within a
 * feeder's window, so all `N` merge without touching any production constant.
 *
 * Usage: `node benchmark/seeder.js <N> <PORT>` (or env `BENCH_N`/`BENCH_PORT`), after `npm run build:bench`.
 *
 * Provider-record announcing (the real thing, no hardcoded router record):
 *   `BENCH_ROUTER_URL`     — Delegated Routing V1 base URL to announce to; the orchestrator runs the
 *                            router on the joiner's machine and reverse-tunnels it here (`ssh -R`),
 *                            which is out-of-band of the measured join path. Sets the voter's
 *                            `httpRouterUrls`, so the seeder PUTs its criteria CID + checkpoint
 *                            root + chunk CIDs exactly as a production seeder would.
 *   `BENCH_ANNOUNCE_ADDR`  — the seeder's public multiaddr (no `/p2p/`), set as libp2p's announce
 *                            address so `getMultiaddrs()` (what the announcer publishes) names the
 *                            address the joiner can actually dial, not the box's interface addrs.
 */

/** Voter ballots published per feeder peer — safely under the gate's 256/10s per-peer bundle window. */
const FEED_CHUNK = 240;

async function seedVoters(seeder: HostNode, topic: string, network: Contest, count: number): Promise<void> {
    const ctx = await makeSigningContext(benchCriteria());
    let published = 0;
    // One feeder per chunk, DRAINED before the next: publish a chunk, wait for the seeder to
    // verify+merge everything so far, then drop the feeder and spin the next. The seeder verifies
    // each bundle synchronously (secp256k1 recovery blocks the event loop), so if feeders keep
    // arriving while a verify backlog drains, the next feeder's gossipsub mesh formation starves and
    // times out — which is exactly how large seeds (N≥10k) died. Draining keeps the event loop free
    // when each new feeder meshes, at the cost of a serial seed.
    for (let offset = 0; offset < count; offset += FEED_CHUNK) {
        const chunk = Math.min(FEED_CHUNK, count - offset);
        const feeder = await makeHostNode({ host: "127.0.0.1" });
        feeder.subscribe(topic);
        await connectPeers(feeder, seeder, topic);
        for (let i = 0; i < chunk; i++) {
            const bundle = await signRandomVoter(ctx);
            await feeder.publish(topic, encodeBundleMessage(encodeBundle(bundle)));
            published++;
        }
        const target = BigInt(published);
        await waitFor(
            async () => ((await network.getTally()).ranking[0]?.weight ?? 0n) >= target,
            120_000,
            `seeder to merge ${published} voters`
        );
        await feeder.stop();
        process.stderr.write(`[seeder] merged ${published}/${count} voters\n`);
    }
    // Let the mesh settle after the last feeder disconnects before we advertise readiness.
    await delay(500);
}

async function main(): Promise<void> {
    const n = Number(process.argv[2] ?? process.env.BENCH_N ?? "10");
    const port = Number(process.argv[3] ?? process.env.BENCH_PORT ?? "40001");
    if (!Number.isInteger(n) || n < 0) throw new Error(`bad N: ${process.argv[2]}`);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`bad PORT: ${process.argv[3]}`);

    const routerUrl = process.env.BENCH_ROUTER_URL;
    const announceAddr = process.env.BENCH_ANNOUNCE_ADDR;
    const seeder = await makeHostNode({ port, ...(announceAddr ? { announce: [announceAddr] } : {}) });
    const voter = new PubsubVoter({
        dataPath: false,
        helia: seeder.helia,
        chains: benchChains(),
        ...(routerUrl ? { httpRouterUrls: [routerUrl] } : {})
    });
    const network = await voter.createContest({ criteria: benchCriteria() });
    await network.update(); // join + serve: installs the gate and registers the fetch responder

    if (n > 0) await seedVoters(seeder, network.topic, network, n);

    const shutdown = async (): Promise<void> => {
        try {
            await voter.stop();
            await seeder.stop();
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    // Single machine-parseable readiness line (the orchestrator greps for it), then park forever.
    process.stdout.write(`SEEDER_READY peerId=${seeder.peerId} port=${port} topic=${network.topic} n=${n}\n`);
    for (const addr of seeder.multiaddrs()) process.stderr.write(`[seeder] listening ${addr}\n`);
    await new Promise<never>(() => {});
}

void main().catch((err) => {
    process.stderr.write(`[seeder] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
});
