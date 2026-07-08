#!/usr/bin/env node
// Cold-join latency benchmark — ORCHESTRATOR.
//
// Drives a real cross-machine sweep: a SEEDER runs on a remote WAN host (`ssh <host>`), a fresh COLD
// JOINER runs locally and dials the seeder through an SSH port-forward (so `127.0.0.1:<localPort>` is
// the seeder across the real link, RTT preserved, NAT/firewall sidestepped). For each N it seeds N
// real-signed winners on the remote, then times how long a cold local peer takes to reach a full
// tally — the "which board to load" signal. Prints a median-of-repeats table.
//
// Env:
//   BENCH_HOST=<ssh-host>        remote ssh host to run the seeder on (REQUIRED)
//   BENCH_REMOTE_DIR=~/pubsub-votes-bench   remote checkout dir
//   BENCH_NS=1,5,10,100,1000     voter counts to sweep
//   BENCH_REPEATS=3              cold joins per N (median reported)
//   BENCH_ROUTER_LATENCY_MS=1000 simulated HTTP-router lookup latency (paid once)
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
const COLD_JOIN_JS = path.join(REPO, "dist/transport/integration/bench/cold-join.js");

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

/** Wait until a local TCP port accepts a connection (the SSH forward is ready). */
async function waitPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ok = await new Promise((res) => {
            const sock = net.connect({ host: "127.0.0.1", port }, () => {
                sock.destroy();
                res(true);
            });
            sock.on("error", () => res(false));
        });
        if (ok) return;
        if (Date.now() > deadline) throw new Error(`port ${port} not open after ${timeoutMs}ms`);
        await sleep(200);
    }
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
    console.log(`[bench] remote npm install && npm run build (first run is slow)…`);
    // `npm install` (not `ci`): the committed lockfile can drift on optional platform deps
    // (e.g. utf-8-validate); a bench host just needs a working tree, not a locked one.
    const build = await run("ssh", [HOST, `cd ${REMOTE_DIR} && npm install --no-audit --no-fund && npm run build`]);
    if (build.code !== 0) throw new Error(`remote build failed:\n${build.stderr}\n${build.stdout}`);
    console.log(`[bench] remote build ok`);
}

async function measureOne(n, i) {
    const remotePort = BASE_PORT + i;
    const localPort = BASE_PORT + 100 + i;

    // 1) Launch the remote seeder (ssh -tt so it dies when we close the pipe); await SEEDER_READY.
    const seedTimeout = 120_000 + n * 200; // seeding grows with N (feeder graft + verify)
    const { child: seeder, match } = await spawnUntil(
        "ssh",
        ["-tt", "-o", "ControlPath=none", HOST, `cd ${REMOTE_DIR} && node dist/transport/integration/bench/seeder.js ${n} ${remotePort}`],
        /SEEDER_READY peerId=(\S+) port=\d+ topic=(\S+)/,
        seedTimeout,
        `seeder(N=${n})`
    );
    const peerId = match[1];
    const topic = match[2];
    seeder.stdout.on("data", () => {});
    seeder.stderr.on("data", () => {});

    // 2) Open the SSH port-forward and wait for it to accept. Force a dedicated connection
    //    (ControlPath=none) so the forward never contends with the `-tt` seeder over a shared
    //    ControlMaster socket — the cause of a transient "port not open" on the forward.
    const forward = spawn("ssh", ["-o", "ControlPath=none", "-N", "-L", `${localPort}:127.0.0.1:${remotePort}`, HOST]);
    forward.stderr.on("data", () => {});
    let results = [];
    try {
        await waitPort(localPort, 25_000);

        // 3) Run REPEATS fresh cold joins against the same static seeder.
        for (let r = 0; r < REPEATS; r++) {
            const cj = await run("node", [COLD_JOIN_JS, String(localPort), peerId, topic, String(n)], {
                env: { ...process.env }
            });
            const line = cj.stdout.split("\n").find((l) => l.startsWith("RESULT "));
            if (!line) {
                console.error(`[bench] N=${n} rep ${r}: no RESULT\n${cj.stderr.split("\n").slice(-6).join("\n")}`);
                continue;
            }
            const parsed = JSON.parse(line.slice("RESULT ".length));
            results.push(parsed);
            console.log(
                `[bench] N=${n} rep ${r + 1}/${REPEATS}: router=${s(parsed.router.durMs)} ` +
                    `fetch=${s(parsed.fetch.totalMs)} bitswap=${s(parsed.blockGets.totalMs)} ` +
                    `verify+merge=${s(parsed.verifyMergeMs)} start→tally=${s(parsed.tallyReadyMs)}`
            );
        }
    } finally {
        forward.kill("SIGKILL");
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
        bitswapMs: med((r) => r.blockGets.totalMs),
        verifyMergeMs: med((r) => r.verifyMergeMs),
        tallyReadyMs: med((r) => r.tallyReadyMs)
    };
}

async function main() {
    if (!process.env.BENCH_SKIP_SYNC) await syncAndBuildRemote();
    if (!process.env.BENCH_SKIP_BUILD) {
        console.log("[bench] local npm run build");
        const b = await run("npm", ["run", "build"], { cwd: REPO });
        if (b.code !== 0) throw new Error(`local build failed:\n${b.stderr}`);
    }

    const rows = [];
    for (let i = 0; i < NS.length; i++) {
        console.log(`\n[bench] === N=${NS[i]} (${REPEATS} repeats) ===`);
        rows.push(await measureOne(NS[i], i));
    }

    console.log(`\nCold-join latency — seeder on ${HOST}, discovered via HTTP router, median of ${REPEATS} (times → s)`);
    console.log("N(voters)  router   connect   fetch    bitswap  verify+merge   START→TALLY");
    for (const r of rows) {
        if (!r.ok) {
            console.log(`${String(r.n).padEnd(10)} (no successful cold join)`);
            continue;
        }
        console.log(
            `${String(r.n).padEnd(10)} ${s(r.routerMs)}  ${s(r.connectMs)}   ${s(r.fetchMs)}  ` +
                `${s(r.bitswapMs)}  ${s(r.verifyMergeMs)}         ${s(r.tallyReadyMs)}`
        );
    }
}

main().catch((err) => {
    console.error(`[bench] fatal: ${err.stack ?? err.message}`);
    process.exit(1);
});
