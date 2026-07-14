import { PubsubVoter } from "../dist/client/voter.js";
import { TOPIC_PREFIX } from "../dist/topic.js";
import { makeHostNode, waitFor, type HostNode } from "./host-node.js";
import { startRouter, type RunningRouter } from "./router.js";
import { formatRpcByOp, startRpcGateway, summarizeRpc, type GateRpcSummary, type GatewayRequest, type RunningGateway } from "./rpc-gateway.js";
import { benchCriteria, benchGatewayChains, benchRpcUrl, benchRules, realJoinerChains } from "./signing.js";

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
 * The joiner's chain client is a REAL default-config viem client against the local mock ETH
 * gateway (rpc-gateway.ts), each RPC round trip charged `BENCH_RPC_LATENCY_MS` — so the deferred
 * gate reads (batched into multicalls by the background verifier) are measured, not free. With
 * `BENCH_RPC_URL` set (REAL-CHAIN mode) the same client instead hits the real Base-mainnet
 * endpoint — real head, real bucket sample block, real multicall3, measured (not simulated)
 * RPC latency; see signing.ts. Two total milestones come out: `start->tally` (render-ready,
 * rows possibly `chainVerified: false`) and `start->verified` (every deferred gate read landed).
 *
 * Usage: `node benchmark/cold-join.js <providerAddr> <seederPeerId> <topic> <N>`, after `npm run build:bench`.
 *   `<providerAddr>` is the seeder's full dialable multiaddr, e.g. `/ip4/1.2.3.4/tcp/41000/p2p/<id>`.
 * Env: `BENCH_ROUTER_LATENCY_MS` (default 1000), `BENCH_RPC_LATENCY_MS` (default 270, mock mode),
 *      `BENCH_RPC_URL` (real Base RPC — switches to REAL-CHAIN mode).
 */

/** One timed operation on the cold-join path, in ms relative to the `start()` call (t0). */
export interface OpTiming {
    kind: "fetch" | "blockGet";
    label: string;
    startMs: number;
    durMs: number;
    bytes?: number;
    /**
     * Fetch sub-phase (fetch ops only): the `connection.newStream` multistream-select
     * negotiation, in ms. The remainder of `durMs` is openConnection (≈0 on a reused
     * connection) + the request write→response read. Isolates whether the mss-negotiate RTT
     * or the actual request RTT dominates the fetch (see the fetch-latency memory).
     */
    negotiateMs?: number;
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
    /**
     * Fetch sub-phase split (summed across fetch ops): the multistream-select negotiate time vs
     * the remainder (openConnection + request write→response read). Confirms which RTT dominates
     * the root-record fetch before any production change.
     */
    fetchPhases: { negotiateMs: number | null; writeReadMs: number | null };
    /** The checkpoint block pulls over bitswap: count + total ms + slowest single pull + net count. */
    blockGets: { count: number; totalMs: number; maxMs: number; networkCount: number };
    /** `start()` call → the first `update` event (chase merged), ms; null if none fired. */
    firstUpdateMs: number | null;
    /** Residual verify+merge+decode time: tallyReady − (end of the last network op), ms. */
    verifyMergeMs: number | null;
    /**
     * `start()` call → `getTally()` reflects all N voters (the UI-ready signal) — end-to-end, ms.
     * Provisional: the row may still be `chainVerified: false` here (the batched background gate
     * reads land after render — see DESIGN.md "Background chain verification").
     */
    tallyReadyMs: number;
    /**
     * `start()` call → the ranking row reads `chainVerified: true` (every gate read landed), ms.
     * `null` when verification did not settle within the join timeout — the tally milestone above
     * still stands (production renders with pending rows), and `gateRpc` then shows the traffic
     * (retries, errors) of the stalled verification.
     */
    verifiedTallyMs: number | null;
    /**
     * Gate-read RPC traffic against the ETH endpoint (t0-relative requests only): HTTP round
     * trips paid, split by the library operation that caused each (`byOp` — head reads,
     * tie-break block reads, batched vs direct gate reads; see rpc-gateway.ts `GatewayOp`),
     * plus the inner reads the multicalls carried and any error/retry traffic. This is the
     * column that makes the one-read-per-wallet cliff (or the batched fix) visible. `latencyMs`
     * is the mock gateway's fixed charge, or the measured median round trip in REAL-CHAIN mode.
     */
    gateRpc: GateRpcSummary;
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
    /** Simulated ETH-gateway latency per RPC round trip (ms). Default 270 (the bench WAN's RTT). */
    rpcLatencyMs?: number;
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

/** A live connection whose `newStream` we can wrap to time the mss-negotiate sub-phase. */
interface TimedConnection {
    newStream(protocol: string, options?: unknown): Promise<unknown>;
}

/** Wrap `node`'s injected blockstore + fetch to record a timestamped event per operation. */
function instrument(node: HostNode): { events: Array<{ kind: OpTiming["kind"]; label: string; start: number; end: number; bytes?: number; negotiateMs?: number }> } {
    const events: Array<{ kind: OpTiming["kind"]; label: string; start: number; end: number; bytes?: number; negotiateMs?: number }> = [];

    const bs = node.helia.blockstore as unknown as TimedBlockstore;
    const rawGet = bs.get.bind(bs);
    bs.get = async (cid, options): Promise<Uint8Array> => {
        const start = performance.now();
        const bytes = await drainBlock(rawGet(cid, options));
        events.push({ kind: "blockGet", label: cid.toString(), start, end: performance.now(), bytes: bytes.length });
        return bytes;
    };

    const libp2p = node.libp2p as unknown as { getConnections?(peer: unknown): TimedConnection[] };
    const fetchSvc = node.libp2p.services.fetch as unknown as TimedFetch;
    const rawFetch = fetchSvc.fetch.bind(fetchSvc);
    fetchSvc.fetch = async (peer, key, options) => {
        const start = performance.now();
        // Isolate the mss-negotiate RTT: wrap `newStream` on the connection(s) already open to this
        // peer (cold-start dials the provider before fetching, so the connection is reused and
        // openConnection ≈ 0). The remainder of the fetch is the request write→response read.
        let negotiateMs: number | undefined;
        const restores: Array<() => void> = [];
        for (const conn of libp2p.getConnections?.(peer) ?? []) {
            const rawNewStream = conn.newStream.bind(conn);
            restores.push(() => {
                conn.newStream = rawNewStream;
            });
            conn.newStream = async (protocol: string, opts?: unknown): Promise<unknown> => {
                const ns = performance.now();
                const stream = await rawNewStream(protocol, opts);
                if (negotiateMs === undefined) negotiateMs = performance.now() - ns;
                return stream;
            };
        }
        try {
            const value = await rawFetch(peer, key, options);
            const label = typeof key === "string" ? key : new TextDecoder().decode(key);
            events.push({ kind: "fetch", label, start, end: performance.now(), ...(negotiateMs !== undefined ? { negotiateMs } : {}) });
            return value;
        } finally {
            for (const restore of restores) restore();
        }
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
    let gateway: RunningGateway | undefined;
    let node: HostNode | undefined;
    let voter: PubsubVoter | undefined;
    try {
        router = await startRouter({
            providers: new Map([[cidString, { id: args.seederPeerId, addrs: [providerAddr] }]]),
            latencyMs: args.routerLatencyMs ?? 1000
        });
        // The joiner's chain client, per mode. Mock (default): a REAL default-config viem client
        // against the mock ETH gateway, each HTTP round trip charged `rpcLatencyMs` — so the
        // background verifier's batched (or unbatched) chain reads cost what they would against
        // a public endpoint (see rpc-gateway.ts). REAL-CHAIN (`BENCH_RPC_URL` set): the same
        // client shape against the real Base-mainnet endpoint — real head, real bucket sample
        // block, real multicall3 — instrumented to log every JSON-RPC request; the probe rule
        // registry keeps the reads real while admitting the bench's empty wallets (signing.ts).
        const rpcUrl = benchRpcUrl();
        const realRpcLog: GatewayRequest[] = [];
        if (!rpcUrl) gateway = await startRpcGateway({ latencyMs: args.rpcLatencyMs ?? 270 });
        node = await makeHostNode({ host: "127.0.0.1", routerUrls: [router.url] });
        const { events } = instrument(node);
        const rules = benchRules();
        voter = new PubsubVoter({
            dataPath: false,
            helia: node.helia,
            chains: rpcUrl ? realJoinerChains(rpcUrl, realRpcLog) : benchGatewayChains(gateway!.url),
            ...(rules ? { rules } : {})
        });
        const network = await voter.createContest({ criteria: benchCriteria() });
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

        // t0: update() fires #coldStart → router lookup → dial → fetch → chase. update() emits one
        // initial (empty) tally event before returning, so arm the "first merge" observer AFTER it
        // returns — cold-start merges land asynchronously well after, over the WAN.
        let firstUpdateAbs: number | null = null;
        const t0 = performance.now();
        await network.update();
        const startReturnMs = performance.now() - t0;
        network.on("update", () => {
            if (firstUpdateAbs === null) firstUpdateAbs = performance.now();
        });

        // Poll the tally until every seeded voter is pulled, offline-verified, and merged — the
        // render-ready milestone. The row is typically still `chainVerified: false` here: the
        // chase admits on the offline checks and defers the gate reads.
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

        // Then until the background verifier settles every deferred gate read (batched into
        // multicalls) and the row flips `chainVerified: true` — the trust-ready milestone. A
        // timeout here does NOT void the rep: the render milestone stands (production renders
        // with pending rows), the rep reports `verifiedTallyMs: null`, and the gateRpc summary
        // still shows the stalled verification's traffic (retries, rate-limit errors).
        let verifiedTallyMs: number | null = null;
        try {
            await waitFor(
                async () => {
                    const tally = await network.getTally();
                    return (tally.ranking[0]?.weight ?? 0n) >= target && tally.ranking[0]!.chainVerified;
                },
                timeoutMs,
                `all ${args.expectedN} voters to chain-verify`
            );
            verifiedTallyMs = performance.now() - t0;
        } catch (err) {
            process.stderr.write(`[cold-join] verified milestone NOT reached: ${err instanceof Error ? err.message : String(err)}\n`);
        }

        // Gate-read RPC traffic paid during the join (requests arriving after t0), split per
        // operation. In REAL-CHAIN mode `latencyMs` is the MEASURED median request→response
        // duration instead of the mock gateway's fixed charge.
        const gateRpc = summarizeRpc(rpcUrl ? realRpcLog : gateway!.requests, t0, rpcUrl ? undefined : args.rpcLatencyMs ?? 270);

        // --- assemble the per-operation breakdown (t0-relative) ---
        const ops: OpTiming[] = events
            .filter((e) => e.end >= t0)
            .map((e) => ({
                kind: e.kind,
                label: e.label,
                startMs: e.start - t0,
                durMs: e.end - e.start,
                ...(e.bytes !== undefined ? { bytes: e.bytes } : {}),
                ...(e.negotiateMs !== undefined ? { negotiateMs: e.negotiateMs } : {})
            }));
        const fetchOps = ops.filter((o) => o.kind === "fetch");
        const negotiateOps = fetchOps.filter((o) => o.negotiateMs !== undefined);
        const negotiateMs = negotiateOps.length ? negotiateOps.reduce((s, o) => s + (o.negotiateMs ?? 0), 0) : null;
        const fetchTotalMs = fetchOps.reduce((s, o) => s + o.durMs, 0);
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
                totalMs: fetchTotalMs,
                firstStartMs: fetchOps.length ? Math.min(...fetchOps.map((o) => o.startMs)) : null
            },
            fetchPhases: {
                negotiateMs,
                writeReadMs: negotiateMs === null ? null : fetchTotalMs - negotiateMs
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
            verifiedTallyMs,
            gateRpc,
            ops
        };
    } finally {
        await voter?.stop().catch(() => {});
        await node?.stop().catch(() => {});
        await gateway?.stop().catch(() => {});
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
    const rpcLatencyMs = process.env.BENCH_RPC_LATENCY_MS ? Number(process.env.BENCH_RPC_LATENCY_MS) : 270;
    const timeoutMs = process.env.BENCH_JOIN_TIMEOUT_MS ? Number(process.env.BENCH_JOIN_TIMEOUT_MS) : undefined;
    const r = await measureColdJoin({
        providerAddr,
        seederPeerId,
        topic,
        expectedN,
        routerLatencyMs,
        rpcLatencyMs,
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
    });
    const s = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)}s`);
    process.stderr.write(
        `[cold-join] N=${r.n}\n` +
            `  discovery:   router-lookup=${s(r.router.durMs)} (@${s(r.router.startMs)}) connect=${s(r.connectMs)} identify=${s(r.identifyMs)}\n` +
            `  cold-start:  fetch=${s(r.fetch.totalMs)} (${r.fetch.count}x, negotiate=${s(r.fetchPhases.negotiateMs)} write→read=${s(r.fetchPhases.writeReadMs)}) ` +
            `bitswap=${s(r.blockGets.totalMs)} (${r.blockGets.networkCount} net/${r.blockGets.count} gets, max ${s(r.blockGets.maxMs)}) ` +
            `verify+merge=${s(r.verifyMergeMs)}\n` +
            `  gate rpc:    ${r.gateRpc.requests} round trips @${r.gateRpc.latencyMs}ms — ${formatRpcByOp(r.gateRpc)}\n` +
            `  total:       start->tally=${s(r.tallyReadyMs)}  start->verified=${s(r.verifiedTallyMs)}  (first-update ${s(r.firstUpdateMs)})\n`
    );
    process.stdout.write(`RESULT ${JSON.stringify(r)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("cold-join.js")) {
    void main().catch((err) => {
        process.stderr.write(`[cold-join] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    });
}
