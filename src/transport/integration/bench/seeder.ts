import { PubsubVoter, type VoteNetwork } from "../../../client/voter.js";
import { encodeBundle } from "../../../crdt/codec.js";
import { encodeBundleMessage } from "../../messages.js";
import { makeHostNode, connectPeers, waitFor, delay, type HostNode } from "./host-node.js";
import { benchChains, benchManifest, benchCriteria, makeSigningContext, signRandomVoter } from "./signing.js";

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
 * Usage: `node dist/transport/integration/bench/seeder.js <N> <PORT>` (or env `BENCH_N`/`BENCH_PORT`).
 */

/** Voter ballots published per feeder peer — safely under the gate's 256/10s per-peer bundle window. */
const FEED_CHUNK = 240;

async function seedVoters(seeder: HostNode, topic: string, network: VoteNetwork, count: number): Promise<void> {
    const ctx = await makeSigningContext(benchCriteria());
    const feeders: HostNode[] = [];
    let published = 0;
    for (let offset = 0; offset < count; offset += FEED_CHUNK) {
        const chunk = Math.min(FEED_CHUNK, count - offset);
        const feeder = await makeHostNode({ host: "127.0.0.1" });
        feeders.push(feeder);
        feeder.subscribe(topic);
        await connectPeers(feeder, seeder, topic);
        for (let i = 0; i < chunk; i++) {
            const bundle = await signRandomVoter(ctx);
            await feeder.publish(topic, encodeBundleMessage(encodeBundle(bundle)));
            published++;
        }
        process.stderr.write(`[seeder] published ${published}/${count} voters via ${feeders.length} feeder(s)\n`);
    }

    // Wait for the seeder's own gate to verify + merge every published voter into its tally.
    const target = BigInt(count);
    await waitFor(
        async () => {
            const tally = await network.getTally();
            return (tally.ranking[0]?.weight ?? 0n) >= target;
        },
        120_000,
        `seeder to merge all ${count} voters`
    );
    // Feeders have done their job; drop them so only the seeder answers cold-join pulls.
    await Promise.all(feeders.map((f) => f.stop()));
    // Let the mesh settle after the feeders disconnect before we advertise readiness.
    await delay(500);
}

async function main(): Promise<void> {
    const n = Number(process.argv[2] ?? process.env.BENCH_N ?? "10");
    const port = Number(process.argv[3] ?? process.env.BENCH_PORT ?? "40001");
    if (!Number.isInteger(n) || n < 0) throw new Error(`bad N: ${process.argv[2]}`);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`bad PORT: ${process.argv[3]}`);

    const seeder = await makeHostNode({ port });
    const voter = new PubsubVoter({ helia: seeder.helia, chains: benchChains(), manifest: benchManifest() });
    await voter.start();
    const network = await voter.getContest({ contestId: "biz" });

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
