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

## Per-operation latency (seeder on a ~270 ms-RTT WAN host, cold joiner local, median of 3)

`N` is the number of **voters** (distinct wallets, one ballot each) in the contest's checkpoint. All
voters vote for one community, so the tally is one community of weight `N`.

| N (voters) | router | connect | fetch | bitswap | verify+merge | **START→TALLY** |
|-----------:|-------:|--------:|------:|--------:|-------------:|----------------:|
| 1          | 1.00s  | 1.89s   | 0.86s | 1.72s   | 0.03s        | **4.59s**       |
| 5          | 1.00s  | 1.90s   | 0.91s | 1.78s   | 0.04s        | **4.63s**       |
| 10         | 1.00s  | 1.92s   | 0.91s | 1.99s   | 0.10s        | **4.91s**       |
| 100        | 1.00s  | 2.03s   | 1.67s | 3.72s   | 0.46s        | **8.35s**       |
| 1000       | 1.00s  | 1.97s   | 1.02s | 2.33s   | 3.43s        | **8.71s**       |

*Measured 2026-07-08 (direct public dial, no SSH tunnel). Columns are wall-clock timings of each operation but they **overlap** and do
not sum to the total — `connect` is measured from the `start()` call and already contains the 1 s
router wait, and verify runs as blocks arrive. `START→TALLY` is the true end-to-end figure.*

### What each column is

| Column | Operation |
|---|---|
| `router` | HTTP content-router lookup for the criteria CID — find who runs the contest (simulated ~1 s, paid once). |
| `connect` | Dial the named provider + noise/yamux/identify handshake (from `start()`, so it includes the 1 s router wait). |
| `fetch` | Pull the tiny root record over the libp2p **fetch** protocol. |
| `bitswap` | Pull the checkpoint blocks (root manifest → chunk) over directed **bitswap** — two sequential round-trips. |
| `verify+merge` | Recover every ballot's EIP-712 signature, run the gate, LWW-merge into the winner-set. |
| `START→TALLY` | End-to-end: `start()` → `getTally()` reflects all `N` voters. |

### Reading the numbers

- **Cold join is ~4.6 s for a small contest and ~8.7 s at 1000 voters** over a real intercontinental
  link. Small-`N` joins are network-bound and flat (~4.6–4.9 s); at 1000 the per-voter verify work
  starts to dominate.
- **The router is not the bottleneck** — a fixed 1 s, paid once. The remaining cost is RTT-bound
  steps: the connection **handshake (~1.9–2.0 s)**, the root-record **fetch (~0.9–1.7 s)**, and
  **bitswap (~1.7–3.7 s, two sequential block round-trips)**. WAN jitter is real at this RTT — the
  `N=100` fetch/bitswap medians run high because two of three repeats spiked, not because of `N`.
  bitswap remains the biggest network lever for small contests (batching/parallelizing its two pulls
  is the obvious win); the fetch still carries an avoidable multistream-select round-trip on top of
  its logical one (pre-negotiating / a 0-RTT select would cut it toward ~1 RTT).
- **verify scales with `N`** as expected (0.03 s → 3.43 s for 1000 signature recoveries) and is the
  dominant term only at 1000.

## For contrast

- **Loopback floor (~0 ms RTT):** the same cold join runs in **~1.1 s** (dominated by the simulated
  1 s router latency). The ~4.6–8.7 s WAN figure is almost entirely round-trip cost — exactly what
  loopback would have hidden.
- **SSH-tunnelled data path (superseded):** an earlier run carried the joiner→seeder link through an
  SSH port-forward. TCP-over-TCP inflated every step (**8.3–11.2 s** end-to-end, bitswap up to ~6 s);
  dialing the public IP directly removed that artifact and roughly halved the small-`N` numbers.
- **Previous discovery (gossipsub `getSubscribers` only, before HTTP-router discovery):** a fresh
  join waited for subscription gossip to propagate (~5 s over the WAN link) before it could even
  start fetching, for **~11–16 s** end-to-end. HTTP-router discovery replaces that ~5 s wait with the
  1 s router lookup.
