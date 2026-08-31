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

**The table is the 2026-08-09 run** (the head-first gate); the dated notes under it are the
re-measurement history, oldest first, and quote the numbers current *at their own date*.

`N` is the number of **voters** (distinct wallets, one ballot each) in the contest's checkpoint. All
voters vote for one community, so the tally is one community of weight `N`.

| N (voters) | router | connect | fetch | bitswap | verify+merge | gate-RPC | **START→TALLY** | **START→VERIFIED** |
|-----------:|-------:|--------:|------:|--------:|-------------:|---------:|----------------:|-------------------:|
| 1          | 1.00s  | 1.56s   | 0.49s | 0.00s   | 0.31s        | 3        | **2.42s**       | **3.02s**          |
| 5          | 1.00s  | 1.59s   | 0.53s | 0.00s   | 0.32s        | 3        | **2.49s**       | **3.09s**          |
| 10         | 1.00s  | 1.56s   | 0.51s | 0.00s   | 0.33s        | 3        | **2.45s**       | **3.05s**          |
| 100        | 1.00s  | 1.56s   | 0.68s | 0.00s   | 0.48s        | 3        | **2.76s**       | **3.37s**          |
| 1000       | 1.00s  | 1.56s   | 1.14s | 0.02s   | 2.05s        | 9        | **4.89s**       | **6.16s**          |
| 10000†     | 1.00s  | 1.59s   | 1.98s | 9.17s   | 12.35s       | —        | **18.95s**      | —                  |

*Historical — the first baseline of this rig. Measured 2026-07-12 (direct public dial, no SSH tunnel; **median of 5** — WAN jitter at this RTT is
large enough that 3 repeats gave unstable per-op medians, so this baseline uses 5). This run's
provider records were **announced by the seeder for real** (`httpRouterUrls` → `ssh -R`-tunneled
router), not hardcoded; every column matched the 2026-07-09 hardcoded-record baseline within jitter
(e.g. `START→TALLY` 3.43s → 3.08s at N=1, 5.48s → 5.38s at N=1000), confirming announcing is
seeder-side only. Columns are wall-clock timings of each operation but they **overlap** and do not
sum to the total — `connect` is measured from the `start()` call and already contains the 1 s router
wait, and verify runs as blocks arrive. `START→TALLY` / `START→VERIFIED` are the true end-to-end
figures.*

*Re-measured 2026-07-14 (median of 5) with the **advertiser-seeded bitswap session chase** (DESIGN.md
"Block pull" — targeted session wants at the advertisers, one router provider-query per root instead
of one `findProviders` per block): every column matched this baseline within jitter (`START→TALLY`
3.19s / 3.07s / 3.07s / 3.17s / 5.30s for N=1…1000 vs 3.08s / 3.00s / 2.94s / 3.11s / 5.38s above;
`bitswap` 0.57–1.05s, `verify+merge` 0.31–1.99s). The change's win is off-column: router queries and
per-peer WANT chatter, not wall-clock. The joiner instrumentation now wraps `blockstore.createSession`
so the `bitswap` column times the session pull (which bypasses the plain instrumented `get`).*

*Re-measured 2026-07-15 (median of 5; the table above carried these numbers until the 2026-08-07 re-measure below) with the **rate-limit-safe batched gate reads**
(the rule chunks 200 `balanceOf`s per `aggregate3` with viem re-chunking off, ≤2 round trips in flight,
and the voter-level read coalescer merges every consumer's pinned reads — DESIGN.md "Background chain
verification"): every column is within jitter of the 2026-07-14 numbers except the read pattern itself —
`gate-RPC` fell from 5 to **2** at N=100 and from 38 to **7** at N=1000 (fewer, bigger multicalls), and
`START→VERIFIED` at N=1000 rose 5.44s → **5.87s** because the 5 chunks now flush in ≤2-in-flight waves
instead of 38 concurrent posts — the polite-read policy's designed trade against free public endpoints
(the same policy that takes the REAL Base mainnet N=1000 join from never-verifying to 8.2s — see "Real
chain" below).*

*Re-measured 2026-07-16 (median of 3) with **checkpoint-snapshot persistence** (DESIGN.md "Persistent
caches", checkpoint snapshots — the cold joiner runs `dataPath: false`, so its join path gains only an
awaited snapshot-store miss) and the **`subscription-change` cold-start re-pull** (issue #15 — not on
this bench's measured path, the joiner discovers via the router first and the pull's seen-set dedups):
every column matched this baseline within jitter (`START→TALLY` 3.07s / 3.11s / 3.13s / 3.27s / 5.30s
for N=1…1000 vs 3.08s / 3.12s / 3.06s / 3.19s / 5.25s above; `verify+merge` 1.99s at N=1000 vs 2.06s).
An earlier same-day run had shown `verify+merge` ~4.1–4.3s — but so did an N=1000 **control run on
master** (7.52s/8.21s totals, identical columns), and the later idle-rig run above returned to
baseline: local CPU conditions, not the changes. The restart path itself is measured separately — see
"Warm restart" below.*

*Re-measured 2026-08-07 (median of 5, the table above) with the **ERC-5192 gate** (`erc5192-min-balance`
replacing `erc721-min-balance` — DESIGN.md "Does one Pass mean one vote?"). The gate's cost is one extra
`supportsInterface(0xb45a3c0e)` inner read per (contract, sample block), hoisted out of the per-wallet
reads and issued in parallel with the balances so the coalescer folds it into the same `aggregate3`:
`reads` is exactly **N+1** at every N (2 / 6 / 11 / 101 / 1001), and round trips are **unchanged at
N ≤ 100** (still 2). At **N=1000 it costs one extra round trip** — 1000 reads is exactly 5 chunks of
200, and the 1001st opens a 6th (`gate-RPC` 7 → 8), which is most of the `START→VERIFIED` 5.87s → 6.35s
move. The rest of the table shifted for reasons that predate this change and had never been
re-measured here: `bitswap` fell to **0.00s** at every N while `fetch` at N=1000 rose 0.56s → 1.85s
(write→read 0.18s → 1.48s), consistent with 0.1.5 carrying the whole cold pull inline in the bulk fetch
answer — the payload moved from bitswap into fetch rather than getting cheaper — and small-N
`START→TALLY` improved ~0.3–0.5s (3.08s → 2.64s at N=1). Not bisected; only the read-count and
chunk-boundary effects above are attributable to the gate change.*

*Re-measured 2026-08-09 (median of 5, the table above) with the **head-first gate** — the rule reads
the chain head first and falls back to the ballot's pinned block (DESIGN.md "What a rule owns, and what
the pipeline owns"). The attributable cost is **one extra RPC round trip, entirely after render**:
`gate-RPC` goes 2 → 3 at N ≤ 100 and 8 → 9 at N=1000, and the `START→VERIFIED` − `START→TALLY` gap
doubles from **+0.30s to +0.60s** at N ≤ 100 (exactly two 270 ms charges instead of one). Inner `reads`
is unchanged at **N+1** (2 / 6 / 11 / 101 / 1001), so this is a round trip, not extra reads.

*Re-measured 2026-08-31 (median of 3) on the **helia 7 host stack** (pkc-js `0.0.89`'s pins: `helia
7.1.10`, `@libp2p/gossipsub 17.0.1`, `libp2p 3.3.9`; the bench nodes now compose
`withBitswap(withLibp2pLight(createHeliaLight(), …))`, and the joiner registers the router through
v9's `delegatedRoutingV1HttpApiClientContentRouting` — in client v9 the bare service factory no
longer carries the libp2p content-routing capability): every column matched a back-to-back
**master control** on the same link window within jitter — `START→TALLY` 3.19s / 3.26s / 3.16s /
3.30s / 6.15s for N=1…1000 vs control 3.45s (N=1) and 5.81s (N=1000); `START→VERIFIED` 3.80s vs
4.05s at N=1, 7.44s vs 7.13s at N=1000; `connect` 1.95s vs 1.93s and `fetch` 0.88s vs 1.16s at
N=1. Both runs sat ~0.4s above the table's `connect` 1.56s — the control pins that on the link
window, not the upgrade. `gate-RPC` (3 / 9), inner `reads` (N+1), `bitswap` (0.00–0.02s) and
`verify+merge` (0.30–1.99s) are unchanged.*

The extra trip is **not** the head read (`head` stays 1 at N ≤ 100, 3 at N=1000): it is `multicall`
going 1 → 2, because the ERC-5192 lock probe is no longer folded into the same `aggregate3` as the
balances. `scoreAt` awaits the probe before issuing the balance batch — its answer decides whether the
balances are read at all — so the probe is still hoisted to one read per (contract, epoch) across a
whole checkpoint's wallets, but it now costs its own round trip rather than riding along. Re-folding it
(issue the probe concurrently and discard the balances if the contract does not declare) would return
`gate-RPC` to 2 at N ≤ 100; not done here.

`START→TALLY` improved at every N (2.64s → 2.42s at N=1, 5.73s → 4.89s at N=1000). That is **not
attributable to this change** — nothing in it touches the pull path — and tracks a uniformly quieter
network on the day: `connect` fell ~0.13s at every N (1.68s → 1.56s at N=1) and `fetch` at N=1000 fell
1.85s → 1.14s (write→read 1.48s → 0.84s), which is also what pulls `START→VERIFIED` at N=1000 down
(6.35s → 6.16s) despite the extra round trip.*

*Re-measured 2026-08-18 (median of 3) with **signed provider records** (the announcer now PUTs an
IPIP-0526 `Signature` + `Payload.Timestamp`; the bench router refuses a record without them). The
announce is seeder-side and out-of-band of the measured join path, and every column matched the table
within jitter: `START→TALLY` 2.46s / 2.48s / 2.48s / 2.66s / 4.80s and `START→VERIFIED` 3.07s / 3.09s /
3.09s / 3.27s / 6.08s for N=1…1000, with `router` 1.00s, `connect` 1.58–1.59s, `fetch` 0.51–1.09s and
`gate-RPC` 3 / 3 / 3 / 3 / 9 unchanged. The table above is left at the 2026-08-09 numbers.*

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
| 1          | 0.49s | 0.31s           | 0.18s      |
| 5          | 0.53s | 0.32s           | 0.18s      |
| 10         | 0.51s | 0.33s           | 0.18s      |
| 100        | 0.68s | 0.32s           | 0.37s      |
| 1000       | 1.14s | 0.31s           | 0.84s      |

**At N ≤ 100 the multistream-select negotiation (~0.3 s, ~1–2 RTT) dominates the fetch, not the
actual request/response (~0.2 s, ~1 RTT).** (At N=1000 it no longer does — the bulk answer now
carries the checkpoint blocks inline, so write→read is payload-bound at ~0.8 s while negotiation
stays flat at ~0.3 s. The negotiation cost below is the *flat* term, and it is what dominates every
small contest.) This is the `mss.select` handshake `connection.newStream` runs
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
| `bitswap` | Pull the checkpoint chunk blocks over directed **bitswap** — **one** round-trip, since the chunk-CID index rides the fetch response (chunks pulled in parallel, root manifest skipped). **0.00s in the current table**: the bulk fetch answer now inlines the blocks themselves, so a cold join that gets a bulk answer skips bitswap entirely and that payload time appears under `fetch` instead. |
| `verify+merge` | Recover every ballot's EIP-712 signature offline, LWW-merge into the winner-set (residual: tally-ready minus the last network op; the deferred gate reads run in the background and do not block it). |
| `gate-RPC` | HTTP round trips to the mock ETH gateway during the join — the head read plus the background verifier's batched gate reads (multicall3 `aggregate3` chunks, sent in parallel). The batch carries `N` `balanceOf`s **plus one** `supportsInterface(0xb45a3c0e)` for the gate contract, deduped across all wallets at that block. |
| `START→TALLY` | End-to-end to render-ready: `start()` → `getTally()` reflects all `N` voters (rows may still be `chainVerified: false`). |
| `START→VERIFIED` | End-to-end to trust-ready: the ranking row reads `chainVerified: true` (every deferred gate read landed). |

### Reading the numbers

- **Cold join renders in ~2.4–2.8 s for a small contest and ~4.9 s at 1000 voters** over a real
  intercontinental link, and **chain-verifies two RPC round trips later (~+0.6 s at N ≤ 100, +1.3 s at
  N=1000)**. Small-`N` joins are network-bound and flat; at 1000 the per-voter offline verify work
  starts to dominate.
- **The gate reads never gate the render.** `gate-RPC` grows with distinct wallets (3 round trips at
  N ≤ 100 — one head read plus the lock probe and the balance `aggregate3` — and 9 at N=1000, where
  1001 reads are 6 chunks of ≤200) but runs in the background; unbatched-and-serial the N=1000 reads
  alone would be ~270 s.
- **The router is not the bottleneck** — a fixed 1 s, paid once. The remaining cost is RTT-bound
  steps: the connection **handshake (~1.6 s)** and the root-record **fetch (~0.5–1.1 s)**. WAN jitter
  is real at this RTT — individual repeats still spike (a single N=5 join hit 5.45 s against a 2.49 s
  median), which is why this baseline takes the median of 5.
- **bitswap is 0.00 s at N ≤ 100** — the bulk fetch answer carries the checkpoint blocks inline, so
  the payload moved into `fetch` rather than costing a separate round trip. The remaining avoidable
  network cost is the **fetch's multistream-select negotiation** (~1–2 RTT, a flat ~0.3 s — see the
  sub-phase table), but removing it needs a host muxer/libp2p change, not a library change.
- **verify+merge scales with `N`** as expected (~0.3 s flat floor → ~2.1 s at 1000: signature
  recoveries plus decode/merge, all offline) and is the dominant term only at 1000.

## For contrast

- **Loopback floor (~0 ms RTT):** the same cold join runs in **~1.1 s** (dominated by the simulated
  1 s router latency). The ~2.4–4.9 s WAN figure is almost entirely round-trip cost — exactly what
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

# Warm restart — checkpoint-snapshot reload, no peers online

**What this measures:** the issue-#14 incident path — a seeder holding `N` verified votes restarts
while **no other peer is online** (zero subscribers, zero providers), and recovers its tally from
the checkpoint snapshot persisted under `dataPath`. All-local (there is nothing remote to measure);
the restart session's chain client counts gate reads (`readContract`), which must be 0 — the
background re-verification of the restored bundles is served entirely by the persisted gate-result
store.

Run it yourself: `npm run bench:warm-restart` (see [warm-restart.ts](./warm-restart.ts)).

## Restart-session latency (measured 2026-07-16)

| N (voters) | snapshot size | START→TALLY | START→VERIFIED | gate-RPC round trips |
|-----------:|--------------:|------------:|---------------:|---------------------:|
| 1          | 421 B         | **0.01s**   | 0.01s          | 0                     |
| 100        | 22 KB         | **0.33s**   | 0.38s          | 0                     |
| 1000       | 220 KB        | **2.96s**   | 3.01s          | 0                     |

*`START→TALLY` is `update()` → the tally showing all `N` restored voters; `START→VERIFIED` adds the
background settlement of every restored row's `chainVerified` flag. The N=1000 figure is dominated
by re-running the offline secp256k1 signature checks on reload (the same ~2–3 s the cold-join
table's verify+merge column pays at that N). Before snapshot persistence this scenario returned an
EMPTY tally: recovery depended on some other peer re-advertising its checkpoint within the
heartbeat window (10 min ±25%), and with no peer online the votes were simply gone.*

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
([`5chan-directory-criteria.jsonc`](https://github.com/bitsocialnet/lists/blob/master/5chan-directory-criteria.jsonc)).

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

*Re-measured 2026-07-14 with the **advertiser-seeded bitswap session chase** (DESIGN.md "Block
pull"): ALL-TALLIES 3.26s / 2.56s / 3.66s (median of 3) — M=63 within-to-below this baseline, all
63/63 converged. A later median-of-5 A/B on the same day hit a degraded window on this link (M=63
reps spanned 4.3–12.0s); a back-to-back master control confirmed it was the link, not the change
(master 6.70s vs sessions 6.07s median under identical conditions).*

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

---

# Real chain — Base mainnet, production conditions

**What this measures:** the same two benches run against the **real chain** instead of the mock ETH
gateway: `BENCH_RPC_URL=https://mainnet.base.org npm run bench:cold-join` (and
`bench:directory-load`). Real head, ballots signed at the **real bucket sample block** (up to
`blocksPerBucket` = 43,200 blocks ≈ 24 h behind head — the endpoint must serve historical state at
that depth; `mainnet.base.org` does, publicnode's free tier refuses), real multicall3, real
(**measured**, not simulated) RPC latency, and the endpoint's **real rate limiting**. The gate
contract is a real deployed ERC-721 on Base ("Base Day One" — the 5chan Pass is not deployed yet);
a probe rule shadows `erc5192-min-balance` through the supported `rules` override, performing the
builtin's exact reads (ERC-5192 `supportsInterface` probe included) and only relaxing admission
(bench wallets hold nothing on a real chain, and the probe contract declares no lock) — see
`signing.ts` "REAL-CHAIN MODE". Same rig otherwise: seeder on the ~270 ms-RTT WAN host, joiner
local, dialed directly. Every JSON-RPC round trip the joiner pays is attributed to the operation
that caused it (`gateRpc.byOp`): `head` = `eth_blockNumber` (bucket derivation), `block` =
tie-break block-hash read, `multicall` = the batched gate reads, `direct` = single-wallet gate
reads, plus HTTP/JSON-RPC error counts.

These runs are the acceptance test for the **rate-limit-safe read policy** (DESIGN.md "Background
chain verification"): 200-read `aggregate3` chunks, ≤2 in flight per client, and the voter-level
read coalescer that merges parallel contests' pinned-block reads into shared round trips.

## Cold join (single contest) — measured 2026-07-14, median of 5

| N (voters) | router | connect | fetch | bitswap | verify+merge | gate-RPC | **START→TALLY** | **START→VERIFIED** |
|-----------:|-------:|--------:|------:|--------:|-------------:|---------:|----------------:|-------------------:|
| 1          | 1.00s  | 1.62s   | 0.56s | 0.78s   | 0.49s        | 2        | **3.43s**       | **3.83s**          |
| 5          | 1.00s  | 1.60s   | 0.57s | 0.86s   | 0.68s        | 2        | **3.71s**       | **4.30s**          |
| 10         | 1.00s  | 1.72s   | 0.56s | 0.59s   | 0.51s        | 2        | **3.35s**       | **3.75s**          |
| 100        | 1.00s  | 1.60s   | 0.56s | 0.77s   | 0.66s        | 2        | **3.64s**       | **4.19s**          |
| 1000       | 1.00s  | 1.59s   | 0.57s | 1.09s   | 2.38s        | 8.5      | **5.53s**       | **8.22s**          |

*Re-measured 2026-07-15 (median of 5) after merging master (advertiser-seeded session chase +
announcer-discovered seeder) and the exotic-multicall raw-path guard: within jitter of this table at
every N (N ≤ 100 render 3.29–3.59s / verified 3.69–4.20s; N=1000 on a quiet machine 5.4–6.0s render /
7.6–7.9s verified), with the read pattern unchanged — 8 round trips (5 multicalls carrying all 1000
reads), **0 HTTP / 0 JSON-RPC errors in 5/5 reps**, measured median round trip 498–814 ms. A
concurrent local CPU load during part of that sweep inflated only the `verify+merge` column (2.4 s →
4.3–5.6 s; a mock-mode control on the same tree reproduced the same inflation, so it is machine load,
not a transport or read-policy change).*

### Gate-RPC round trips per operation (median; `reads` = multicall inner reads)

| N (voters) | total | head | block | multicall | reads | direct | http-err | rpc-err | measured latency |
|-----------:|------:|-----:|------:|----------:|------:|-------:|---------:|--------:|-----------------:|
| 1          | 2     | 1    | 0     | 1         | 1     | 0      | 0        | 0       | 457ms            |
| 5          | 2     | 1    | 0     | 1         | 5     | 0      | 0        | 0       | 641ms            |
| 10         | 2     | 1    | 0     | 1         | 10    | 0      | 0        | 0       | 458ms            |
| 100        | 2     | 1    | 0     | 1         | 100   | 0      | 0        | 0       | 512ms            |
| 1000       | 8.5   | 3.5  | 0     | 5         | 1000  | 0      | 0        | 0       | 687ms            |

- **A real-chain cold join costs 2 RPC round trips up to N=100** (one head read + ONE `aggregate3`
  carrying every gate read) **and 8–9 at N=1000** (5 multicall chunks of ≤200 + head re-reads over
  the longer join), with **zero throttling errors at every N** on the free public endpoint.
- **N=1000 renders in 5.5s and is fully chain-verified in 8.2s** over the real internet against
  the real chain. One rep absorbed a transient 429 pair via the chunk retry (verified 8.9s).
- The tie-break `block` read never appears: the bench tally is a single community, so the
  ranking has no tie to break.
- Measured per-round-trip latency to `mainnet.base.org` from this joiner: ~0.46–0.69s median per
  request (larger multicalls and endpoint queueing push it above the raw ~0.3s RTT), which is what
  the mock gateway's fixed 270 ms charge stood in for — the mock's numbers above remain the
  controlled-latency baseline.

## Directory cold-load — measured 2026-07-14, median of 5 (N=10 voters/contest)

| M (contests) | router | connect | identify | fetch/ct | bitswap/ct | verify+merge | **START→ALL-TALLIES** | **START→ALL-VERIFIED** |
|-------------:|-------:|--------:|---------:|---------:|-----------:|-------------:|----------------------:|-----------------------:|
| 1            | 1.00s  | 1.60s   | 1.98s    | 0.58s    | 0.61s      | 0.56s        | **3.51s** | **3.76s** |
| 10           | 1.00s  | 0.60s   | 0.98s    | 0.56s    | 0.59s      | 0.94s        | **2.93s** | **3.69s** |
| 63           | 1.00s  | 0.67s   | 1.90s    | 0.68s    | 0.94s      | 1.31s        | **8.74s** | **10.06s** |

### Gate-RPC round trips per operation (median)

| M (contests) | total | head | block | multicall | reads | direct | http-err | rpc-err | measured latency |
|-------------:|------:|-----:|------:|----------:|------:|-------:|---------:|--------:|-----------------:|
| 1            | 2     | 1    | 0     | 1         | 10    | 0      | 0        | 0       | 438ms            |
| 10           | 2     | 1    | 0     | 1         | 100   | 0      | 0        | 0       | 995ms            |
| 63           | 7     | 3    | 0     | 4         | 630   | 0      | 0        | 0       | 783ms            |

- **The read coalescer collapses the whole directory's chain verification into a handful of round
  trips**: 10 boards' gate reads ride ONE `aggregate3` (2 round trips total for the join); all 63
  boards' 630 reads ride 4 (the boards admit over ~2 s, so they fill a few 25 ms coalescing
  windows). Per-board verification cost at the RPC is effectively gone.
- **Median run: zero throttling errors and all-verified ~0.3–1.3 s after render** at every M.
- **Tail (2 of 5 M=63 reps):** a mid-join WAN reconnect (`conns=2`) dragged the join out; the
  scattered admits produced 35–88 small multicalls whose sustained stream the endpoint throttled
  (22–66 429'd round trips), and all-verified stretched to 44–61 s — but the directory still
  converged 63/63 and every board eventually chain-verified. Render (`START→ALL-TALLIES`) stayed
  8.7–17.8 s; only the background trust milestone pays for the degraded link.
- The M=63 render medians (8.74 s vs the mock run's 4.17 s) also reflect a generally worse link
  during this run (identify 1.90 s vs 0.99 s) — the real-chain deltas to compare are the RPC
  columns and the render→verified gap, which are flat.

## For contrast — the same joins before the read policy (all measured, same rig)

- **Burst shape (superseded):** viem's default multicall chunking sent a 1000-wallet batch as ~38
  concurrent ~27-read `aggregate3` posts. Probed directly against `mainnet.base.org`: **33 of 38
  answered HTTP 429 `-32016 over rate limit`** (survivors queued ~3 s). The replacement shape — 5
  chunks of 200 at concurrency 2 — probed clean: 1000 reads, 0 errors, 2.4 s wall-clock.
- **Cold join, pre-chunking (2026-07-14, first real-chain run):** N ≤ 10 matched the current
  numbers (2 round trips), but N=100 paid a median **16 round trips** (429 retries) for
  START→VERIFIED **7.39 s**, and **N=1000 never chain-verified** within the 60 s rep ceiling in
  any of 5 reps (START→TALLY was unaffected at ~5.5–6 s — the render path never touches the gate
  reads).
- **Directory, post-chunking but pre-coalescer-decomposition (2026-07-14):** each board's
  `evaluateMany` still went to the wire separately — M=10 paid **38–74 round trips** (10 separate
  small multicalls + head reads, then 20–42 429'd retries) for all-verified **11.9–30.5 s**. With
  pinned multicalls decomposed into the shared pool: **2 round trips, 0 errors, 3.69 s**.
