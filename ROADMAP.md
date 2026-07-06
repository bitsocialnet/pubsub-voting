# Roadmap: @bitsocial/pubsub-votes

The scope-of-record for what ships when. [DESIGN.md](./DESIGN.md) is *how* each part works and why; this is *which* parts are in v1 and what is deliberately held back. When the two disagree about scope, this file wins.

## Guiding principle for v1: the NFT use case, nothing more

v1 does exactly one thing: **holder-decided directory voting gated by an ERC-721 (the 5chan Pass), one Pass = one vote.** Everything that is not on that path is deferred, even where the code or design already exists. Keeping the shipped surface this small is the point — it is the smallest thing that solves 5chan's [competitive directory system](https://github.com/bitsocialnet/5chan/blob/master/README.md#competitive-directory-system), and every deferred item below is a real capability the architecture already leaves room for, not a rewrite.

Concretely, v1 is:

- **Gate (`rule`):** `erc721-min-balance` (hold ≥ N of the Pass).
- **Weight:** `constant` (1 Pass = 1 vote) — no balance reads, so the tally does zero chain reads.
- **Voting:** upvote-only, one vote per topic (`maxVotesPerAddress: 1`), approval-style across contests.
- **Built-in rule registry:** exactly `erc721-min-balance` + `constant`. Nothing else is registered.

Token-weighting, ERC-20 in either slot, rule combining, and multi-chain resolution are **out of v1** (see [Deferred](#deferred-designed-not-shipped)).

## Status

The engine is implemented and unit-tested; the client-level lifecycle is the remaining gap. Accurate as of this file's commit — verify against the tree, not this list, if they drift.

### Done (implemented + unit-tested)

- zod schemas (criteria, votes, wire primitives) and canonical dag-cbor encoding
- topic derivation (`topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`) and manifest → per-contest criteria derivation
- EIP-712 ballot signer + **frozen conformance vector** (the cross-client wire spec)
- verify pipeline: signature + `address`-recovery + criteria constraints + on-chain gate (`rule`) + community-name resolution, with a per-bundle verdict cache
- state-based CRDT: LWW winner-set keyed by wallet, dag-cbor codec, in-memory node store; forward-gate anti-amplification caches (gate-result + accepted-dedup); network-free checkpoint codec + bucket-cadenced cut
- tally: deterministic per-contest aggregation over pre-validated bundles, rolling-seed tiebreak
- transport **validate-before-forward gossip gate** (`src/transport/gossip-validator.ts`): the full pipeline runs in an async topic validator before `forwardMessage`
- chain bucket math and chainTicker → RPC
- rules: `erc721-min-balance` + `constant` (registered); `erc20-balance` present in-tree and unit-tested but **not registered** (see Deferred)
- facade: `VoteNetwork.start` / `castVotes` / `getTally`; in-memory vote-intent store

### Remaining for v1

1. **Client republish scheduler.** `PubsubVoter.#armRepublishScheduler` ([src/client/voter.ts](src/client/voter.ts)) still throws `NotImplementedError`, so `PubsubVoter.start()` is not usable end-to-end. Each contest's tick must reload its `VoteIntent`, re-sign it with a fresh `blockNumber` via `castVotes`, and persist the bumped `lastBucket` on the `ceil(voteExpiryBuckets / 2)`-bucket liveness cadence; `stop()`/`destroy()` tear the timers down. See [DESIGN.md, Lifecycle](./DESIGN.md#lifecycle-one-manifest-start--stop--destroy).
2. **Persistence backends.** `selectVoteStore` ([src/store/select.ts](src/store/select.ts)) returns an in-memory store regardless of `dataPath`, so intents are lost on restart. Wire the Node **SQLite-under-`dataPath`** (WAL) backend and the browser **IndexedDB** backend behind the same `VoteStore` interface. See [DESIGN.md, Persistence](./DESIGN.md#persistence-the-wallets-own-vote-intents).
3. **Cold-start winner-CID sync.** The `fetchWinnerCidsFromPeer` seam ([src/transport/transport.ts](src/transport/transport.ts)) is accepted but unset, so cold start returns only local winner CIDs and relies on live gossip to converge. Wiring it needs pkc-js to register/expose a fetch service (a responder answering a topic → current-winner-CIDs request, and a requester pulling up to `k` peers and validating each set **through the same gate**). This is also the transport for the checkpoint cold-start consume (see Deferred). See [DESIGN.md, Transport](./DESIGN.md#transport-gossipsub-topic--validation) and [Deferred pkc-js work](./DESIGN.md#deferred-pkc-js-work).
4. **Two-node gossipsub integration test.** Real `@libp2p/gossipsub`, gated behind an integration flag, pinning the await-before-`forwardMessage` behavior: an invalid bundle is not forwarded and its sender is `reject`-scored; a valid bundle is forwarded and merges on the peer; a fetch past the 10s deadline yields `ignore` with no penalty. The pure decision logic is already unit-tested; this pins the real-gossipsub timing a fake cannot prove.

### Deferred pkc-js work (external dependency)

- A documented, version-stable accessor on pkc-js that returns the Helia node (with `libp2p.services.pubsub`, `blockstore`, and a registered `fetch` service), so consumers stop reaching through the private `._helia` field.
- Registration of the gossipsub **fetch service** the cold-start head sync (#3 above) depends on.

Track these as pkc-js issues and reference them here once filed.

## Deferred (designed, not shipped)

These are decided in principle and the architecture leaves room for each without an engine rewrite, but none ships in v1. Kept here so v1 stays small and the intent is not lost.

- **Balance-derived / token-weighted voting.** `erc20-balance` (Pass gate + BSO weight) stays in-tree and unit-tested but is **unregistered**, so a criteria naming it recuses via `UnknownRuleError` rather than silently enabling token-weighting. Re-registering it in `builtinRegistry` + re-exporting from `src/index.ts` is the whole re-ship, but it must land **with** the open question below resolved. See [DESIGN.md, Future improvements](./DESIGN.md#future-improvements).
  - **Open question — lazy-tally upper bounds for non-constant weight.** The bound-based early stop in ["Tally"](./DESIGN.md#tally) assumes each unverified vote has a cheap ceiling — trivially `1` for `constant`. A balance-derived weight like `erc20-balance` derives magnitude *from* the chain read, so it carries no free wire-side bound; lazy tally there needs a self-declared, verify-down balance, or it degrades to verifying every ranking-relevant vote. The `{ score }` result object exists precisely to grow a `ceiling` field for this without another signature break. Decide when the first weighted contest ships — and, if a weight reduction ever lands, alongside it.
- **Gate combining — a `challenges`-style AND-array.** Make the `rule` slot `RuleRef[]`, every term required, iterated by the runtime exactly as pkc-js ANDs its challenges (e.g. "hold a Pass **and** ≥ N BSO"). Requires `ChainReadContext` to evolve from a single pre-resolved `chain` to a `chainFor(ticker)` resolver. See [DESIGN.md, Future improvements](./DESIGN.md#future-improvements).
- **Weight combining — a weight-only, non-recursive reduction.** For multi-asset additive weight (e.g. `#Passes + BSO/1000`), a `sum` over weight-slot terms. Requires the lazy-tally upper-bound question above.
- **Pinned-block name resolution across chains.** Community-name verification currently resolves at head. Pinning it to a canonical historical block needs a per-bucket block *on the registry's chain* (Ethereum for `.bso`), which differs from the criteria's chain (Base in the 5chan example) — the same multi-chain block-selection problem as the tie seed and the gate AND-array. The resolver API already accepts an optional `blockNumber`; v1 leaves it unset and accepts a transient disagreement window around a name re-point. See [DESIGN.md, Open questions](./DESIGN.md#open-questions).
- **Checkpoint cold-start consume.** The network-free half is **shipped**: the deterministic checkpoint codec (`src/checkpoint/codec.ts`, byte-pinned by a test vector) and the bucket-cadenced **cut** that rides the republish tick (`checkpointIntervalBuckets`, storing blocks + exposing `latestCheckpointRoot`). What remains is the **consume** side — pulling a peer's checkpoint root over the libp2p fetch protocol and unioning it in — which is host-blocked on the pkc-js fetch service (same seam as "Cold-start head sync" #3 and "Deferred pkc-js work"). See [DESIGN.md, Checkpoints](./DESIGN.md#checkpoints).
- **Account-activity gate rules (e.g. `min-nonce`).** A well-formed *pure* gate rule — read `getTransactionCount(wallet)` at the bucket block, score `> 0n` only above a threshold — unlike a rate/timestamp check, which is stateful/temporal and so cannot be a consensus `reject` (see [DESIGN.md, Can valid votes clog the topic?](./DESIGN.md#why-this-resists-the-hard-failure-modes)). **Not on the Pass v1 path:** it is redundant with the non-transferable Pass gate, ~free to bypass (one dust tx per wallet on an L2), and would reject legitimate gasless-minted Pass holders whose wallet is nonce 0 (MintPass mints server-side to the holder's address). Kept for a future token-gated config where a bare balance gate wants a cheap activity signal; the nonce is always **read from chain**, never carried on the wire.
