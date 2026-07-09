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
only to launch the remote seeder process.) Chain reads use an instant fake (the `erc721-min-balance`
gate passes for every wallet), so the numbers isolate peer-to-peer latency; a real chain RPC would add
its own round-trips on top at verify time.

**Discovery model:** peers are discovered via an **HTTP content router** (Delegated Routing V1, no
DHT — the pkc-js pattern), simulated locally with a **~1 s lookup latency paid once**; after that
bitswap's IWANT takes over peer-to-peer. `#coldStart` races this against `getSubscribers(topic)` and
fetches from whichever names a peer first.

Run it yourself: `BENCH_HOST=<ssh-host> npm run bench:cold-join` (see [run.mjs](./run.mjs)).

---

## Per-operation latency (seeder on a ~270 ms-RTT WAN host, cold joiner local, median of 5)

`N` is the number of **voters** (distinct wallets, one ballot each) in the contest's checkpoint. All
voters vote for one community, so the tally is one community of weight `N`.

| N (voters) | router | connect | fetch | bitswap | verify+merge | **START→TALLY** |
|-----------:|-------:|--------:|------:|--------:|-------------:|----------------:|
| 1          | 1.00s  | 1.92s   | 0.90s | 0.93s   | 0.03s        | **3.88s**       |
| 5          | 1.00s  | 1.93s   | 0.86s | 0.98s   | 0.04s        | **3.91s**       |
| 10         | 1.00s  | 1.85s   | 0.84s | 0.87s   | 0.05s        | **3.58s**       |
| 100        | 1.00s  | 1.92s   | 0.91s | 1.33s   | 0.19s        | **4.07s**       |
| 1000       | 1.00s  | 1.87s   | 0.83s | 1.53s   | 1.45s        | **5.64s**       |
| 10000†     | 1.00s  | 1.59s   | 1.98s | 9.17s   | 12.35s       | **18.95s**      |

*Measured 2026-07-08 (direct public dial, no SSH tunnel; **median of 5** — WAN jitter at this RTT is
large enough that 3 repeats gave unstable per-op medians, so this baseline uses 5). Columns are
wall-clock timings of each operation but they **overlap** and do not sum to the total — `connect` is
measured from the `start()` call and already contains the 1 s router wait, and verify runs as blocks
arrive. `START→TALLY` is the true end-to-end figure.*

*†The `N=10000` row (median of 3, one rep timed out on WAN jitter) is a separate, later single-contest
run — a realistic **hot board**: 10,000 distinct voters, each a single-vote bundle, so a 10k-weight
tally over a ~2.3 MB checkpoint. It is the point where the load stops being network-bound: **verify+merge
(~12 s, 10k secp256k1 recoveries ≈ 1.2 ms each) and the checkpoint payload (bitswap ~9 s, bandwidth-bound)
dominate**, while the flat network terms (router, connect, fetch) stay ~1–2 s. Below ~1000 voters a board
is network-bound (~4–6 s); a hot board is verify/payload-bound. Recovery parallelism (web workers) or
rendering from the seeder checkpoint first and verifying lazily are the levers there. Seeding 10k bundles
required draining the seeder between feeders (it verifies each bundle synchronously, so an un-drained
backlog starves gossipsub mesh formation) — a benchmark-harness detail, not a client cost.*

**Change since the previous baseline (bitswap chunk-index piggyback).** The checkpoint block pull now
costs **one** directed-bitswap round-trip instead of two. The fetch-protocol root record carries the
checkpoint's **chunk-CID index** (`FetchRootRecord.chunks`), which the joiner verifies against the
root locally and uses to pull every chunk **in parallel** — skipping the root-manifest fetch that
previously had to complete first just to learn the chunk CIDs (see DESIGN.md "The root record",
"Block pull"). `bitswap` roughly halved (e.g. `1.72s → 0.93s` at N=1, `3.72s → 1.33s` at N=100), and
`START→TALLY` fell at every N (`4.59s → 3.88s` at N=1; `8.35s → 4.07s` at N=100; `8.71s → 5.64s` at
N=1000). At N=1000 the bitswap column is dominated by the ~235 KB payload transfer (one chunk), which
is bandwidth/jitter-bound, so removing one round-trip helps less there in relative terms.

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
bottleneck at v1 sizes. It is embarrassingly parallel (web workers) and the tally verifies lazily
top-down (only enough to lock the ranking), so both the wall-clock and the count verified are typically
lower; it becomes a visible cost only on much larger boards (10k+ voters ≈ 11 s single-threaded).

### Fetch sub-phase split (median of 5)

The root-record fetch was instrumented into its two RTT-bound sub-phases — the `connection.newStream`
multistream-select negotiation vs the request write→response read — to find where its ~0.9 s goes:

| N (voters) | fetch | negotiate (mss) | write→read |
|-----------:|------:|----------------:|-----------:|
| 1          | 0.90s | 0.60s           | 0.32s      |
| 5          | 0.86s | 0.56s           | 0.31s      |
| 10         | 0.84s | 0.56s           | 0.28s      |
| 100        | 0.91s | 0.59s           | 0.28s      |
| 1000       | 0.83s | 0.54s           | 0.28s      |

**The multistream-select negotiation (~0.55 s, ~2 RTT) dominates the fetch, not the actual
request/response (~0.3 s, ~1 RTT).** This is the `mss.select` handshake `connection.newStream` runs
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
| `verify+merge` | Recover every ballot's EIP-712 signature, run the gate, LWW-merge into the winner-set. |
| `START→TALLY` | End-to-end: `start()` → `getTally()` reflects all `N` voters. |

### Reading the numbers

- **Cold join is ~3.6–4.1 s for a small contest and ~5.6 s at 1000 voters** over a real
  intercontinental link. Small-`N` joins are network-bound and flat (~3.6–4.1 s); at 1000 the
  per-voter verify work starts to dominate.
- **The router is not the bottleneck** — a fixed 1 s, paid once. The remaining cost is RTT-bound
  steps: the connection **handshake (~1.9 s)**, the root-record **fetch (~0.9 s)**, and **bitswap
  (~0.9–1.5 s, now one block round-trip)**. WAN jitter is real at this RTT — individual repeats still
  spike (a single N=1000 bitswap hit 4.5 s), which is why this baseline takes the median of 5.
- **bitswap is now one round-trip, not two** (the chunk-index piggyback above), so it is no longer the
  dominant small-contest lever. The remaining avoidable network cost is the **fetch's
  multistream-select negotiation** (~2 RTT of its ~0.9 s — see the sub-phase table), but removing it
  needs a host muxer/libp2p change, not a library change.
- **verify scales with `N`** as expected (0.03 s → ~1.45 s for 1000 signature recoveries) and is the
  dominant term only at 1000.

## For contrast

- **Loopback floor (~0 ms RTT):** the same cold join runs in **~1.1 s** (dominated by the simulated
  1 s router latency). The ~3.6–5.6 s WAN figure is almost entirely round-trip cost — exactly what
  loopback would have hidden.
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
fake-instant chain. `N` is voters **per contest**; every contest is a distinct synthetic criteria doc
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

| M (contests) | router | connect | identify | fetch/ct | bitswap/ct | verify+merge | **START→ALL-TALLIES** |
|-------------:|-------:|--------:|---------:|---------:|-----------:|-------------:|----------------------:|
| | *(amortized once)* | *(once)* | *(once)* | *(per contest)* | *(per contest)* | *(aggregate)* | *(wall-clock)* |
| 1            | 1.00s  | 2.02s   | 3.01s    | 1.12s    | 1.36s      | 0.12s        | **5.76s** |
| 10           | 1.00s  | 0.88s   | 1.45s    | 0.89s    | 0.95s      | 0.17s        | **3.26s** |
| **63**       | 1.00s  | 0.87s   | 1.42s    | 0.81s    | 1.41s      | 0.20s        | **5.45s** |

## Parallelism + convergence (N=10 voters/contest, median of 5)

`Σfetch`/`Σbitswap` are the sum across the `M` concurrent ops (not wall-clock); `conv-p50`/`conv-p90`
are the convergence curve — when the median / 90th-percentile board's tally became ready — so a
directory that fills in progressively is visible.

| M (contests) | conns | converged | fetches | Σfetch | Σbitswap | payload | conv-p50 | conv-p90 | **START→ALL** |
|-------------:|------:|:---------:|--------:|-------:|---------:|--------:|---------:|---------:|--------------:|
| 1            | 1     | 1/1       | 1       | 0.92s  | 0.98s    | 4 KiB   | 4.77s    | 4.77s    | **5.76s** |
| 10           | 1     | 10/10     | 10      | 8.95s  | 9.46s    | 43 KiB  | 2.79s    | 3.26s    | **3.26s** |
| **63**       | 1     | **63/63** | 63      | 51.23s | 88.82s   | 271 KiB | 3.50s    | 4.84s    | **5.45s** |

### Reading the numbers

- **The full 63-board directory cold-loads in ~5.5s** and converges 63/63; going 1→10→63 boards barely
  moves the wall-clock. `conns=1` at every `M` — all root-record fetches + checkpoint pulls ride one
  connection, so `connect`/`identify` are paid once and the per-board fetch/bitswap overlap.
- **`Σfetch`/`Σbitswap` grow with `M` but the total does not** — the ops run concurrently, so the sum
  of 63 overlapping fetches (51s) collapses to a ~5.5s wall-clock. The per-contest cost is flat
  (~0.8–1.4s fetch, ~1–1.4s bitswap) regardless of directory size.
- **Verify is negligible at N=10** (≤0.2s for up to 630 recoveries). It scales with total ballots
  (~1.5 ms/recovery single-threaded), so it becomes the dominant term only for a mature directory
  (hundreds of voters × 63 boards).
- Numbers taken against a **default** libp2p node (fetch handler `maxInboundStreams = 32`); the
  cold-start fetch retry rides out that cap so the naive all-at-once join converges fully. WAN jitter
  is large at this RTT — individual reps spike (one M=63 rep hit 21s), hence median-of-5. See DESIGN.md
  ("Checkpoints → pull", "Deferred pkc-js work") for why the naive join needs the retry and the
  optional host-side stream-cap speedup.
