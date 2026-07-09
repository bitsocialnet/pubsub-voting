import { PubsubVoter, type Contest } from "../dist/client/voter.js";
import { criteriaCid } from "../dist/topic.js";
import { makeHostNode, type HostNode } from "./host-node.js";
import { startRouter, type RouterProvider, type RunningRouter } from "./router.js";
import { benchChains, benchDirectoryCriteria } from "./signing.js";

/**
 * Directory-load benchmark — COLD JOINER side (runs locally).
 *
 * Models a 5chan.app cold load: a fresh peer with no data joins ALL `M` contest leaderboards at once,
 * every one provided by the SAME shared seeder (bitsocial-seeder), and waits until EVERY contest has
 * a usable tally. The point is to measure what amortizes across the shared seeder — the dial +
 * noise/yamux handshake is paid ONCE and all `M` root-record fetches + checkpoint bitswap pulls ride
 * that one reused connection (yamux-multiplexed) — versus what stays additive: the per-ballot EIP-712
 * signature recovery, summed across every voter in every contest.
 *
 * All `M` contests' `start()` calls fire concurrently, so discovery/fetch/bitswap overlap. Every
 * network op is timed by wrapping the injected `blockstore.get` + `fetch` seams (no production
 * changes); the residual to all-tallies-ready is verify+merge. Discovery is the pkc-js pattern: a
 * local HTTP content router (Delegated Routing V1, ~1 s lookup, paid once) that names the seeder as
 * the provider of every contest's criteria CID.
 *
 * Usage: `node benchmark/directory-join.js <providerAddr> <seederPeerId> <M> <N>`, after
 * `npm run build:bench`. `<providerAddr>` is the seeder's full dialable multiaddr.
 * Env: `BENCH_ROUTER_LATENCY_MS` (default 1000).
 */

export interface DirectoryJoinMilestones {
    m: number;
    n: number;
    /** `start()` (fired for all M concurrently) → the last one returns, ms. */
    startReturnMs: number;
    /** Distinct HTTP-router provider lookups served, and when the first one started (t0-relative). */
    router: { lookups: number; firstStartMs: number | null; firstDurMs: number | null };
    /** Connections opened to the shared seeder (the amortization signal — want 1 for M contests). */
    seederConnections: number;
    /** `start()` → the seeder is first reported connected / identified, ms (null if missed). */
    connectMs: number | null;
    identifyMs: number | null;
    /** Root-record fetches over libp2p fetch: count (≈ M) + total ms across all streams. */
    fetch: { count: number; totalMs: number };
    /** Checkpoint block pulls over bitswap: count + total ms + total bytes + net (non-local) count. */
    blockGets: { count: number; totalMs: number; bytes: number; networkCount: number };
    /** Residual verify+merge+decode time: allTalliesReady − (end of the last network op), ms. */
    verifyMergeMs: number | null;
    /** Did ALL M contests converge before the timeout? If false, `allTalliesReadyMs` is the timeout. */
    converged: boolean;
    /** How many of the M contests reached a full tally (== M when converged). */
    readyCount: number;
    /** t0-relative ms at which the k-th contest tally became ready (sorted) — the convergence curve. */
    readyAtMs: number[];
    /** `start()` → EVERY one of the M contests' tally reflects all N voters — end-to-end, ms. */
    allTalliesReadyMs: number;
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

interface OpEvent {
    kind: "fetch" | "blockGet";
    start: number;
    end: number;
    bytes?: number;
}

/** Wrap `node`'s injected blockstore + fetch to record a timestamped event per operation. */
function instrument(node: HostNode): { events: OpEvent[] } {
    const events: OpEvent[] = [];

    const bs = node.helia.blockstore as unknown as TimedBlockstore;
    const rawGet = bs.get.bind(bs);
    bs.get = async (cid, options): Promise<Uint8Array> => {
        const start = performance.now();
        const bytes = await drainBlock(rawGet(cid, options));
        events.push({ kind: "blockGet", start, end: performance.now(), bytes: bytes.length });
        return bytes;
    };

    const fetchSvc = node.libp2p.services.fetch as unknown as TimedFetch;
    const rawFetch = fetchSvc.fetch.bind(fetchSvc);
    fetchSvc.fetch = async (peer, key, options) => {
        const start = performance.now();
        const value = await rawFetch(peer, key, options);
        events.push({ kind: "fetch", start, end: performance.now() });
        return value;
    };

    return { events };
}

export interface DirectoryJoinArgs {
    providerAddr: string;
    seederPeerId: string;
    m: number;
    expectedN: number;
    routerLatencyMs?: number;
    timeoutMs?: number;
    /** Max cold-starts in flight at once (sliding window). Default M (naive all-at-once join). */
    startConcurrency?: number;
}

/** Run one cold directory load (M contests, shared seeder) and time what amortizes vs. what scales. */
export async function measureDirectoryJoin(args: DirectoryJoinArgs): Promise<DirectoryJoinMilestones> {
    const timeoutMs = args.timeoutMs ?? 120_000;
    const provider: RouterProvider = { id: args.seederPeerId, addrs: [args.providerAddr] };

    // Derive every contest's criteria CID up front (offline) so the router can name the shared seeder
    // as the provider of ALL M topics before the node exists.
    const criteria = benchDirectoryCriteria(args.m);
    const cids = await Promise.all(criteria.map((c) => criteriaCid(c)));
    const providers = new Map(cids.map((cid) => [cid.toString(), provider] as const));

    let router: RunningRouter | undefined;
    let node: HostNode | undefined;
    let voter: PubsubVoter | undefined;
    try {
        router = await startRouter({ providers, latencyMs: args.routerLatencyMs ?? 1000 });
        node = await makeHostNode({ host: "127.0.0.1", routerUrls: [router.url] });
        const { events } = instrument(node);
        voter = new PubsubVoter({ helia: node.helia, chains: benchChains() });

        const networks: Contest[] = await Promise.all(criteria.map((c) => voter!.createContest({ criteria: c })));

        // Count connections opened to the shared seeder — the amortization signal (want 1, not M).
        let seederConnections = 0;
        let connectAbs: number | null = null;
        let identifyAbs: number | null = null;
        node.libp2p.addEventListener("peer:connect", (evt) => {
            if ((evt as CustomEvent<{ toString(): string }>).detail?.toString() === args.seederPeerId) {
                seederConnections++;
                if (connectAbs === null) connectAbs = performance.now();
            }
        });
        node.libp2p.addEventListener("peer:identify", (evt) => {
            if (identifyAbs === null && (evt as CustomEvent<{ peerId: { toString(): string } }>).detail?.peerId?.toString() === args.seederPeerId) {
                identifyAbs = performance.now();
            }
        });

        // t0: fire cold-start for the M contests, but only keep `concurrency` cold-starts IN FLIGHT at
        // once (a sliding window). `concurrency = M` (default) is the naive all-at-once join; a smaller
        // window models 5chan.app joining boards in batches so it never trips the host node's
        // concurrent-stream ceiling (measured: naive M=63 hangs ~half its fetches — see RESULTS.md). A
        // contest leaves the window when its tally is ready, admitting the next.
        const concurrency = Math.max(1, Math.min(args.startConcurrency ?? args.m, args.m));
        const target = BigInt(args.expectedN);
        const readyAtMs: number[] = [];
        const ready = new Array<boolean>(networks.length).fill(false);
        const started = new Array<boolean>(networks.length).fill(false);
        const t0 = performance.now();
        // Admit up to `concurrency` un-started contests into the window (fire-and-forget cold-start).
        const pump = (): void => {
            let inFlight = 0;
            for (let i = 0; i < networks.length; i++) if (started[i] && !ready[i]) inFlight++;
            for (let i = 0; i < networks.length && inFlight < concurrency; i++) {
                if (!started[i]) {
                    started[i] = true;
                    inFlight++;
                    void networks[i]!.update();
                }
            }
        };
        pump();
        const startReturnMs = performance.now() - t0;

        // Poll until EVERY contest's tally reflects all N voters (the whole directory is UI-ready), OR
        // we hit the timeout. Instead of throwing on timeout, record the convergence curve — when the
        // k-th contest became ready — so a non-converging directory shows HOW MANY boards made it and
        // where it stalled, not just "timed out". This is the diagnostic the M=63 cliff needs.
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            const tallies = await Promise.all(networks.map((net, i) => (ready[i] ? null : net.getTally())));
            const now = performance.now();
            for (let i = 0; i < networks.length; i++) {
                if (!ready[i] && (tallies[i]!.ranking[0]?.weight ?? 0n) >= target) {
                    ready[i] = true;
                    readyAtMs.push(now - t0);
                }
            }
            pump(); // a freed slot admits the next batch
            if (readyAtMs.length === networks.length) break;
            if (now >= deadline) {
                process.stderr.write(`[dir-join] TIMEOUT: ${readyAtMs.length}/${networks.length} contests converged in ${(timeoutMs / 1000).toFixed(0)}s (concurrency=${concurrency})\n`);
                break;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        readyAtMs.sort((a, b) => a - b);
        const converged = readyAtMs.length === networks.length;
        const allTalliesReadyMs = converged ? readyAtMs[readyAtMs.length - 1]! : performance.now() - t0;

        // --- assemble the aggregate breakdown (t0-relative) ---
        const ops = events.filter((e) => e.end >= t0);
        const fetchOps = ops.filter((o) => o.kind === "fetch");
        const blockOps = ops.filter((o) => o.kind === "blockGet");
        const networkBlocks = blockOps.filter((o) => o.end - o.start >= 5); // a real bitswap pull, not a local hit
        const lastNetEndMs = [...fetchOps, ...networkBlocks].reduce((max, o) => Math.max(max, o.end - t0), 0);
        const routerReqs = router.requests.filter((r) => providers.has(r.cid));
        const firstRouter = routerReqs.reduce<typeof routerReqs[number] | null>((a, r) => (a === null || r.startMs < a.startMs ? r : a), null);

        return {
            m: args.m,
            n: args.expectedN,
            startReturnMs,
            router: {
                lookups: routerReqs.length,
                firstStartMs: firstRouter ? firstRouter.startMs - t0 : null,
                firstDurMs: firstRouter ? firstRouter.endMs - firstRouter.startMs : null
            },
            seederConnections,
            connectMs: connectAbs === null ? null : connectAbs - t0,
            identifyMs: identifyAbs === null ? null : identifyAbs - t0,
            fetch: { count: fetchOps.length, totalMs: fetchOps.reduce((s, o) => s + (o.end - o.start), 0) },
            blockGets: {
                count: blockOps.length,
                totalMs: blockOps.reduce((s, o) => s + (o.end - o.start), 0),
                bytes: blockOps.reduce((s, o) => s + (o.bytes ?? 0), 0),
                networkCount: networkBlocks.length
            },
            verifyMergeMs: lastNetEndMs > 0 ? allTalliesReadyMs - lastNetEndMs : null,
            converged,
            readyCount: readyAtMs.length,
            readyAtMs,
            allTalliesReadyMs
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
    const m = Number(process.argv[4]);
    const expectedN = Number(process.argv[5]);
    if (!providerAddr || !seederPeerId || !Number.isInteger(m) || !Number.isInteger(expectedN)) {
        throw new Error("usage: directory-join.js <providerAddr> <seederPeerId> <M> <N>");
    }
    const routerLatencyMs = process.env.BENCH_ROUTER_LATENCY_MS ? Number(process.env.BENCH_ROUTER_LATENCY_MS) : 1000;
    const timeoutMs = process.env.BENCH_JOIN_TIMEOUT_MS ? Number(process.env.BENCH_JOIN_TIMEOUT_MS) : undefined;
    const startConcurrency = process.env.BENCH_JOIN_CONCURRENCY ? Number(process.env.BENCH_JOIN_CONCURRENCY) : undefined;
    const r = await measureDirectoryJoin({
        providerAddr,
        seederPeerId,
        m,
        expectedN,
        routerLatencyMs,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(startConcurrency !== undefined ? { startConcurrency } : {})
    });
    const s = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)}s`);
    process.stderr.write(
        `[dir-join] M=${r.m} N=${r.n} (${r.m * r.n} total voters)\n` +
            `  discovery:   router-lookups=${r.router.lookups} (first ${s(r.router.firstDurMs)}) ` +
            `connect=${s(r.connectMs)} identify=${s(r.identifyMs)} seeder-conns=${r.seederConnections}\n` +
            `  cold-start:  fetch=${s(r.fetch.totalMs)} (${r.fetch.count}x) ` +
            `bitswap=${s(r.blockGets.totalMs)} (${r.blockGets.networkCount} net/${r.blockGets.count} gets, ${(r.blockGets.bytes / 1024).toFixed(0)} KiB) ` +
            `verify+merge=${s(r.verifyMergeMs)}\n` +
            `  converge:    ${r.readyCount}/${r.m} ready` +
            (r.readyAtMs.length ? ` (p50=${s(r.readyAtMs[Math.floor(r.readyAtMs.length / 2)] ?? null)} p90=${s(r.readyAtMs[Math.floor(r.readyAtMs.length * 0.9)] ?? null)} last=${s(r.readyAtMs[r.readyAtMs.length - 1] ?? null)})` : "") +
            `\n` +
            `  total:       start->all-tallies=${s(r.allTalliesReadyMs)}${r.converged ? "" : " (TIMEOUT — not all converged)"}\n`
    );
    process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("directory-join.js")) {
    void main().catch((err) => {
        process.stderr.write(`[dir-join] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    });
}
