#!/usr/bin/env node
// Directory-load latency benchmark — ORCHESTRATOR.
//
// Models a 5chan.app cold load: one shared SEEDER on a remote WAN host provides `M` contest topics,
// each seeded with `N` real-signed voters; a fresh COLD JOINER runs locally, dials the seeder
// **directly at its public multiaddr over the real internet** (no SSH tunnel), and joins ALL M
// contests at once — timing how long until EVERY contest has a usable tally. This is the
// shared-seeder amortization the cold-join benchmark (one contest) cannot show: one dial + handshake,
// M fetches + M checkpoint pulls multiplexed over it, and a verify cost that sums across all M×N
// ballots. Prints a median-of-repeats table.
//
// SSH is used only to launch the remote seeder process and read its readiness line. Reachability is
// the same as run.mjs: the seeder's port must be dialable from this machine.
//
// Env:
//   BENCH_HOST=<ssh-host>        remote ssh host to run the seeder on (REQUIRED)
//   BENCH_HOST_IP=<ip-or-dns>    public IP/DNS the joiner dials the seeder at
//                                (default: the `hostname` from `ssh -G $BENCH_HOST`)
//   BENCH_REMOTE_DIR=~/pubsub-votes-bench   remote checkout dir
//   BENCH_MS=1,10,63             contest counts (M) to sweep
//   BENCH_N=10                   voters per contest (fixed across the M sweep)
//   BENCH_REPEATS=3              cold joins per M (median reported)
//   BENCH_ROUTER_LATENCY_MS=1000 simulated HTTP-router lookup latency (paid once)
//   BENCH_SKIP_SYNC=1            skip rsync+remote build (reuse an already-synced remote)
//   BENCH_SKIP_BUILD=1           skip the local `npm run build`
//
// Usage: BENCH_HOST=<ssh-host> npm run bench:directory-load

import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST = process.env.BENCH_HOST;
if (!HOST) throw new Error("set BENCH_HOST to the ssh host that runs the seeder (e.g. BENCH_HOST=my-server npm run bench:directory-load)");
const REMOTE_DIR = process.env.BENCH_REMOTE_DIR ?? "~/pubsub-votes-bench";
const MS = (process.env.BENCH_MS ?? "1,10,63").split(",").map((s) => Number(s.trim()));
// Voters (= bundles) per contest. A comma list sweeps it; the table gets one row per (M, N) pair.
const NS = (process.env.BENCH_N ?? "10").split(",").map((s) => Number(s.trim()));
const REPEATS = Number(process.env.BENCH_REPEATS ?? "3");
const BASE_PORT = Number(process.env.BENCH_BASE_PORT ?? "42000");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOIN_JS = path.join(REPO, "benchmark/directory-join.js");

// The public IP/DNS the cold joiner dials the seeder at (resolved once in main()).
let DIAL_HOST;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
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

/** The public IP/DNS the cold joiner dials the seeder at (BENCH_HOST_IP or the ssh -G hostname). */
async function resolveDialHost() {
    if (process.env.BENCH_HOST_IP) return process.env.BENCH_HOST_IP;
    const g = await run("ssh", ["-G", HOST]);
    const line = g.stdout.split("\n").find((l) => l.startsWith("hostname "));
    const hostname = line?.slice("hostname ".length).trim();
    if (!hostname) throw new Error(`could not resolve a dial host from \`ssh -G ${HOST}\`; set BENCH_HOST_IP explicitly`);
    return hostname;
}

/** Build the seeder's dialable multiaddr (IPv4 literal → /ip4, else /dns4). */
function providerMultiaddr(dialHost, port, peerId) {
    const proto = /^\d{1,3}(\.\d{1,3}){3}$/.test(dialHost) ? "ip4" : "dns4";
    return `/${proto}/${dialHost}/tcp/${port}/p2p/${peerId}`;
}

async function syncAndBuildRemote() {
    console.log(`[bench] rsync → ${HOST}:${REMOTE_DIR}`);
    const rsync = await run("rsync", ["-az", "--delete", "--exclude", "node_modules", "--exclude", ".git", "--exclude", "dist", `${REPO}/`, `${HOST}:${REMOTE_DIR}/`]);
    if (rsync.code !== 0) throw new Error(`rsync failed: ${rsync.stderr}`);
    console.log(`[bench] remote npm install && npm run build && build:bench (first run is slow)…`);
    const build = await run("ssh", [HOST, `cd ${REMOTE_DIR} && npm install --no-audit --no-fund && npm run build && npm run build:bench`]);
    if (build.code !== 0) throw new Error(`remote build failed:\n${build.stderr}\n${build.stdout}`);
    console.log(`[bench] remote build ok`);
}

async function measureOne(m, n, i) {
    const remotePort = BASE_PORT + i;

    // Seeding M contests × N voters through the real gate grows with M×N (sign + gate-verify every
    // bundle, on both seeder and joiner); give it generous headroom that scales with the bundle count.
    const seedTimeout = 300_000 + m * n * 40;
    const { child: seeder, match } = await spawnUntil(
        "ssh",
        ["-tt", "-o", "ControlPath=none", HOST, `cd ${REMOTE_DIR} && node benchmark/directory-seeder.js ${m} ${n} ${remotePort}`],
        /SEEDER_READY peerId=(\S+) port=\d+ m=\d+ n=\d+/,
        seedTimeout,
        `dir-seeder(M=${m},N=${n})`
    );
    const peerId = match[1];
    seeder.stdout.on("data", () => {});
    seeder.stderr.on("data", () => {});

    const providerAddr = providerMultiaddr(DIAL_HOST, remotePort, peerId);
    let results = [];
    try {
        await waitPort(DIAL_HOST, remotePort, 25_000);
        for (let r = 0; r < REPEATS; r++) {
            const cj = await run("node", [JOIN_JS, providerAddr, peerId, String(m), String(n)], { env: { ...process.env } });
            const line = cj.stdout.split("\n").find((l) => l.startsWith("RESULT "));
            if (!line) {
                console.error(`[bench] M=${m} N=${n} rep ${r}: no RESULT\n${cj.stderr.split("\n").slice(-8).join("\n")}`);
                continue;
            }
            const parsed = JSON.parse(line.slice("RESULT ".length));
            results.push(parsed);
            console.log(
                `[bench] M=${m} N=${n} rep ${r + 1}/${REPEATS}: conns=${parsed.seederConnections} converged=${parsed.readyCount}/${m} ` +
                    `connect=${s(parsed.connectMs)} fetch=${s(parsed.fetch.totalMs)} (${parsed.fetch.count}x) ` +
                    `bitswap=${s(parsed.blockGets.totalMs)} (${(parsed.blockGets.bytes / 1024).toFixed(0)}KiB) ` +
                    `verify+merge=${s(parsed.verifyMergeMs)} start→all=${s(parsed.allTalliesReadyMs)} start→all-verified=${s(parsed.allVerifiedMs)}`
            );
        }
    } finally {
        seeder.kill("SIGKILL");
        await run("ssh", [HOST, `pkill -f "directory-seeder.js ${m} ${n} ${remotePort}" || true`]);
    }
    if (results.length === 0) return { m, n, ok: false };
    const med = (pick) => median(results.map(pick).filter((x) => x != null));
    // Percentile of a single run's convergence curve (when the k-th contest became ready).
    const pct = (arr, p) => (arr && arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
    return {
        m,
        n,
        ok: true,
        convergedCount: med((r) => r.readyCount),
        seederConnections: med((r) => r.seederConnections),
        // Amortized once across all M contests (one shared connection):
        routerMs: med((r) => r.router.firstDurMs),
        connectMs: med((r) => r.connectMs),
        identifyMs: med((r) => r.identifyMs),
        // Per-contest op cost (Σ across the M concurrent ops, and the per-contest average):
        fetchCount: med((r) => r.fetch.count),
        fetchMs: med((r) => r.fetch.totalMs),
        fetchPerContestMs: med((r) => (r.fetch.count ? r.fetch.totalMs / r.fetch.count : null)),
        bitswapMs: med((r) => r.blockGets.totalMs),
        bitswapPerContestMs: med((r) => (r.blockGets.networkCount ? r.blockGets.totalMs / r.blockGets.networkCount : null)),
        bitswapKiB: med((r) => r.blockGets.bytes / 1024),
        // Aggregate + wall-clock:
        verifyMergeMs: med((r) => r.verifyMergeMs),
        p50Ms: med((r) => pct(r.readyAtMs, 0.5)),
        p90Ms: med((r) => pct(r.readyAtMs, 0.9)),
        allTalliesReadyMs: med((r) => r.allTalliesReadyMs),
        allVerifiedMs: med((r) => r.allVerifiedMs)
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
    console.log(`[bench] seeder dialed directly at ${DIAL_HOST} (no SSH tunnel); M=[${MS}] contests × N=[${NS}] voters/contest`);

    // Sweep every (M contests, N voters/contest) pair — one table row each.
    const pairs = [];
    for (const m of MS) for (const nv of NS) pairs.push([m, nv]);
    const rows = [];
    for (let i = 0; i < pairs.length; i++) {
        const [m, nv] = pairs[i];
        console.log(`\n[bench] === M=${m} contests, N=${nv} voters/contest = ${m * nv} bundles (${REPEATS} repeats) ===`);
        rows.push(await measureOne(m, nv, i));
    }

    const n = (x, w = 4) => String(Math.round(x)).padStart(w);
    const b = (m, nv) => n(m * nv, 6); // total bundles across the directory

    // Table 1 — per-operation latency. Amortized-once ops (router/connect/identify) are paid a single
    // time across all M contests over the shared connection; fetch/bitswap are shown per-contest (the
    // cost of one contest's op — they overlap, so they do NOT sum to the total); verify+merge and
    // START→ALL-TALLIES are the aggregate + true wall-clock. `N` = voters = bundles per contest.
    console.log(`\nDirectory cold-load — per-operation latency — shared seeder on ${HOST} (dialed at ${DIAL_HOST}), median of ${REPEATS} (times → s)`);
    console.log("M(contests)  N/ct  bundles   router   connect   identify   fetch/ct   bitswap/ct   verify+merge   START→ALL-TALLIES   START→ALL-VERIFIED");
    for (const r of rows) {
        if (!r.ok) {
            console.log(`${String(r.m).padEnd(12) } ${n(r.n, 4)}  ${b(r.m, r.n)}   (no successful cold join)`);
            continue;
        }
        console.log(
            `${String(r.m).padEnd(12)} ${n(r.n, 4)}  ${b(r.m, r.n)}   ${s(r.routerMs)}   ${s(r.connectMs)}   ${s(r.identifyMs)}     ` +
                `${s(r.fetchPerContestMs)}     ${s(r.bitswapPerContestMs)}      ${s(r.verifyMergeMs)}          ${s(r.allTalliesReadyMs)}              ${s(r.allVerifiedMs)}`
        );
    }

    // Table 2 — parallelism / convergence detail. Σ columns are the sum across the M concurrent ops
    // (not wall-clock); p50/p90 are the convergence curve — when the median / 90th-percentile contest
    // tally became ready — so a directory that fills in progressively is visible.
    console.log(`\nDirectory cold-load — parallelism + convergence — median of ${REPEATS}`);
    console.log("M(contests)  N/ct  bundles   conns  converged  fetches  Σfetch   Σbitswap  KiB     conv-p50  conv-p90  START→ALL");
    for (const r of rows) {
        if (!r.ok) continue;
        console.log(
            `${String(r.m).padEnd(12)} ${n(r.n, 4)}  ${b(r.m, r.n)}   ${n(r.seederConnections, 4)}  ${n(r.convergedCount, 3)}/${String(r.m).padEnd(3)}  ` +
                `${n(r.fetchCount, 5)}   ${s(r.fetchMs)}  ${s(r.bitswapMs)}  ${n(r.bitswapKiB, 5)}   ${s(r.p50Ms)}    ${s(r.p90Ms)}    ${s(r.allTalliesReadyMs)}`
        );
    }
}

main().catch((err) => {
    console.error(`[bench] fatal: ${err.stack ?? err.message}`);
    process.exit(1);
});
