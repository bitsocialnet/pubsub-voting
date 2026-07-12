import { PubsubVoter, type Contest } from "../dist/client/voter.js";
import { encodeBundle } from "../dist/crdt/codec.js";
import { encodeBundleMessage } from "../dist/transport/messages.js";
import { makeHostNode, connectPeers, waitFor, delay, type HostNode } from "./host-node.js";
import {
    benchChains,
    benchDirectoryCriteria,
    makeSigningContext,
    signRandomVoter,
    type SigningContext
} from "./signing.js";

/**
 * Directory-load benchmark — SEEDER side (runs on the remote WAN host).
 *
 * The cold-join seeder ({@link ./seeder.ts}) serves ONE contest. This one models a 5chan-style
 * directory: a SINGLE shared node (one libp2p peer id, one dialable address) that provides `M`
 * contest topics at once, each seeded with `N` real-signed voters. A cold joiner then loads the
 * whole directory over ONE reused connection — which is exactly the amortization the shared
 * bitsocial-seeder gives 5chan.app. See {@link ./directory-join.ts}.
 *
 * It stands up one node, builds a `PubsubVoter` over `M` synthetic criteria documents
 * (`benchDirectoryCriteria`), seeds every contest through the REAL forward gate, waits until every
 * contest's tally reflects all `N`, then prints a single `SEEDER_READY …` line and parks. Killed
 * with SIGINT/SIGTERM between sweep points.
 *
 * Usage: `node benchmark/directory-seeder.js <M> <N> <PORT>` (or env `BENCH_M`/`BENCH_N`/`BENCH_PORT`),
 * after `npm run build:bench`.
 */

/** Voter ballots published per feeder peer — safely under the gate's 256/10s per-peer bundle window. */
const FEED_CHUNK = 240;
/**
 * How many contests to seed concurrently (each spins its own loopback feeders). Tunable via
 * `BENCH_SEED_CONCURRENCY` — lower it for large `N`, where each contest holds `ceil(N/240)` feeder
 * nodes at once, to bound the seeder's peak memory.
 */
const SEED_CONCURRENCY = Number(process.env.BENCH_SEED_CONCURRENCY ?? "8");

/** Dial + mesh-form a feeder against the seeder, retrying — the seeder's event loop is periodically
 * blocked verifying published bundles (synchronous secp256k1), which can time out a concurrent dial;
 * a bounded retry rides that out so a large seed does not crash mid-way. */
async function connectFeeder(feeder: HostNode, seeder: HostNode, topic: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await connectPeers(feeder, seeder, topic);
            return;
        } catch (error) {
            lastError = error;
            await delay(1000 * (attempt + 1));
        }
    }
    throw lastError;
}

/**
 * Seed one contest with `count` real-signed voters through the real gate. One feeder per chunk,
 * DRAINED before the next: the seeder verifies each bundle synchronously (secp256k1 blocks the event
 * loop), so if feeders keep arriving while a verify backlog drains, the next feeder's gossipsub mesh
 * formation starves and times out. Publishing a chunk, waiting for the seeder to catch up, then
 * dropping the feeder keeps the event loop free when each new feeder meshes.
 */
async function seedContest(seeder: HostNode, topic: string, network: Contest, ctx: SigningContext, count: number): Promise<void> {
    let published = 0;
    for (let offset = 0; offset < count; offset += FEED_CHUNK) {
        const chunk = Math.min(FEED_CHUNK, count - offset);
        const feeder = await makeHostNode({ host: "127.0.0.1" });
        feeder.subscribe(topic);
        await connectFeeder(feeder, seeder, topic);
        for (let i = 0; i < chunk; i++) {
            const bundle = await signRandomVoter(ctx);
            await feeder.publish(topic, encodeBundleMessage(encodeBundle(bundle)));
            published += 1;
        }
        const target = BigInt(published);
        await waitFor(
            async () => ((await network.getTally()).ranking[0]?.weight ?? 0n) >= target,
            120_000,
            `seeder to merge ${published} voters for ${topic}`
        );
        await feeder.stop();
    }
}

/** Run `fn` over `items` with at most `limit` in flight; reject on the first failure. */
async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            await fn(items[i]!, i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function main(): Promise<void> {
    const m = Number(process.argv[2] ?? process.env.BENCH_M ?? "10");
    const n = Number(process.argv[3] ?? process.env.BENCH_N ?? "10");
    const port = Number(process.argv[4] ?? process.env.BENCH_PORT ?? "40001");
    if (!Number.isInteger(m) || m < 1) throw new Error(`bad M: ${process.argv[2]}`);
    if (!Number.isInteger(n) || n < 0) throw new Error(`bad N: ${process.argv[3]}`);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`bad PORT: ${process.argv[4]}`);

    // Optionally raise the fetch service's concurrent-inbound-stream cap on the seeder (libp2p
    // defaults to 32), to test whether that alone lets a naive all-at-once directory join converge.
    const fetchMaxStreams = process.env.BENCH_FETCH_MAX_STREAMS ? Number(process.env.BENCH_FETCH_MAX_STREAMS) : undefined;
    const seeder = await makeHostNode({ port, ...(fetchMaxStreams !== undefined ? { fetchMaxStreams } : {}) });
    const voter = new PubsubVoter({ dataPath: false, helia: seeder.helia, chains: benchChains() });

    // Build each contest's criteria (for its signing context) in the SAME order the joiner will.
    const criteria = benchDirectoryCriteria(m);
    const contests = await Promise.all(
        criteria.map(async (c) => {
            const network = await voter.createContest({ criteria: c });
            await network.update(); // join + serve: installs the gate and registers the fetch responder
            const ctx = await makeSigningContext(c);
            return { network, ctx };
        })
    );

    let seeded = 0;
    if (n > 0) {
        await runPool(contests, SEED_CONCURRENCY, async ({ network, ctx }) => {
            await seedContest(seeder, network.topic, network, ctx, n);
            process.stderr.write(`[dir-seeder] seeded ${++seeded}/${m} contests (${n} voters each)\n`);
        });
    }
    // Let the mesh settle after the feeders disconnect before we advertise readiness.
    await delay(500);

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
    // The joiner derives the M topics itself from the same synthetic criteria, so only M/N travel here.
    process.stdout.write(`SEEDER_READY peerId=${seeder.peerId} port=${port} m=${m} n=${n}\n`);
    for (const addr of seeder.multiaddrs()) process.stderr.write(`[dir-seeder] listening ${addr}\n`);
    await new Promise<never>(() => {});
}

void main().catch((err) => {
    process.stderr.write(`[dir-seeder] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
});
