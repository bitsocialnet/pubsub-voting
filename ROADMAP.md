# Roadmap: @bitsocial/pubsub-voting

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

The engine, client lifecycle, and live-delta transport are implemented and unit-tested, and the two-node gossipsub integration test now exercises them against real `@libp2p/gossipsub`; the host-side registration gap has closed too (pkc-js registers gossipsub + `@libp2p/fetch` on the shared node as of `0.0.63`), leaving only the pkc-js accessor and tuning follow-ups below. Accurate as of this file's commit — verify against the tree, not this list, if they drift.

### Done (implemented + unit-tested)

- zod schemas (criteria, votes, wire primitives) and canonical dag-cbor encoding
- topic derivation (`topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`) and manifest → per-contest criteria derivation
- EIP-712 ballot signer + **frozen conformance vector** (the cross-client wire spec)
- verify pipeline: signature + `address`-recovery + criteria constraints + on-chain gate (`rule`) + community-name resolution, with a per-bundle verdict cache
- state-based CRDT: LWW winner-set keyed by wallet, **binary** dag-cbor bundle codec (frozen byte vector), in-memory node store; forward-gate anti-amplification caches (gate-result + accepted-dedup)
- tally: deterministic per-contest aggregation over pre-validated bundles, rolling-seed tiebreak
- transport **validate-before-forward gossip gate** (`src/transport/gossip-validator.ts`) over the two-kind pubsub union (**one inline bundle per message** with the criteria-derived size cap, or a **root record**): the full pipeline runs on the inlined bytes in an async topic validator before `forwardMessage` — no fetch on the live path
- **root-record checkpoint sync**: on-demand checkpoint encode (dirty-flag cached, blocks blockstore-backed), the suppressed 10-min root heartbeat, the libp2p-fetch responder + `k = 4` cold-join requester (`MissingFetchError` construction guard), and the bounded directed-bitswap chase of divergent roots (`src/transport/chase.ts`)
- chain bucket math and chainTicker → RPC
- rules: `erc721-min-balance` + `constant` (registered); `erc20-balance` present in-tree and unit-tested but **not registered** (see Deferred)
- reactive facade: `PubsubVoter` (factory) minting `Contest` (`createContest` → `update()` + `update`/`error` events + `tally`) and `ContestVote` (`createContestVote` → `publish()` + `publishingstatechange`/`error`); `PubsubVoter.stop`/`destroy` lifecycle (no `start()` — a seeder just creates + updates every contest; the fetch responder registers lazily on the first topic join). **Republishing a live vote is the client's job** — the library publishes each vote once and exports `republishIntervalBuckets(criteria)` so the client can schedule its own refreshes (no scheduler, no persistence; see DESIGN.md "Republishing is the client's job")
- **two-node gossipsub integration test** (`src/transport/integration/`, run via `npm run test:integration`, excluded from the unit `npm test`): two real loopback libp2p + Helia nodes on `@libp2p/gossipsub` `16.0.3` pinning what a fake cannot — an invalid inline bundle is not forwarded and its sender is `reject`-scored (P₄); a valid one is forwarded and merges; a verify past the deadline yields `ignore` with no penalty and is re-evaluable (uncached); a converged pair's matching root triggers no chase; a divergent root is chased over directed bitswap to convergence. It surfaced a latent bug — the injected Helia `blockstore.get` is an async generator, now normalised by `adaptBlockstore` (`src/transport/helia.ts`)

### Remaining for v1

Nothing in this repository. The required host-side service registrations have landed in pkc-js; the follow-ups below are non-blocking.

### Deferred pkc-js work (external dependency)

- A documented, version-stable accessor on pkc-js that returns the Helia node (with `libp2p.services.pubsub`, `blockstore`, and a registered `fetch` service), so consumers stop reaching through the private `._helia` field.
- **Adding `@libp2p/fetch` to the shared node's construction — done in pkc-js `0.0.63`** (`fetch: libp2pFetch()` alongside `pubsub: gossipsub()` in `helia-for-pkc`). This library registers its own lookup function and runs its own requester against `libp2p.services.fetch` (see Done, root-record checkpoint sync); `PubsubVoter` still throws `MissingFetchError` at construction on a node without the service.

Filed as [pkc-js#183](https://github.com/pkcprotocol/pkc-js/issues/183), closed 2026-07 — the service registrations landed (gossipsub `16.0.2`, above the >= 15.0.23 floor, plus `@libp2p/fetch`). Still open upstream: the version-stable accessor and score tuning; and this library pins gossipsub `16.0.3`, so a follow-up asks the host to match.

## Deferred (designed, not shipped)

These are decided in principle and the architecture leaves room for each without an engine rewrite, but none ships in v1. Kept here so v1 stays small and the intent is not lost.

- **Balance-derived / token-weighted voting.** `erc20-balance` (Pass gate + BSO weight) stays in-tree and unit-tested but is **unregistered**, so a criteria naming it recuses via `UnknownRuleError` rather than silently enabling token-weighting. Re-registering it in `builtinRegistry` + re-exporting from `src/index.ts` is the whole re-ship, but it must land **with** the open question below resolved. See [DESIGN.md, Future improvements](./DESIGN.md#future-improvements).
  - **Open question — lazy-tally upper bounds for non-constant weight.** The bound-based early stop in ["Tally"](./DESIGN.md#tally) assumes each unverified vote has a cheap ceiling — trivially `1` for `constant`. A balance-derived weight like `erc20-balance` derives magnitude *from* the chain read, so it carries no free wire-side bound; lazy tally there needs a self-declared, verify-down balance, or it degrades to verifying every ranking-relevant vote. The `{ score }` result object exists precisely to grow a `ceiling` field for this without another signature break. Decide when the first weighted contest ships — and, if a weight reduction ever lands, alongside it.
- **Gate combining — a `challenges`-style AND-array.** Make the `rule` slot `RuleRef[]`, every term required, iterated by the runtime exactly as pkc-js ANDs its challenges (e.g. "hold a Pass **and** ≥ N BSO"). Requires `ChainReadContext` to evolve from a single pre-resolved `chain` to a `chainFor(ticker)` resolver. See [DESIGN.md, Future improvements](./DESIGN.md#future-improvements).
- **Weight combining — a weight-only, non-recursive reduction.** For multi-asset additive weight (e.g. `#Passes + BSO/1000`), a `sum` over weight-slot terms. Requires the lazy-tally upper-bound question above.
- **Pinned-block name resolution across chains.** Community-name verification currently resolves at head. Pinning it to a canonical historical block needs a per-bucket block *on the registry's chain* (Ethereum for `.bso`), which differs from the criteria's chain (Base in the 5chan example) — the same multi-chain block-selection problem as the tie seed and the gate AND-array. The resolver API already accepts an optional `blockNumber`; v1 leaves it unset and accepts a transient disagreement window around a name re-point. See [DESIGN.md, Open questions](./DESIGN.md#open-questions).
- **Account-activity gate rules (e.g. `min-nonce`).** A well-formed *pure* gate rule — read `getTransactionCount(wallet)` at the bucket block, score `> 0n` only above a threshold — unlike a rate/timestamp check, which is stateful/temporal and so cannot be a consensus `reject` (see [DESIGN.md, Can valid votes clog the topic?](./DESIGN.md#why-this-resists-the-hard-failure-modes)). **Not on the Pass v1 path:** it is redundant with the non-transferable Pass gate, ~free to bypass (one dust tx per wallet on an L2), and would reject legitimate gasless-minted Pass holders whose wallet is nonce 0 (MintPass mints server-side to the holder's address). Kept for a future token-gated config where a bare balance gate wants a cheap activity signal; the nonce is always **read from chain**, never carried on the wire.

## Acknowledged for v2+ (not designed)

Unlike the deferred items above, these are not designed — only acknowledged so the intent is not lost. Neither ships in v1 or v1.x, and both are breaking wire changes (the topic is the CID of the criteria document, so any criteria-shape change forks every topic), so they must land together in a single v2 criteria revision.

- **Abstract the criteria document away from web3 (drop block-based expiry from the top level).** Today web3 primitives are baked into the criteria's top-level shape: `blocksPerBucket` and `voteExpiryBuckets` define freshness in chain blocks, `requires.chains` is a per-chain RPC manifest, and every bundle is stamped with a `blockNumber`. A v2 revision should move time/freshness behind an abstract epoch notion (with the block-bucket scheme as one pluggable implementation, chosen by the rule that needs it) so the top-level document carries nothing chain-specific — only the `rule`/`weight` refs would name web3 when the contest actually gates on a chain. Part of the seam already exists — the CRDT and verify pipeline consume freshness through an injected `bucketMath` rather than reading the chain themselves — but the criteria shape, the bundle's on-wire `blockNumber` stamp, and the block-derived tie seed are all chain-block-native today, which is what makes this a v2 wire revision rather than an internal refactor.

- **TODO — investigate web2 voting mechanisms (e.g. whitelist).** Explore gate rules that need no chain at all: a static allowlist of addresses baked into the criteria (the document already travels in full, so a whitelist is just rule options), or other non-chain eligibility signals. The rule registry already supports chain-free rules (`constant` does zero reads), but a genuinely web2 gate is blocked on the abstraction above — without it every contest still drags in block buckets and a chain manifest it doesn't use. Open questions to investigate: what replaces the block-derived expiry and rolling tie seed for a chain-free contest, and whether signature recovery stays EIP-712/secp256k1 when the identity is no longer a wallet.
