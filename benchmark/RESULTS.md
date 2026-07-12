# Cold-join latency — benchmark results

**What this measures:** how long a **cold peer** takes, from joining a contest to having a usable
**tally** (the "which community/board do I load in the UI?" signal, i.e. `getTally()` returning the
full ranking). This is the latency of the *existing code*, measured — not estimated.

**Why cross-machine, not loopback:** loopback has ~0 ms RTT, so it only measures CPU/verify cost and
hides the protocol round-trips that dominate in the real world. These numbers were taken with the
seeder on a **remote WAN host (~270 ms round-trip)** and the cold joiner local, with the joiner
**dialing the seeder directly at its public IP over the real internet** — no SSH tunnel. (An earlier
version tunnelled the data path through an SSH port-forward; that is TCP-over-TCP, and its extra
buffering/retransmit inflated every round-trip — most of all bitswap, the chattiest step. Dropping
the tunnel roughly **halved** cold join, and these numbers are the true network path. SSH is now used
only to launch the remote seeder process.) The joiner's chain reads go through the **mock ETH gateway**
([rpc-gateway.ts](./rpc-gateway.ts)): a real JSON-RPC HTTP server behind a real default-config viem
client (one POST per read, `retryCount: 3`, multicall3 served), **270 ms charged per RPC round trip**
(`BENCH_RPC_LATENCY_MS`) — so the deferred, batched gate reads are measured, not free. The seeder keeps
the instant fake chain (its seeding-time reads are setup, not the join under test). Two end-to-end
milestones come out: **START→TALLY** (render-ready — the chase admits on offline checks, rows may still
be `chainVerified: false`) and **START→VERIFIED** (every deferred gate read landed).

**Discovery model:** peers are discovered via an **HTTP content router** (Delegated Routing V1, no
DHT — the pkc-js pattern), simulated locally with a **~1 s lookup latency paid once**; after that
bitswap's IWANT takes over peer-to-peer. The router's provider records are **announced by the
seeder for real** (`PubsubVoterOptions.httpRouterUrls`, reaching the local router over an SSH
reverse tunnel — out-of-band of the measured join path), so the bench exercises
announce → router → `findProviders` → dial end-to-end. `#coldStart` races this against
`getSubscribers(topic)` and fetches from whichever names a peer first.

Run it yourself: `BENCH_HOST=<ssh-host> npm run bench:cold-join` (see [run.mjs](./run.mjs)).

---

## Per-operation latency (seeder on a ~270 ms-RTT WAN host, cold joiner local, median of 5)

`N` is the number of **voters** (distinct wallets, one ballot each) in the contest's checkpoint. All
voters vote for one community, so the tally is one community of weight `N`.

| N (voters) | router | connect | fetch | bitswap | verify+merge | gate-RPC | **START→TALLY** | **START→VERIFIED** |
|-----------:|-------:|--------:|------:|--------:|-------------:|---------:|----------------:|-------------------:|
| 1          | 1.00s  | 1.57s   | 0.53s | 0.55s   | 0.31s        | 2        | **3.08s**       | **3.38s**          |
| 5          | 1.00s  | 1.54s   | 0.54s | 0.60s   | 0.31s        | 2        | **3.00s**       | **3.31s**          |
| 10         | 1.00s  | 1.55s   | 0.49s | 0.56s   | 0.33s        | 2        | **2.94s**       | **3.24s**          |
| 100        | 1.00s  | 1.55s   | 0.52s | 0.58s   | 0.48s        | 5        | **3.11s**       | **3.41s**          |
| 1000       | 1.00s  | 1.55s   | 0.53s | 1.21s   | 2.07s        | 38       | **5.38s**       | **5.44s**          |
| 10000†     | 1.00s  | 1.59s   | 1.98s | 9.17s   | 12.35s       | —        | **18.95s**      | —                  |

*Measured 2026-07-12 (direct public dial, no SSH tunnel; **median of 5** — WAN jitter at this RTT is
large enough that 3 repeats gave unstable per-op medians, so this baseline uses 5). This run's
provider records were **announced by the seeder for real** (`httpRouterUrls` → `ssh -R`-tunneled
router), not hardcoded; every column matched the 2026-07-09 hardcoded-record baseline within jitter
(e.g. `START→TALLY` 3.43s → 3.08s at N=1, 5.48s → 5.38s at N=1000), confirming announcing is
seeder-side only. Columns are wall-clock timings of each operation but they **overlap** and do not
sum to the total — `connect` is measured from the `start()` call and already contains the 1 s router
wait, and verify runs as blocks arrive. `START→TALLY` / `START→VERIFIED` are the true end-to-end
figures.*

*†The `N=10000` row (median of 3, one rep timed out on WAN jitter) is a separate single-contest run from
the **previous baseline** (2026-07-08: instant fake chain, inline verification — before the mock ETH
gateway and background chain verification existed, hence no gate-RPC/VERIFIED values) — a realistic
**hot board**: 10,000 distinct voters, each a single-vote bundle, so a 10k-weight tally over a ~2.3 MB
checkpoint. It is the point where the load stops being network-bound: **verify+merge (~12 s, 10k
secp256k1 recoveries ≈ 1.2 ms each) and the checkpoint payload (bitswap ~9 s, bandwidth-bound)
dominate**, while the flat network terms (router, connect, fetch) stay ~1–2 s. Below ~1000 voters a board
is network-bound (~3–5.5 s); a hot board is verify/payload-bound. Recovery parallelism (web workers) is
the lever there. Seeding 10k bundles required draining the seeder between feeders (it verifies each
bundle synchronously, so an un-drained backlog starves gossipsub mesh formation) — a benchmark-harness
detail, not a client cost.*

**Change since the previous baseline (background chain verification + the mock ETH gateway).** Two
things changed at once: the joiner's gate reads became *real* (270 ms per RPC round trip through a
default-config viem client against [rpc-gateway.ts](./rpc-gateway.ts) — previously an instant in-process
fake, ~0 ms, so the old numbers had **zero** chain-read cost), and the chase stopped verifying them
inline — bundles admit on the offline checks and the background verifier batches the deferred gate reads
per bucket sample block via multicall3 `aggregate3` (DESIGN.md "Background chain verification").
Measured effect: despite the new 270 ms-per-round-trip chain cost, `START→TALLY` *fell* at every N
(`3.88s → 3.43s` at N=1; `4.07s → 3.14s` at N=100; `5.64s → 5.48s` at N=1000), and the verified tally
costs only **one extra RPC round trip after render** (`+0.25–0.31s` at N ≤ 100) — at N=1000 the batched
reads (37 parallel multicall chunks, viem's default 1,024-byte calldata chunking) finish while later
checkpoint chunks are still merging, so `START→VERIFIED == START→TALLY`. For scale: verifying those
1000 wallets inline and serially — what the old chase did, invisibly, against the free fake chain —
would cost 1000 × 270 ms ≈ **270 s** of gate reads before the first tally; the batched background path
pays **38** round trips, off the render path entirely.

### Signature verification cost (isolated microbenchmark)

Per-bundle EIP-712 signature recovery (`verifyBundleSignature` → viem `recoverTypedDataAddress`, pure-JS
secp256k1), isolated from chain reads and merge, single-threaded on the joiner:

| | |
|---|---|
| per signature | **1.12 ms** (~900/s, single-threaded) |
| 100 voters | ~0.11 s |
| 1,000 voters | ~1.1 s |
| 10,000 voters | ~11 s |

This is the floor under the `verify+merge` column above (the extra there is bundle decode + LWW merge).
**v1 expectation: ≤ ~1,000 voters per contest**, so per-contest signature verify is **≤ ~1.1 s** — not a
bottleneck at v1 sizes. It is embarrassingly parallel (web workers) and runs synchronously before admit
(the chase's offline stage); the chain reads it used to be lumped with are deferred and batched instead
(DESIGN.md "Background chain verification"). It becomes a visible cost only on much larger boards
(10k+ voters ≈ 11 s single-threaded).

### Fetch sub-phase split (median of 5)

The root-record fetch was instrumented into its two RTT-bound sub-phases — the `connection.newStream`
multistream-select negotiation vs the request write→response read — to find where its ~0.4–0.6 s goes:

| N (voters) | fetch | negotiate (mss) | write→read |
|-----------:|------:|----------------:|-----------:|
| 1          | 0.53s | 0.35s           | 0.18s      |
| 5          | 0.54s | 0.35s           | 0.18s      |
| 10         | 0.49s | 0.30s           | 0.18s      |
| 100        | 0.52s | 0.35s           | 0.18s      |
| 1000       | 0.53s | 0.35s           | 0.18s      |

**The multistream-select negotiation (~0.2–0.4 s, ~1–2 RTT) dominates the fetch, not the actual
request/response (~0.2 s, ~1 RTT).** This is the `mss.select` handshake `connection.newStream` runs
before the fetch stream is usable. libp2p exposes an optimistic 0-RTT path (`newStream({
negotiateFully: false })`) that would cut ~1 RTT here, but it is a **no-op in the host's pinned stack**
(libp2p `3.3.4` + yamux `8.0.1`): yamux ignores the early single-protocol hint, so full negotiation
always runs, and libp2p 3.3.4 never consumes `negotiateFully`. Since this library only *receives* the
host's running node and does not build its muxer, this round-trip cannot be removed here — it needs a
host muxer/libp2p upgrade and is tracked as deferred pkc-js work (DESIGN.md, "Deferred pkc-js work").

### What each column is

| Column | Operation |
|---|---|
| `router` | HTTP content-router lookup for the criteria CID — find who runs the contest (simulated ~1 s, paid once). |
| `connect` | Dial the named provider + noise/yamux/identify handshake (from `start()`, so it includes the 1 s router wait). |
| `fetch` | Pull the tiny root record over the libp2p **fetch** protocol. |
| `bitswap` | Pull the checkpoint chunk blocks over directed **bitswap** — **one** round-trip, since the chunk-CID index rides the fetch response (chunks pulled in parallel, root manifest skipped). |
| `verify+merge` | Recover every ballot's EIP-712 signature offline, LWW-merge into the winner-set (residual: tally-ready minus the last network op; the deferred gate reads run in the background and do not block it). |
| `gate-RPC` | HTTP round trips to the mock ETH gateway during the join — the head read plus the background verifier's batched gate reads (multicall3 `aggregate3` chunks, sent in parallel). |
| `START→TALLY` | End-to-end to render-ready: `start()` → `getTally()` reflects all `N` voters (rows may still be `chainVerified: false`). |
| `START→VERIFIED` | End-to-end to trust-ready: the ranking row reads `chainVerified: true` (every deferred gate read landed). |

### Reading the numbers

- **Cold join renders in ~3.0–3.4 s for a small contest and ~5.5 s at 1000 voters** over a real
  intercontinental link, and **chain-verifies one RPC round trip later (~+0.3 s at N ≤ 100, +0 s at
  N=1000)**. Small-`N` joins are network-bound and flat; at 1000 the per-voter offline verify work
  starts to dominate.
- **The gate reads never gate the render.** `gate-RPC` grows with distinct wallets (2 round trips at
  N ≤ 10, 5 at N=100, 38 at N=1000 — viem chunks one logical multicall into parallel ~1 KB `aggregate3`
  posts) but runs in the background; unbatched-and-serial the N=1000 reads alone would be ~270 s.
- **The router is not the bottleneck** — a fixed 1 s, paid once. The remaining cost is RTT-bound
  steps: the connection **handshake (~1.6 s)**, the root-record **fetch (~0.4–0.6 s)**, and **bitswap
  (~0.6–1.0 s, one block round-trip)**. WAN jitter is real at this RTT — individual repeats still
  spike (a single N=1 fetch hit 1.5 s), which is why this baseline takes the median of 5.
- **bitswap is one round-trip, not two** (the chunk-index piggyback), so it is no longer the
  dominant small-contest lever. The remaining avoidable network cost is the **fetch's
  multistream-select negotiation** (~1–2 RTT of its ~0.4–0.6 s — see the sub-phase table), but removing
  it needs a host muxer/libp2p change, not a library change.
- **verify+merge scales with `N`** as expected (~0.3 s flat floor → ~2.1 s at 1000: signature
  recoveries plus decode/merge, all offline) and is the dominant term only at 1000.

## For contrast

- **Loopback floor (~0 ms RTT):** the same cold join runs in **~1.1 s** (dominated by the simulated
  1 s router latency). The ~3.0–5.5 s WAN figure is almost entirely round-trip cost — exactly what
  loopback would have hidden.
- **Instant-fake chain, inline chase verification (superseded, the previous baseline):** gate reads
  cost ~0 ms and ran inline in the chase, so `START→TALLY` (3.6–4.1 s small-N, 5.6 s at N=1000) was
  the only milestone and silently assumed free chain reads. The current baseline pays a realistic
  270 ms per RPC round trip and still renders *faster*, because the reads moved off the render path
  and batch via multicall3.
- **Two-round-trip bitswap (superseded, the previous baseline):** before the chunk-index piggyback,
  the checkpoint pull fetched the root manifest and then its chunks sequentially (**bitswap
  1.7–3.7 s**, **START→TALLY 4.6–8.7 s**). Carrying the chunk index on the fetch response collapsed
  that to one round-trip.
- **SSH-tunnelled data path (superseded):** an earlier run carried the joiner→seeder link through an
  SSH port-forward. TCP-over-TCP inflated every step (**8.3–11.2 s** end-to-end, bitswap up to ~6 s);
  dialing the public IP directly removed that artifact and roughly halved the small-`N` numbers.
- **Previous discovery (gossipsub `getSubscribers` only, before HTTP-router discovery):** a fresh
  join waited for subscription gossip to propagate (~5 s over the WAN link) before it could even
  start fetching, for **~11–16 s** end-to-end. HTTP-router discovery replaces that ~5 s wait with the
  1 s router lookup.

---

# Directory cold-load — many contests, one shared seeder

**What this measures:** a **5chan.app-style cold load** — a fresh peer with no data joins `M` contest
leaderboards **at once**, every one provided by the SAME shared seeder (the bitsocial-seeder pattern),
and waits until EVERY contest has a usable tally. Where the single-contest benchmark above measures
one board, this measures what happens when a directory of boards loads together over **one reused
connection**. Same rig: seeder on the ~270 ms-RTT WAN host, joiner local, dialed directly (no tunnel),
chain reads through the mock ETH gateway (270 ms per RPC round trip). Two end-to-end milestones,
mirroring the single-contest bench: **START→ALL-TALLIES** (render-ready — every board's tally
reflects all `N` voters; rows may still read `chainVerified: false`) and **START→ALL-VERIFIED**
(trust-ready — every board's ranking row reads `chainVerified: true`, i.e. every deferred gate
read landed). `N` is voters **per contest**; every contest is a distinct synthetic criteria doc
(distinct CID/topic) that inherits the `/biz/` gate — the real 5chan directory is **63 contests**
(`5chan-directory-criteria.jsonc`).

Each voter is one wallet signing one **single-vote** bundle (the `/biz/` gate is `maxVotesPerAddress:
1`, `voteSchema: {min:1,max:1}`), so **N voters = N bundles = tally weight N** (1:1:1). The bundle
counts below are therefore just the per-contest voter counts. Network cost is flat in `N`; only
verify+merge and the checkpoint payload scale with it — the per-board scaling up to a realistic hot
board (10k voters) is the single-contest table above.

Run it: `BENCH_HOST=<ssh-host> npm run bench:directory-load` (sweeps `BENCH_MS` contests × `BENCH_N`
voters/contest — either can be a comma list). The joiner takes `BENCH_JOIN_CONCURRENCY` (sliding-window
batch size) and `BENCH_JOIN_TIMEOUT_MS`; the seeder takes `BENCH_SEED_CONCURRENCY`.

## Per-operation latency (N=10 voters/contest, median of 5)

All `M` contests are joined at once (naive), over one shared connection. `router`/`connect`/`identify`
are paid a single time across the whole directory; `fetch`/`bitswap` are shown **per contest** (the
cost of one board's op — they overlap, so they do NOT sum to the total); `verify+merge` is the
aggregate and `START→ALL-TALLIES` is the true wall-clock to every board being ready.

| M (contests) | router | connect | identify | fetch/ct | bitswap/ct | verify+merge | **START→ALL-TALLIES** | **START→ALL-VERIFIED** |
|-------------:|-------:|--------:|---------:|---------:|-----------:|-------------:|----------------------:|-----------------------:|
| | *(amortized once)* | *(once)* | *(once)* | *(per contest)* | *(per contest)* | *(aggregate)* | *(wall-clock)* | *(wall-clock)* |
| 1            | 1.00s  | 1.62s   | 2.02s    | 0.58s    | 0.64s      | 0.40s        | **3.26s** | **3.51s** |
| 10           | 1.00s  | 0.60s   | 0.98s    | 0.74s    | 0.93s      | 0.25s        | **2.76s** | **3.26s** |
| **63**       | 1.00s  | 0.60s   | 0.99s    | 0.53s    | 0.99s      | 0.43s        | **4.17s** | **4.42s** |

*Measured 2026-07-11 (persistent gate-result/name-resolution caches landed — the bench passes
`dataPath: false`, so joins stay genuinely cold and the render path is unchanged; the new
START→ALL-VERIFIED column is the directory trust-ready milestone, landing **+0.25–0.5s after
render** at every M. The 2026-07-10 baseline — voter-wide per-peer cold-start fetch budget +
shuffled subscriber selection, see DESIGN.md "Checkpoints → pull" — read 3.26s / 2.51s / 3.87s
ALL-TALLIES respectively; this run's deltas are within this link's rep-to-rep jitter (M=63 reps
spanned 3.69–5.92s). The 2026-07-09 retry-only baseline read 3.26s / 2.33s / 5.04s.)*

## Parallelism + convergence (N=10 voters/contest, median of 5)

`Σfetch`/`Σbitswap` are the sum across the `M` concurrent ops (not wall-clock); `conv-p50`/`conv-p90`
are the convergence curve — when the median / 90th-percentile board's tally became ready — so a
directory that fills in progressively is visible.

| M (contests) | conns | converged | fetches | Σfetch | Σbitswap | payload | conv-p50 | conv-p90 | **START→ALL** |
|-------------:|------:|:---------:|--------:|-------:|---------:|--------:|---------:|---------:|--------------:|
| 1            | 1     | 1/1       | 1       | 0.58s  | 0.64s    | 4 KiB   | 3.26s    | 3.26s    | **3.26s** |
| 10           | 1     | 10/10     | 10      | 7.38s  | 9.31s    | 43 KiB  | 2.76s    | 2.76s    | **2.76s** |
| **63**       | 1     | **63/63** | 63      | 33.37s | 62.28s   | 271 KiB | 3.43s    | 4.17s    | **4.17s** |

### Reading the numbers

- **The full 63-board directory cold-loads (render-ready) in ~4.2s and is trust-ready
  (all-verified) ~0.25s later**, converging 63/63; going 1→10→63 boards barely moves the
  wall-clock. `conns=1` at every `M` — all root-record fetches + checkpoint pulls ride one
  connection, so `connect`/`identify` are paid once and the per-board fetch/bitswap overlap.
- **`Σfetch`/`Σbitswap` grow with `M` but the total does not** — the ops run concurrently, so the sum
  of 63 overlapping fetches (33s) collapses to a ~4.2s wall-clock. The per-contest cost is flat
  (~0.53–0.74s fetch, ~0.6–1.0s bitswap) regardless of directory size.
- **Verify is negligible at N=10** (≤0.4s for up to 630 recoveries — all offline; the boards' gate
  reads batch in the background behind one shared gateway and never gate the convergence curve). It
  scales with total ballots (~1.5 ms/recovery single-threaded), so it becomes the dominant term only
  for a mature directory (hundreds of voters × 63 boards).
- Numbers taken against a **default** libp2p node (fetch handler `maxInboundStreams = 32`); the
  voter-wide per-peer fetch budget (≤24 concurrent per peer) keeps the naive all-at-once join under
  that cap with zero resets — the cold-start retry remains only as the safety net for streams the
  budget cannot see. WAN jitter is large at this RTT — individual reps spike (one M=1 rep hit 9.3s
  on a connect stall), hence median-of-5. See DESIGN.md ("Checkpoints → pull", "Deferred pkc-js
  work") for the budget, the retry, and the optional host-side stream-cap speedup.
