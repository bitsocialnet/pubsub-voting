# Cold-join latency — benchmark results

**What this measures:** how long a **cold peer** takes, from joining a contest to having a usable
**tally** (the "which community/board do I load in the UI?" signal, i.e. `getTally()` returning the
full ranking). This is the latency of the *existing code*, measured — not estimated.

**Why cross-machine, not loopback:** loopback has ~0 ms RTT, so it only measures CPU/verify cost and
hides the protocol round-trips that dominate in the real world. These numbers were taken with the
seeder on a **remote WAN host (~270 ms round-trip)** and the cold joiner local, connected over an SSH
port-forward so the real RTT is preserved through NAT/firewalls. Chain reads use an instant fake
(the `erc721-min-balance` gate passes for every wallet), so the numbers isolate peer-to-peer latency;
a real chain RPC would add its own round-trips on top at verify time.

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
| 1          | 1.00s  | 2.64s   | 1.49s | 4.65s   | 0.03s        | **8.34s**       |
| 5          | 1.00s  | 2.14s   | 1.46s | 4.75s   | 0.04s        | **8.50s**       |
| 10         | 1.00s  | 2.95s   | 1.19s | 3.02s   | 0.05s        | **7.26s**       |
| 100        | 1.00s  | 2.39s   | 1.44s | 4.50s   | 0.20s        | **7.98s**       |
| 1000       | 1.00s  | 2.18s   | 1.59s | 5.92s   | 1.53s        | **11.18s**      |

*Measured 2026-07-08. Columns are wall-clock timings of each operation but they **overlap** and do
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

- **Cold join is ~7–11 s** over a real intercontinental link, roughly flat in `N` until 1000.
- **The router is not the bottleneck** — a fixed 1 s, paid once. The cost is three RTT-bound steps:
  the connection **handshake (~2.5 s)**, the root-record **fetch (~1.5 s)**, and **bitswap (~3–6 s)**.
  bitswap is the single biggest lever if we want cold-join under 5 s (it is two sequential block
  round-trips; batching/parallelizing them is the obvious win).
- **verify scales with `N`** as expected (0.03 s → 1.53 s for 1000 signature recoveries) and stays cheap.

## For contrast

- **Loopback floor (~0 ms RTT):** the same cold join runs in **~1.1 s** (dominated by the simulated
  1 s router latency). The ~7–11 s WAN figure is almost entirely round-trip cost — exactly what
  loopback would have hidden.
- **Previous discovery (gossipsub `getSubscribers` only, before HTTP-router discovery):** a fresh
  join waited for subscription gossip to propagate (~5 s over the WAN link) before it could even
  start fetching, for **~11–16 s** end-to-end. HTTP-router discovery replaces that ~5 s wait with the
  1 s router lookup.
