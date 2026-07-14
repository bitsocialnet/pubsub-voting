#!/usr/bin/env node
// Cold-join latency benchmark — ORCHESTRATOR.
//
// Drives a real cross-machine sweep: a SEEDER runs on a remote WAN host (`ssh <host>`), a fresh COLD
// JOINER runs locally and dials the seeder **directly at its public multiaddr over the real
// internet** (no SSH tunnel — a TCP-over-TCP tunnel inflates per-RTT latency and hides the true path).
// SSH is used only to launch the remote seeder process and read its readiness line. For each N it
// seeds N real-signed winners on the remote, then times how long a cold local peer takes to reach a
// full tally — the "which board to load" signal. Prints a median-of-repeats table.
//
// Reachability: the seeder listens on 0.0.0.0:<port> on the remote, so that port must be dialable
// from this machine (a public IP with the port open — no inbound firewall rule blocking it). The
// cold joiner only dials out, so it may sit behind NAT.
//
// Env:
//   BENCH_HOST=<ssh-host>        remote ssh host to run the seeder on (REQUIRED)
//   BENCH_HOST_IP=<ip-or-dns>    public IP/DNS the joiner dials the seeder at
//                                (default: the `hostname` from `ssh -G $BENCH_HOST`)
//   BENCH_REMOTE_DIR=~/pubsub-votes-bench   remote checkout dir
//   BENCH_NS=1,5,10,100,1000     voter counts to sweep
//   BENCH_REPEATS=3              cold joins per N (median reported)
//   BENCH_ROUTER_LATENCY_MS=1000 simulated HTTP-router lookup latency (paid once)
//   BENCH_RPC_LATENCY_MS=270     simulated ETH-gateway latency per RPC round trip (rpc-gateway.ts)
//   BENCH_RPC_URL=<url>          REAL-CHAIN mode: a real Base-mainnet JSON-RPC endpoint (must serve
//                                historical state ~43k blocks back, e.g. https://mainnet.base.org).
//                                The joiner's gate reads hit it for real (measured, not simulated
//                                latency); the seeder signs at the real bucket sample block. See
//                                signing.ts "REAL-CHAIN MODE".
//   BENCH_SKIP_SYNC=1            skip rsync+remote build (reuse an already-synced remote)
//   BENCH_SKIP_BUILD=1           skip the local `npm run build`
//
// Usage: BENCH_HOST=<ssh-host> npm run bench:cold-join

import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST = process.env.BENCH_HOST;
if (!HOST) throw new Error("set BENCH_HOST to the ssh host that runs the seeder (e.g. BENCH_HOST=my-server npm run bench:cold-join)");
const REMOTE_DIR = process.env.BENCH_REMOTE_DIR ?? "~/pubsub-votes-bench";
const NS = (process.env.BENCH_NS ?? "1,5,10,100,1000").split(",").map((s) => Number(s.trim()));
const REPEATS = Number(process.env.BENCH_REPEATS ?? "3");
const BASE_PORT = 41000;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLD_JOIN_JS = path.join(REPO, "benchmark/cold-join.js");

// REAL-CHAIN mode: the same URL must reach BOTH sides — the local joiner inherits it from this
// process's env; the remote seeder gets it prefixed onto its ssh command (validated so the
// interpolation cannot smuggle shell metacharacters onto the remote).
const RPC_URL = process.env.BENCH_RPC_URL;
if (RPC_URL && !/^https?:\/\/[A-Za-z0-9._\-:/]+$/.test(RPC_URL)) throw new Error(`unsafe BENCH_RPC_URL: ${RPC_URL}`);
const SEEDER_ENV = RPC_URL ? `BENCH_RPC_URL='${RPC_URL}' ` : "";

// The public IP/DNS the cold joiner dials the seeder at (resolved once in main()).
let DIAL_HOST;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    if (s.length === 0) return null; // e.g. every rep's verified milestone timed out
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const s = (ms) => (ms == null ? "  n/a " : `${(ms / 1000).toFixed(2)}s`.padStart(6));

/** Run a command to completion, returning {code, stdout, stderr}. */
function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { ...opts });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => (stdout += d));
        child.stderr?.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
}

/** Spawn a long-lived child; resolve once a stdout/stderr line matches `ready`, keeping it alive. */
function spawnUntil(cmd, args, ready, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
        let buf = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${label}: timed out after ${timeoutMs}ms (no ready line)`));
        }, timeoutMs);
        const onData = (d) => {
            buf += d;
            const m = buf.match(ready);
            if (m) {
                clearTimeout(timer);
                resolve({ child, match: m });
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`${label}: exited early (code ${code})\n${buf}`));
        });
    });
}

/** Wait until `host:port` accepts a TCP connection (the seeder is dialable over the real link). */
async function waitPort(host, port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ok = await new Promise((res) => {
            const sock = net.connect({ host, port }, () => {
                sock.destroy();
                res(true);
            });
            sock.on("error", () => res(false));
            sock.setTimeout(5000, () => {
                sock.destroy();
                res(false);
            });
        });
        if (ok) return;
        if (Date.now() > deadline) throw new Error(`${host}:${port} not dialable after ${timeoutMs}ms (firewall? wrong BENCH_HOST_IP?)`);
        await sleep(200);
    }
}

/**
 * The public IP/DNS the cold joiner should dial the seeder at: `BENCH_HOST_IP` if set, else the
 * resolved `hostname` from `ssh -G $BENCH_HOST` (the address SSH itself connects to — normally the
 * host's public IP). This is the data path now, so it must be directly reachable, not a tunnel.
 */
async function resolveDialHost() {
    if (process.env.BENCH_HOST_IP) return process.env.BENCH_HOST_IP;
    const g = await run("ssh", ["-G", HOST]);
    const line = g.stdout.split("\n").find((l) => l.startsWith("hostname "));
    const hostname = line?.slice("hostname ".length).trim();
    if (!hostname) throw new Error(`could not resolve a dial host from \`ssh -G ${HOST}\`; set BENCH_HOST_IP explicitly`);
    return hostname;
}

/** Build the seeder's dialable multiaddr from the resolved dial host (IPv4 literal → /ip4, else /dns4). */
function providerMultiaddr(dialHost, port, peerId) {
    const proto = /^\d{1,3}(\.\d{1,3}){3}$/.test(dialHost) ? "ip4" : "dns4";
    return `/${proto}/${dialHost}/tcp/${port}/p2p/${peerId}`;
}

async function syncAndBuildRemote() {
    console.log(`[bench] rsync → ${HOST}:${REMOTE_DIR}`);
    const rsync = await run("rsync", [
        "-az",
        "--delete",
        "--exclude",
        "node_modules",
        "--exclude",
        ".git",
        "--exclude",
        "dist",
        `${REPO}/`,
        `${HOST}:${REMOTE_DIR}/`
    ]);
    if (rsync.code !== 0) throw new Error(`rsync failed: ${rsync.stderr}`);
    console.log(`[bench] remote npm install && npm run build && build:bench (first run is slow)…`);
    // `npm install` (not `ci`): the committed lockfile can drift on optional platform deps
    // (e.g. utf-8-validate); a bench host just needs a working tree, not a locked one.
    const build = await run("ssh", [HOST, `cd ${REMOTE_DIR} && npm install --no-audit --no-fund && npm run build && npm run build:bench`]);
    if (build.code !== 0) throw new Error(`remote build failed:\n${build.stderr}\n${build.stdout}`);
    console.log(`[bench] remote build ok`);
}

async function measureOne(n, i) {
    const remotePort = BASE_PORT + i;

    // 1) Launch the remote seeder (ssh -tt so it dies when we close the pipe); await SEEDER_READY.
    const seedTimeout = 120_000 + n * 200; // seeding grows with N (feeder graft + verify)
    const { child: seeder, match } = await spawnUntil(
        "ssh",
        ["-tt", "-o", "ControlPath=none", HOST, `cd ${REMOTE_DIR} && ${SEEDER_ENV}node benchmark/seeder.js ${n} ${remotePort}`],
        /SEEDER_READY peerId=(\S+) port=\d+ topic=(\S+)/,
        seedTimeout,
        `seeder(N=${n})`
    );
    const peerId = match[1];
    const topic = match[2];
    seeder.stdout.on("data", () => {});
    seeder.stderr.on("data", () => {});

    // 2) The joiner dials the seeder directly at its public multiaddr over the real internet — no
    //    tunnel, so the measured RTT is the true path. Wait until the remote port is dialable.
    const providerAddr = providerMultiaddr(DIAL_HOST, remotePort, peerId);
    let results = [];
    try {
        await waitPort(DIAL_HOST, remotePort, 25_000);

        // 3) Run REPEATS fresh cold joins against the same static seeder.
        for (let r = 0; r < REPEATS; r++) {
            const cj = await run("node", [COLD_JOIN_JS, providerAddr, peerId, topic, String(n)], {
                env: { ...process.env }
            });
            const line = cj.stdout.split("\n").find((l) => l.startsWith("RESULT "));
            if (!line) {
                console.error(`[bench] N=${n} rep ${r}: no RESULT\n${cj.stderr.split("\n").slice(-6).join("\n")}`);
                continue;
            }
            const parsed = JSON.parse(line.slice("RESULT ".length));
            results.push(parsed);
            const byOp = parsed.gateRpc?.byOp;
            const rpcDetail = byOp
                ? ` (head ${byOp.head}, block ${byOp.block}, mc ${byOp.gateMulticall}×→${parsed.gateRpc.multicallReads} reads, dir ${byOp.gateDirect}` +
                  (parsed.gateRpc.httpErrors || parsed.gateRpc.rpcErrors ? `, ERR http ${parsed.gateRpc.httpErrors}/rpc ${parsed.gateRpc.rpcErrors}` : "") +
                  `)`
                : "";
            console.log(
                `[bench] N=${n} rep ${r + 1}/${REPEATS}: router=${s(parsed.router.durMs)} ` +
                    `fetch=${s(parsed.fetch.totalMs)} (negotiate=${s(parsed.fetchPhases?.negotiateMs)} ` +
                    `w→r=${s(parsed.fetchPhases?.writeReadMs)}) bitswap=${s(parsed.blockGets.totalMs)} ` +
                    `verify+merge=${s(parsed.verifyMergeMs)} rpc=${parsed.gateRpc?.requests ?? "n/a"}${rpcDetail} ` +
                    `start→tally=${s(parsed.tallyReadyMs)} start→verified=${s(parsed.verifiedTallyMs)}`
            );
        }
    } finally {
        seeder.kill("SIGKILL");
        await run("ssh", [HOST, `pkill -f "seeder.js ${n} ${remotePort}" || true`]);
    }
    if (results.length === 0) return { n, ok: false };
    const med = (pick) => median(results.map(pick).filter((x) => x != null));
    return {
        n,
        ok: true,
        routerMs: med((r) => r.router.durMs),
        connectMs: med((r) => r.connectMs),
        fetchMs: med((r) => r.fetch.totalMs),
        fetchNegotiateMs: med((r) => r.fetchPhases?.negotiateMs),
        fetchWriteReadMs: med((r) => r.fetchPhases?.writeReadMs),
        bitswapMs: med((r) => r.blockGets.totalMs),
        verifyMergeMs: med((r) => r.verifyMergeMs),
        tallyReadyMs: med((r) => r.tallyReadyMs),
        verifiedTallyMs: med((r) => r.verifiedTallyMs),
        gateRpcRequests: med((r) => r.gateRpc?.requests),
        gateRpcReads: med((r) => (r.gateRpc ? r.gateRpc.ethCalls + r.gateRpc.multicallReads : null)),
        rpcLatencyMs: med((r) => r.gateRpc?.latencyMs),
        rpcHead: med((r) => r.gateRpc?.byOp?.head),
        rpcBlock: med((r) => r.gateRpc?.byOp?.block),
        rpcMulticall: med((r) => r.gateRpc?.byOp?.gateMulticall),
        rpcMulticallReads: med((r) => r.gateRpc?.multicallReads),
        rpcDirect: med((r) => r.gateRpc?.byOp?.gateDirect),
        rpcHttpErrors: med((r) => r.gateRpc?.httpErrors),
        rpcRpcErrors: med((r) => r.gateRpc?.rpcErrors)
    };
}

async function main() {
    if (!process.env.BENCH_SKIP_SYNC) await syncAndBuildRemote();
    if (!process.env.BENCH_SKIP_BUILD) {
        console.log("[bench] local npm run build && build:bench");
        const b = await run("npm", ["run", "build"], { cwd: REPO });
        if (b.code !== 0) throw new Error(`local build failed:\n${b.stderr}`);
        const bb = await run("npm", ["run", "build:bench"], { cwd: REPO });
        if (bb.code !== 0) throw new Error(`local benchmark build failed:\n${bb.stderr}`);
    }

    DIAL_HOST = await resolveDialHost();
    console.log(`[bench] seeder dialed directly at ${DIAL_HOST} (no SSH tunnel)`);
    console.log(
        RPC_URL
            ? `[bench] REAL-CHAIN mode: gate reads against ${RPC_URL} (measured latency, real bucket sample block)`
            : `[bench] mock-gateway mode: gate reads charged ${process.env.BENCH_RPC_LATENCY_MS ?? 270}ms per round trip`
    );

    const rows = [];
    for (let i = 0; i < NS.length; i++) {
        console.log(`\n[bench] === N=${NS[i]} (${REPEATS} repeats) ===`);
        rows.push(await measureOne(NS[i], i));
    }

    console.log(`\nCold-join latency — seeder on ${HOST} (dialed directly at ${DIAL_HOST}), discovered via HTTP router, median of ${REPEATS} (times → s)`);
    console.log("N(voters)  router   connect   fetch    bitswap  verify+merge   gate-RPC   START→TALLY   START→VERIFIED");
    for (const r of rows) {
        if (!r.ok) {
            console.log(`${String(r.n).padEnd(10)} (no successful cold join)`);
            continue;
        }
        console.log(
            `${String(r.n).padEnd(10)} ${s(r.routerMs)}  ${s(r.connectMs)}   ${s(r.fetchMs)}  ` +
                `${s(r.bitswapMs)}  ${s(r.verifyMergeMs)}         ${r.gateRpcRequests ?? "n/a"}          ` +
                `${s(r.tallyReadyMs)}        ${s(r.verifiedTallyMs)}`
        );
    }
    console.log("\nfetch sub-phase split (median → s):");
    console.log("N(voters)  fetch    negotiate  write→read");
    for (const r of rows) {
        if (!r.ok) continue;
        console.log(`${String(r.n).padEnd(10)} ${s(r.fetchMs)}  ${s(r.fetchNegotiateMs)}     ${s(r.fetchWriteReadMs)}`);
    }
    console.log("\ngate-RPC per-op round trips (median; reads = multicall inner reads):");
    console.log("N(voters)  total  head  block  multicall  reads  direct  http-err  rpc-err  latency");
    for (const r of rows) {
        if (!r.ok) continue;
        const c = (x) => String(x ?? "n/a").padStart(5);
        console.log(
            `${String(r.n).padEnd(10)} ${c(r.gateRpcRequests)} ${c(r.rpcHead)} ${c(r.rpcBlock)}   ${c(r.rpcMulticall)}    ${c(r.rpcMulticallReads)}  ${c(r.rpcDirect)}    ${c(r.rpcHttpErrors)}    ${c(r.rpcRpcErrors)}   ${r.rpcLatencyMs == null ? "n/a" : Math.round(r.rpcLatencyMs) + "ms"}`
        );
    }
}

main().catch((err) => {
    console.error(`[bench] fatal: ${err.stack ?? err.message}`);
    process.exit(1);
});
