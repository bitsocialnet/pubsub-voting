import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PubsubVoter } from "../dist/client/voter.js";
import { encodeBundle } from "../dist/crdt/codec.js";
import { encodeBundleMessage } from "../dist/transport/messages.js";
import { makeStorage } from "../dist/storage/node.js";
import type { ChainClientFactory } from "../dist/chain/types.js";
import { makeHostNode, connectPeers, waitFor, delay } from "./host-node.js";
import { benchChains, benchCriteria, makeSigningContext, signRandomVoter } from "./signing.js";

/**
 * Warm-restart benchmark — the checkpoint-snapshot restore path (issue #14), all-local.
 *
 * Models the production incident: an always-on seeder holding `N` verified votes restarts while
 * NO other peer is online. Before snapshot persistence its tally came back empty (recovery
 * depended on some peer re-advertising within the heartbeat window); now `join()` reloads the
 * persisted snapshot through the chase's decode+verify path before any network activity.
 *
 * Two sessions per `N`, sharing one `dataPath`:
 *   1. SEED — a voter joins, is fed `N` real-signed bundles through the REAL forward gate
 *      (feeder nodes chunked under the per-peer rate window, exactly like the cold-join
 *      seeder — see seeder.ts, whose loop this compacts), waits until all `N` are verified,
 *      and shuts down cleanly (`stop()` flushes the debounced snapshot write).
 *   2. RESTART — a FRESH node + voter on the same `dataPath`, zero peers, zero providers.
 *      Timed: `update()` → tally showing all `N` (START→TALLY) and → every restored row
 *      `chainVerified` (START→VERIFIED, expected to ride the persisted gate-result cache —
 *      the `gateReads` column must be 0).
 *
 * No WAN host needed (nothing remote to measure — the whole point is that no peer is online).
 * Usage: `node benchmark/warm-restart.js [N ...]` after `npm run build && npm run build:bench`;
 * default sweep 1 100 1000.
 */

/** Voter ballots published per feeder peer — under the gate's 256/10s per-peer bundle window. */
const FEED_CHUNK = 240;

/** Wrap the bench's instant fake chain, counting gate reads (readContract calls). */
function countingChains(): { chains: ChainClientFactory; gateReads: () => number } {
    const inner = benchChains();
    let gateReads = 0;
    const chains: ChainClientFactory = (args) => {
        const client = inner(args);
        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "readContract") {
                    return (...callArgs: unknown[]) => {
                        gateReads += 1;
                        return (target.readContract as (...a: unknown[]) => unknown)(...callArgs);
                    };
                }
                return Reflect.get(target, prop, receiver);
            }
        });
    };
    return { chains, gateReads: () => gateReads };
}

async function seedSession(dataPath: string, n: number): Promise<{ topic: string; snapshotBytes: number }> {
    const node = await makeHostNode({ host: "127.0.0.1" });
    const voter = new PubsubVoter({ dataPath, helia: node.helia, chains: benchChains() });
    const contest = await voter.createContest({ criteria: benchCriteria() });
    await contest.update();

    const ctx = await makeSigningContext(benchCriteria());
    let published = 0;
    for (let offset = 0; offset < n; offset += FEED_CHUNK) {
        const chunk = Math.min(FEED_CHUNK, n - offset);
        const feeder = await makeHostNode({ host: "127.0.0.1" });
        feeder.subscribe(contest.topic);
        await connectPeers(feeder, node, contest.topic);
        for (let i = 0; i < chunk; i++) {
            const bundle = await signRandomVoter(ctx);
            await feeder.publish(contest.topic, encodeBundleMessage(encodeBundle(bundle)));
            published++;
        }
        const target = BigInt(published);
        await waitFor(
            async () => ((await contest.getTally()).ranking[0]?.weight ?? 0n) >= target,
            120_000,
            `seed session to merge ${published} voters`
        );
        await feeder.stop();
    }
    await waitFor(
        async () => {
            const row = (await contest.getTally()).ranking[0];
            return n === 0 || (row !== undefined && row.weight === BigInt(n) && row.chainVerified);
        },
        120_000,
        "seed session to verify all voters"
    );
    // Give the (already-settled) state a beat, then destroy: leave() flushes the snapshot write.
    await delay(100);
    const topic = contest.topic;
    await voter.destroy();
    await node.stop();

    const storage = makeStorage({ dataPath });
    const blob = await storage.openSnapshots().get(topic);
    await storage.destroy();
    if (blob === undefined) throw new Error("seed session persisted no snapshot");
    return { topic, snapshotBytes: blob.length };
}

interface RestartResult {
    tallyMs: number;
    verifiedMs: number;
    gateReads: number;
}

async function restartSession(dataPath: string, n: number): Promise<RestartResult> {
    const node = await makeHostNode({ host: "127.0.0.1" });
    const counted = countingChains();
    const voter = new PubsubVoter({ dataPath, helia: node.helia, chains: counted.chains });
    const contest = await voter.createContest({ criteria: benchCriteria() });

    const t0 = performance.now();
    await contest.update(); // join() restores the snapshot before the (peerless) cold-start pull
    await waitFor(async () => (contest.tally?.ranking[0]?.weight ?? 0n) === BigInt(n), 120_000, "restored tally");
    const tallyMs = performance.now() - t0;
    await waitFor(async () => contest.tally?.ranking[0]?.chainVerified === true, 120_000, "restored rows verified");
    const verifiedMs = performance.now() - t0;

    await voter.destroy();
    await node.stop();
    return { tallyMs, verifiedMs, gateReads: counted.gateReads() };
}

async function main(): Promise<void> {
    const ns = process.argv.slice(2).map(Number);
    const sweep = ns.length > 0 ? ns : [1, 100, 1000];
    for (const n of sweep) {
        if (!Number.isInteger(n) || n <= 0) throw new Error(`bad N: ${n}`);
        const dataPath = mkdtempSync(join(tmpdir(), "pubsub-voting-warm-restart-"));
        process.stderr.write(`[warm-restart] N=${n}: seeding…\n`);
        const { snapshotBytes } = await seedSession(dataPath, n);
        process.stderr.write(`[warm-restart] N=${n}: restarting…\n`);
        const result = await restartSession(dataPath, n);
        process.stdout.write(
            `WARM_RESTART n=${n} snapshotBytes=${snapshotBytes} ` +
                `startToTallyMs=${result.tallyMs.toFixed(0)} startToVerifiedMs=${result.verifiedMs.toFixed(0)} ` +
                `gateReads=${result.gateReads}\n`
        );
    }
}

void main()
    .catch((err) => {
        process.stderr.write(`[warm-restart] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        process.exitCode = 1;
    })
    .finally(() => {
        // libp2p keeps lingering handles occasionally; the bench is done once main returns.
        setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
    });
