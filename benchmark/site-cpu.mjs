// Steady-state CPU + memory of a REAL browser consumer of this library.
//
// Every other benchmark here measures an operation: how long a cold join takes, how long a
// directory load takes, how fast a warm restart is. None of them measure what a browser tab
// running this library COSTS once all of that has finished and the page is just sitting
// there subscribed — which is the cost a user actually lives with, and the one that shows up
// as a spinning laptop fan rather than as a slow number.
//
// It drives an external site checkout (SITE_ROOT) rather than a synthetic host, because the
// thing being measured is per-subscribed-contest overhead that only appears at real fan-out.
// The reference consumer is pubsub-voting-testing-on-real-website (63 contests, 64
// communities, one shared Helia node); any Vite site that builds to `dist/` and exposes
// `window.__phases` works.
//
// This caught pkc-js polling its community update loop on a 1s timer: 2 `updatingstatechange`
// transitions per second per subscribed community, ~130 events/s at 63 contests, 24% of a
// core burnt indefinitely doing nothing. See RESULTS.md.
//
// Two independent CPU numbers, because neither alone is trustworthy:
//
//   procCpuSec  utime+stime of the WHOLE Chromium process tree, read from /proc. Counts the
//               renderer, the network service, the GPU process and every worker thread —
//               i.e. what the fan responds to. This is the headline.
//   taskSec     CDP Performance.getMetrics TaskDuration: renderer main thread only. Narrower,
//               but it isolates "the page's own JS/layout" from browser overhead, so a gap
//               between the two says the cost is off-main-thread (crypto, network, GC).
//
// Health counters come from `window.__phases`, which main.ts caps at 5000 events
// (PHASE_LIMIT) — deliberately, since it used to grow to ~1.2 GB over a long run. At the
// churn rates this bench exists to measure, that buffer wraps in well under a minute, so
// cold-start counts are read EARLY (HEALTH_AT_MS, default 20 s) and the end-of-run read is
// used only for the event RATE and the kind histogram. Reading the counts at the end would
// silently report "0 communities loaded" for a perfectly healthy run.
//
// Usage:
//   SITE_ROOT=../pubsub-voting-testing-on-real-website npm run bench:site-cpu
//   SITE_ROOT=… ROUNDS=1 WINDOW_MS=300000 LABEL=pkc-0.0.94 node benchmark/site-cpu.mjs
//   SITE_ROOT=… SKIP_BUILD=1 QUERY='prewarm=0' LABEL=no-prewarm node benchmark/site-cpu.mjs
//
// To A/B a change to THIS library, `npm pack` it and install the tarball into SITE_ROOT
// between runs — the site consumes it as a normal dependency, so nothing here needs linking.
//
// Env: SITE_ROOT (REQUIRED), ROUNDS (3), SETTLE_MS (60000), WINDOW_MS (120000),
//      SAMPLE_MS (2000), HEALTH_AT_MS (20000), QUERY, LABEL, HEADED=1, SKIP_BUILD=1,
//      OUT=<file.json>, PLAYWRIGHT_FROM, CHROME_PATH, PROFILE_BASE

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

// No default: this repo is a library, not a site. Fail loudly rather than benchmark nothing.
const ROOT = process.env.SITE_ROOT ? path.resolve(process.env.SITE_ROOT) : undefined;
if (!ROOT || !fs.existsSync(path.join(ROOT, "package.json"))) {
    console.error(
        "SITE_ROOT must point at a site checkout that consumes this library.\n" +
            "  SITE_ROOT=../pubsub-voting-testing-on-real-website npm run bench:site-cpu"
    );
    process.exit(1);
}
// Playwright lives in the pkc-js checkout (same pattern as coldstart-bench.mjs); fall back
// to a local install if there is one.
const PLAYWRIGHT_FROM = process.env.PLAYWRIGHT_FROM || "/home/user2/Nextcloud/projects/plebbit/pkc-js";
const require = createRequire(path.join(PLAYWRIGHT_FROM, "package.json"));
const { chromium } = require("playwright");

const LABEL = process.env.LABEL || "run";
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 60_000);
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 120_000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 2_000);
const HEALTH_AT_MS = Number(process.env.HEALTH_AT_MS ?? 20_000);
const QUERY = process.env.QUERY ?? "";
const OUT = process.env.OUT;

if (!process.env.SKIP_BUILD) {
    console.log("building site…");
    execSync("npx vite build", { cwd: ROOT, stdio: "inherit" });
}

/* ---------- serve dist ---------- */
const DIST = path.join(ROOT, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(DIST, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${DIST} at ${origin}`);

/* ---------- /proc CPU + RSS accounting over a process tree ----------
 * /proc/<pid>/stat after the "(comm)" field starts at `state`, so ppid is [1] and
 * utime/stime — the two the fan cares about — are [11] and [12]. */
const CLK = Number(execSync("getconf CLK_TCK").toString().trim()) || 100;
function descendants(root) {
    const kids = new Map();
    for (const pid of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
            if (!kids.has(ppid)) kids.set(ppid, []);
            kids.get(ppid).push(Number(pid));
        } catch {} // a process that exited between readdir and read is not an error
    }
    const out = [];
    const walk = (pid) => { out.push(pid); for (const k of kids.get(pid) ?? []) walk(k); };
    walk(root);
    return out;
}
function treeStats(root) {
    let jiffies = 0, rssKb = 0, procs = 0;
    for (const pid of descendants(root)) {
        try {
            const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            const fields = f.slice(f.lastIndexOf(")") + 2).split(" ");
            jiffies += Number(fields[11]) + Number(fields[12]);
            const m = /^VmRSS:\s+(\d+) kB$/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
            if (m) rssKb += Number(m[1]);
            procs++;
        } catch {}
    }
    return { cpuSec: jiffies / CLK, rssMiB: rssKb / 1024, procs };
}

/** Playwright exposes no browser.process(); find the launched chrome by its unique profile dir. */
function findChromePid(userDataDir) {
    for (const pid of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
            if (!cmd.includes(userDataDir)) continue;
            // The browser process is the one whose parent is NOT also a chrome of this profile.
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
            let parentIsChrome = false;
            try { parentIsChrome = fs.readFileSync(`/proc/${ppid}/cmdline`, "utf8").includes(userDataDir); } catch {}
            if (!parentIsChrome) return Number(pid);
        } catch {}
    }
    throw new Error(`no chrome process found for ${userDataDir}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Counted INSIDE the page: serialising a multi-minute __phases array back over CDP fails,
 *  and a swallowed failure looks exactly like a dead site. */
const COUNT_IN_PAGE = () => {
    const p = window.__phases ?? [];
    const n = (kind, label) => p.filter((x) => x.kind === kind && (label === undefined || x.label === label)).length;
    const span = p.length > 1 ? p[p.length - 1].atMs - p[0].atMs : 0;
    return {
        buffered: p.length,
        saturated: p.length >= 5000,
        windowSpanMs: Math.round(span),
        eventsPerSec: span > 0 ? +((p.length / span) * 1000).toFixed(1) : 0,
        communitiesLoaded: n("community-loaded"),
        connOpen: n("conn", "open"),
        connClose: n("conn", "close"),
        joinsDone: n("join-done"),
        joinsFailed: n("join-failed"),
        tallies: n("first-tally"),
        fetchStart: n("fetch-start"),
        subscriptionChange: n("subscription-change"),
        // What the churn actually IS — the top event kinds in the buffer.
        byKind: Object.entries(p.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] ?? 0) + 1; return acc; }, {}))
            .sort((a, b) => b[1] - a[1]).slice(0, 8)
    };
};

async function metrics(session) {
    const { metrics: ms } = await session.send("Performance.getMetrics");
    const get = (name) => ms.find((m) => m.name === name)?.value ?? 0;
    return { taskSec: get("TaskDuration"), scriptSec: get("ScriptDuration"), jsHeapMiB: get("JSHeapUsedSize") / 1024 / 1024 };
}

async function round(n) {
    // A fresh profile per round is what makes this cold: pubsub-voting persists checkpoints
    // in IndexedDB and would otherwise restore the tally instead of pulling it.
    const userDataDir = fs.mkdtempSync(path.join(process.env.PROFILE_BASE || "/tmp", `cpubench-${LABEL}-${n}-`));
    const CHROME_PATH = process.env.CHROME_PATH || "/home/user2/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: !process.env.HEADED,
        executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined
    });
    const rootPid = findChromePid(userDataDir);
    const page = context.pages()[0] ?? (await context.newPage());
    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    const t0 = Date.now();
    const base = treeStats(rootPid);
    await page.goto(`${origin}/${QUERY ? `?${QUERY}` : ""}`, { waitUntil: "commit" });

    const samples = [];
    const sampleUntil = async (endAt, tag) => {
        while (Date.now() < endAt) {
            await sleep(SAMPLE_MS);
            const s = treeStats(rootPid);
            samples.push({ tag, atMs: Date.now() - t0, cpuSec: s.cpuSec - base.cpuSec, rssMiB: s.rssMiB, procs: s.procs });
        }
    };
    const evalSafe = () => page.evaluate(COUNT_IN_PAGE).catch((e) => ({ error: String(e).slice(0, 200) }));

    await sampleUntil(t0 + Math.min(HEALTH_AT_MS, SETTLE_MS), "cold");
    const healthCounts = await evalSafe();          // before the ring buffer wraps
    await sampleUntil(t0 + SETTLE_MS, "cold");
    const afterCold = treeStats(rootPid);
    const coldMetrics = await metrics(session);

    await sampleUntil(t0 + SETTLE_MS + WINDOW_MS, "steady");
    const afterSteady = treeStats(rootPid);
    const steadyMetrics = await metrics(session);
    const steadyCounts = await evalSafe();          // rate + histogram only

    await context.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

    const coldCpu = afterCold.cpuSec - base.cpuSec;
    const steadyCpu = afterSteady.cpuSec - afterCold.cpuSec;
    const firstSteady = samples.find((s) => s.tag === "steady");
    return {
        label: LABEL, round: n, query: QUERY, coldMs: SETTLE_MS, windowMs: WINDOW_MS,
        coldCpuSec: +coldCpu.toFixed(2),
        steadyCpuSec: +steadyCpu.toFixed(2),
        /** The headline: how much of one core the tab burns while just sitting there. */
        steadyCpuPct: +((steadyCpu / (WINDOW_MS / 1000)) * 100).toFixed(1),
        peakRssMiB: +Math.max(...samples.map((s) => s.rssMiB)).toFixed(0),
        endRssMiB: +afterSteady.rssMiB.toFixed(0),
        rssGrowthMiB: +(afterSteady.rssMiB - (firstSteady?.rssMiB ?? afterSteady.rssMiB)).toFixed(0),
        jsHeapMiB: +steadyMetrics.jsHeapMiB.toFixed(1),
        jsHeapGrowthMiB: +(steadyMetrics.jsHeapMiB - coldMetrics.jsHeapMiB).toFixed(1),
        rendererTaskSecCold: +coldMetrics.taskSec.toFixed(2),
        rendererTaskSecSteady: +(steadyMetrics.taskSec - coldMetrics.taskSec).toFixed(2),
        rendererScriptSecSteady: +(steadyMetrics.scriptSec - coldMetrics.scriptSec).toFixed(2),
        healthCounts, steadyCounts, procs: afterSteady.procs, pageErrors: pageErrors.slice(0, 5), samples
    };
}

const results = [];
for (let i = 1; i <= ROUNDS; i++) {
    const r = await round(i);
    results.push(r);
    console.log(`
── ${r.label} round ${r.round}
   cold   ${(r.coldMs / 1000).toFixed(0)}s : ${r.coldCpuSec.toFixed(2)} CPU-s  (${((r.coldCpuSec / (r.coldMs / 1000)) * 100).toFixed(0)}% of one core)
   STEADY ${(r.windowMs / 1000).toFixed(0)}s : ${r.steadyCpuSec.toFixed(2)} CPU-s  →  ${r.steadyCpuPct}% of one core   ← the fan number
   renderer main thread (steady): task ${r.rendererTaskSecSteady}s, script ${r.rendererScriptSecSteady}s
   memory: peak RSS ${r.peakRssMiB} MiB · end RSS ${r.endRssMiB} MiB · JS heap ${r.jsHeapMiB} MiB (grew ${r.jsHeapGrowthMiB} MiB over the window)
   cold-start health @${(HEALTH_AT_MS / 1000).toFixed(0)}s: ${r.healthCounts.communitiesLoaded} communities · ${r.healthCounts.joinsDone} joins ok / ${r.healthCounts.joinsFailed} failed · ${r.healthCounts.tallies} first-tallies
   steady churn: ${r.steadyCounts.eventsPerSec} instrumentation events/s over the last ${(r.steadyCounts.windowSpanMs / 1000).toFixed(0)}s · chrome procs ${r.procs}
   steady event kinds: ${(r.steadyCounts.byKind ?? []).map(([k, c]) => `${k}=${c}`).join(" ")}${r.pageErrors.length ? `\n   pageerrors: ${r.pageErrors.join(" | ")}` : ""}`);
}

if (ROUNDS > 1) {
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(`
══ ${LABEL} — ${ROUNDS} rounds
   steady CPU  mean ${mean(results.map((r) => r.steadyCpuPct)).toFixed(1)}% of one core  (${results.map((r) => r.steadyCpuPct).join(", ")})
   cold CPU    mean ${mean(results.map((r) => r.coldCpuSec)).toFixed(2)} CPU-s
   peak RSS    mean ${mean(results.map((r) => r.peakRssMiB)).toFixed(0)} MiB`);
}

if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(ROOT, OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, OUT), JSON.stringify(results, null, 2));
}
server.close();
process.exit(0);
