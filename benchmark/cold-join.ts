import { PubsubVoter } from "../dist/client/voter.js";
import { TOPIC_PREFIX } from "../dist/topic.js";
import { makeHostNode, waitFor, type HostNode } from "./host-node.js";
import { startRouter, type RunningRouter } from "./router.js";
import { benchChains, benchManifest } from "./signing.js";

/**
 * Cold-join benchmark — COLD JOINER side (runs locally; discovers the remote seeder via an HTTP
 * content router, exactly like pkc-js — delegated Routing V1, no DHT).
 *
 * Flow, all inside `start()`:
 *   1. `#coldStart` asks the (local, ~1s-latency) HTTP router "who provides `<criteriaCid>`?";
 *   2. the router names the seeder at its **public multiaddr** (`<providerAddr>`), dialed directly
 *      over the real internet — no SSH tunnel, so the measured RTT is the true network path;
 *   3. the node dials it and **fetches the root record immediately** — no wait for gossipsub
 *      subscription gossip;
 *   4. the divergent root is chased over directed bitswap, verified, merged;
 *   5. `getTally()` returns the full ranking (the "which board to load" signal).
 *
 * Every expensive operation is timed: the router lookup (from the in-process router's request log),
 * the connect/identify, the fetch, each bitswap block pull, and verify+merge (the residual). The
 * network ops are timed by wrapping the injected `blockstore.get` + `fetch` seams (no production
 * changes); the router lookup shares this process's `performance.now()` clock.
 *
 * Usage: `node benchmark/cold-join.js <providerAddr> <seederPeerId> <topic> <N>`, after `npm run build:bench`.
 *   `<providerAddr>` is the seeder's full dialable multiaddr, e.g. `/ip4/1.2.3.4/tcp/41000/p2p/<id>`.
 * Env: `BENCH_ROUTER_LATENCY_MS` (default 1000).
 */

/** One timed operation on the cold-join path, in ms relative to the `start()` call (t0). */
export interface OpTiming {
    kind: "fetch" | "blockGet";
    label: string;
    startMs: number;
    durMs: number;
    bytes?: number;
}

export interface ColdJoinMilestones {
    n: number;
    /** `start()` call → it returns, ms (cold-start discovery+pull is fire-and-forget). */
    startReturnMs: number;
    /** The HTTP router lookup for the criteria CID: when it started (t0-relative) + its duration. */
    router: { startMs: number | null; durMs: number | null };
    /** `start()` call → libp2p reports the seeder connected, ms (null if the event was missed). */
    connectMs: number | null;
    /** `start()` call → identify completes for the seeder, ms (null if missed). */
    identifyMs: number | null;
    /** The cold-start root-record fetch(es): count + total ms + first start (t0-relative). */
    fetch: { count: number; totalMs: number; firstStartMs: number | null };
    /** The checkpoint block pulls over bitswap: count + total ms + slowest single pull + net count. */
    blockGets: { count: number; totalMs: number; maxMs: number; networkCount: number };
    /** `start()` call → the first `update` event (chase merged), ms; null if none fired. */
    firstUpdateMs: number | null;
    /** Residual verify+merge+decode time: tallyReady − (end of the last network op), ms. */
    verifyMergeMs: number | null;
    /** `start()` call → `getTally()` reflects all N voters (the UI-ready signal) — end-to-end, ms. */
    tallyReadyMs: number;
    /** Every timed network op, t0-relative, for a full waterfall if needed. */
    ops: OpTiming[];
}

export interface ColdJoinArgs {
    /** The seeder's full dialable multiaddr (includes `/p2p/<id>`), dialed directly over the WAN. */
    providerAddr: string;
    seederPeerId: string;
    topic: string;
    expectedN: number;
    /** Simulated HTTP-router latency (ms). Default 1000. */
    routerLatencyMs?: number;
    /** Overall ceiling for the whole join (ms); a hung join throws instead of hanging forever. */
    timeoutMs?: number;
}

/** The subset of a Helia blockstore we monkey-patch to time bitswap pulls. */
interface TimedBlockstore {
    get(cid: { toString(): string }, options?: unknown): AsyncIterable<Uint8Array> | Promise<Uint8Array>;
}
/** The subset of the libp2p fetch service we monkey-patch to time root-record pulls. */
interface TimedFetch {
    fetch(peer: unknown, key: string | Uint8Array, options?: unknown): Promise<Uint8Array | undefined | null>;
}

/** Drain an async-iterable block (Helia's `get`) into one buffer, or pass a Promise through. */
async function drainBlock(result: AsyncIterable<Uint8Array> | Promise<Uint8Array>): Promise<Uint8Array> {
    if (result instanceof Promise) return result;
    const chunks: Uint8Array[] = [];
    for await (const chunk of result) chunks.push(chunk);
    if (chunks.length === 1) return chunks[0]!;
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

/** Wrap `node`'s injected blockstore + fetch to record a timestamped event per operation. */
function instrument(node: HostNode): { events: Array<{ kind: OpTiming["kind"]; label: string; start: number; end: number; bytes?: number }> } {
    const events: Array<{ kind: OpTiming["kind"]; label: string; start: number; end: number; bytes?: number }> = [];

    const bs = node.helia.blockstore as unknown as TimedBlockstore;
    const rawGet = bs.get.bind(bs);
    bs.get = async (cid, options): Promise<Uint8Array> => {
        const start = performance.now();
        const bytes = await drainBlock(rawGet(cid, options));
        events.push({ kind: "blockGet", label: cid.toString(), start, end: performance.now(), bytes: bytes.length });
        return bytes;
    };

    const fetchSvc = node.libp2p.services.fetch as unknown as TimedFetch;
    const rawFetch = fetchSvc.fetch.bind(fetchSvc);
    fetchSvc.fetch = async (peer, key, options) => {
        const start = performance.now();
        const value = await rawFetch(peer, key, options);
        const label = typeof key === "string" ? key : new TextDecoder().decode(key);
        events.push({ kind: "fetch", label, start, end: performance.now() });
        return value;
    };

    return { events };
}

/** Run one cold join against a live seeder (discovered via a local HTTP router) and time each step. */
export async function measureColdJoin(args: ColdJoinArgs): Promise<ColdJoinMilestones> {
    const timeoutMs = args.timeoutMs ?? 60_000;
    const cidString = args.topic.slice(TOPIC_PREFIX.length);
    const providerAddr = args.providerAddr;

    // The local HTTP content router: names the seeder as the provider of the criteria CID, after a
    // realistic ~1s lookup latency. This is the ONLY way the cold node learns about the seeder.
    let router: RunningRouter | undefined;
    let node: HostNode | undefined;
    let voter: PubsubVoter | undefined;
    try {
        router = await startRouter({
            providers: new Map([[cidString, { id: args.seederPeerId, addrs: [providerAddr] }]]),
            latencyMs: args.routerLatencyMs ?? 1000
        });
        node = await makeHostNode({ host: "127.0.0.1", routerUrls: [router.url] });
        const { events } = instrument(node);
        voter = new PubsubVoter({ helia: node.helia, chains: benchChains(), manifest: benchManifest() });
        const network = await voter.getContest({ contestId: "biz" });
        if (network.topic !== args.topic) {
            throw new Error(`derived topic ${network.topic} != seeder topic ${args.topic} (criteria mismatch)`);
        }

        // Record when libp2p connects + identifies the seeder (both happen inside start(), after the
        // router names it).
        let connectAbs: number | null = null;
        let identifyAbs: number | null = null;
        node.libp2p.addEventListener("peer:connect", (evt) => {
            if (connectAbs === null && (evt as CustomEvent<{ toString(): string }>).detail?.toString() === args.seederPeerId) {
                connectAbs = performance.now();
            }
        });
        node.libp2p.addEventListener("peer:identify", (evt) => {
            if (identifyAbs === null && (evt as CustomEvent<{ peerId: { toString(): string } }>).detail?.peerId?.toString() === args.seederPeerId) {
                identifyAbs = performance.now();
            }
        });

        // t0: start() fires #coldStart → router lookup → dial → fetch → chase. Arm the update observer first.
        let firstUpdateAbs: number | null = null;
        const t0 = performance.now();
        network.on("update", () => {
            if (firstUpdateAbs === null) firstUpdateAbs = performance.now();
        });
        await network.start();
        const startReturnMs = performance.now() - t0;

        // Poll the tally until every seeded voter is pulled, verified, and merged.
        const target = BigInt(args.expectedN);
        await waitFor(
            async () => {
                const tally = await network.getTally();
                return (tally.ranking[0]?.weight ?? 0n) >= target;
            },
            timeoutMs,
            `tally to reflect all ${args.expectedN} voters`
        );
        const tallyReadyMs = performance.now() - t0;

        // --- assemble the per-operation breakdown (t0-relative) ---
        const ops: OpTiming[] = events
            .filter((e) => e.end >= t0)
            .map((e) => ({
                kind: e.kind,
                label: e.label,
                startMs: e.start - t0,
                durMs: e.end - e.start,
                ...(e.bytes !== undefined ? { bytes: e.bytes } : {})
            }));
        const fetchOps = ops.filter((o) => o.kind === "fetch");
        const blockOps = ops.filter((o) => o.kind === "blockGet");
        const networkBlocks = blockOps.filter((o) => o.durMs >= 5); // a real bitswap pull, not a local hit
        const routerReq = router.requests.find((r) => r.cid === cidString);
        const lastNetEndMs = [
            ...fetchOps.map((o) => o.startMs + o.durMs),
            ...networkBlocks.map((o) => o.startMs + o.durMs)
        ].reduce((max, x) => Math.max(max, x), 0);

        return {
            n: args.expectedN,
            startReturnMs,
            router: {
                startMs: routerReq ? routerReq.startMs - t0 : null,
                durMs: routerReq ? routerReq.endMs - routerReq.startMs : null
            },
            connectMs: connectAbs === null ? null : connectAbs - t0,
            identifyMs: identifyAbs === null ? null : identifyAbs - t0,
            fetch: {
                count: fetchOps.length,
                totalMs: fetchOps.reduce((s, o) => s + o.durMs, 0),
                firstStartMs: fetchOps.length ? Math.min(...fetchOps.map((o) => o.startMs)) : null
            },
            blockGets: {
                count: blockOps.length,
                totalMs: blockOps.reduce((s, o) => s + o.durMs, 0),
                maxMs: blockOps.reduce((m, o) => Math.max(m, o.durMs), 0),
                networkCount: networkBlocks.length
            },
            firstUpdateMs: firstUpdateAbs === null ? null : firstUpdateAbs - t0,
            verifyMergeMs: lastNetEndMs > 0 ? tallyReadyMs - lastNetEndMs : null,
            tallyReadyMs,
            ops
        };
    } finally {
        await voter?.stop().catch(() => {});
        await node?.stop().catch(() => {});
        await router?.stop().catch(() => {});
    }
}

async function main(): Promise<void> {
    const providerAddr = process.argv[2];
    const seederPeerId = process.argv[3];
    const topic = process.argv[4];
    const expectedN = Number(process.argv[5]);
    if (!providerAddr || !seederPeerId || !topic || !Number.isInteger(expectedN)) {
        throw new Error("usage: cold-join.js <providerAddr> <seederPeerId> <topic> <N>");
    }
    const routerLatencyMs = process.env.BENCH_ROUTER_LATENCY_MS ? Number(process.env.BENCH_ROUTER_LATENCY_MS) : 1000;
    const r = await measureColdJoin({ providerAddr, seederPeerId, topic, expectedN, routerLatencyMs });
    const s = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)}s`);
    process.stderr.write(
        `[cold-join] N=${r.n}\n` +
            `  discovery:   router-lookup=${s(r.router.durMs)} (@${s(r.router.startMs)}) connect=${s(r.connectMs)} identify=${s(r.identifyMs)}\n` +
            `  cold-start:  fetch=${s(r.fetch.totalMs)} (${r.fetch.count}x) ` +
            `bitswap=${s(r.blockGets.totalMs)} (${r.blockGets.networkCount} net/${r.blockGets.count} gets, max ${s(r.blockGets.maxMs)}) ` +
            `verify+merge=${s(r.verifyMergeMs)}\n` +
            `  total:       start->tally=${s(r.tallyReadyMs)}  (first-update ${s(r.firstUpdateMs)})\n`
    );
    process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("cold-join.js")) {
    void main().catch((err) => {
        process.stderr.write(`[cold-join] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    });
}
