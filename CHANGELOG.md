# Changelog

## [0.5.0](https://github.com/bitsocialnet/pubsub-voting/compare/v0.4.1...v0.5.0) (2026-08-17)

### ⚠ BREAKING CHANGES

* **criteria:** `requires.chains` (a ticker -> chainId map) is replaced
by a required top-level `bucketChainId`, rule refs lose their `chain`
option, `ChainClientFactory` takes `{ chainId }` alone, and the bundle
verdict no longer carries `ruleScore`. Every criteria document re-CIDs,
so every contest re-topics — this lands with the `rule` -> `gate` rename
as ONE cutover rather than paying for two. `GateChainMismatchError` is
gone; there is nothing left for it to catch.

The document said its chain twice: each rule named a ticker, and
`requires.chains` bound that ticker to an id. Two spellings of one fact
need a rule to keep them honest, so a validator compared every gate leaf
against every other and refused a document that mixed them. An invariant
you cannot express beats one you have to police: a contest now names one
chain by the numeric id the EIP-712 ballot domain already signs over,
every rule reads it, and "this leaf answered about someone else's
history" stops being a thing that can be written down. The ticker was
only ever a label local to a document — and two documents spelling one
chain differently were two topics for one contest.

What went with it: `src/chain/ticker.ts`, `ChainConfigSchema`,
`ChainTickerSchema`, the per-contest `chainFor(ticker)` seam threaded
through `resolveGate`, both verifiers and the tally, and the ticker ->
client map in the voter. All of it collapses to one `chain: ChainClient`.

Also here, because they are the same document and the same cutover:

- Leaves that ask the SAME question are evaluated once, not once per
  position. A rule may be named in two branches — that is how "any two
  of these three" is written — and the two positions race, so both miss
  the rule's own memo before either writes it. `dedupeLeaves` groups by
  canonical ref: one batched call per distinct question in the
  background verifier, one shared promise per wallet inline.
- `EligibilityCheck.leaf` is the render key. `ruleId` is the hash of a
  leaf's canonical ref, so it is NOT unique within a gate that names one
  rule twice; it stays as the sharing identity (equal ids are one
  question, one memo, one read across contests).
- The gate tree's depth and leaf caps are checked on the RAW value
  before the recursive schema descends. `z.lazy` overflows the stack on
  a pathological document long before a post-parse cap can fire, and a
  RangeError escaping `safeParse` breaks the one guarantee that call
  makes.
- `requires` and `voteSchema` are strict. A non-strict `requires`
  silently STRIPPED a leftover `chains` key and derived a different
  topic from the one the author's bytes implied — the exact silent fork
  the strict top level exists to prevent.
- `BundleVerdictValid.ruleScore` is dropped: nothing read it, and a
  min-across-`all` fold over unrelated rules ("holds 5" and "not banned
  = 1") is a number that means nothing. Per-rule scores live on
  `checkEligibility().checks`, which has a consumer.
* **criteria:** `criteria.rule` becomes `criteria.gate`, a boolean tree
over rule references. This re-CIDs every criteria document and so
re-topics every contest; the identity migration is
`gate: { rule: <the old rule ref> }`. `Contest.checkEligibility` returns
a new shape, and `BundleVerifier.checkGate` becomes `checkGates`.

A client could not answer "which requirements is this wallet missing?"
because a contest had exactly one gate rule, so listing failures was
listing one thing. Expressing "the Pass, or a moderator, and not banned"
needed a bespoke rule per combination — code every participant must
implement to say what a document could say.

The gate is now `{ rule } | { all: [...] } | { any: [...] }`. A rule
still answers one question about one wallet and never sees the gate it
sits in; `src/rules/gate.ts` folds the answers, reading the tree's
structure and the results' discriminants but never which rule produced
them. Canonicity constrains the shape, because the topic is the CID of
these bytes and two spellings of one meaning is a silent topic fork: a
branch takes >= 2 children, the leaf is wrapped (a rule ref is loose, so
an option named `all`/`any` would make a bare leaf ambiguous), depth and
leaf count are capped, and every leaf must read the contest's one clock
chain (`GateChainMismatchError`).

Three things fold, and only the first is obvious:

- the score: min across an `all` (the binding constraint), max across a
  satisfied `any` (the best qualification);
- the blame set: the failures that EXPLAIN a refusal, which is NOT every
  failed leaf. One inside a satisfied `any` cost the wallet nothing, and
  telling it to acquire an asset it does not need is worse than silence;
- `penalize`: an `all` is attributable if ANY failing child is (that
  child alone closes the gate everywhere), an `any` only if EVERY child
  is (one unprovable failure means a peer with a fresher view may see a
  wallet this gate admits, and reject-scoring it punishes honest
  relaying). The inline gate short-circuits and can only under-report
  attributability, which is the fail-safe direction.

`checkEligibility` now returns `{ eligible, score | error, checks,
failures, gate }` — every rule in document order, the blame set, and the
tree with per-node verdicts so a client renders the real requirement.
Rows key by `ruleId` (the leaf's canonical hash, which is also its cache
namespace), because one gate may name a rule twice on different options.

The forward gate evaluates lazily; the background verifier scores every
leaf because its batching axis is the rule — one `evaluateMany` per leaf
per round — so collecting all is cheaper there and yields the complete
blame set for free.

Benchmark: re-run against the WAN host with a same-session control on
master. `verify+merge` is flat (0.31/0.32/0.33/0.47/1.96 on master vs
0.32/0.32/0.32/0.47/1.97 here) and gate-RPC counts are identical; the
end-to-end spread between the two runs sits entirely in `connect` and
`fetch`, which drifted on master too. RESULTS.md is left alone rather
than re-baselined on today's link conditions.

### Features

* **criteria:** compose gate rules with all/any, and report every failure ([91376fe](https://github.com/bitsocialnet/pubsub-voting/commit/91376fe107d024c2f7781a2d6d47cbf8a37a36ea))
* **criteria:** name the contest's chain once, as bucketChainId ([17e810c](https://github.com/bitsocialnet/pubsub-voting/commit/17e810c2d33f891748aeeaf079b56ac845648d41))

### Bug Fixes

* **criteria:** reject the redundant gate spellings that fork a topic ([4456304](https://github.com/bitsocialnet/pubsub-voting/commit/4456304d78cbf7bc91736849b76bdcbda7a2f48c))
* **gate:** keep one unreadable rule from sinking checkEligibility ([19d09e8](https://github.com/bitsocialnet/pubsub-voting/commit/19d09e83deb18dcd6ce97c42ec6501371186a627))

## [0.4.1](https://github.com/bitsocialnet/pubsub-voting/compare/v0.4.0...v0.4.1) (2026-08-14)

## [0.4.0](https://github.com/bitsocialnet/pubsub-voting/compare/v0.3.0...v0.4.0) (2026-08-09)

### ⚠ BREAKING CHANGES

* **rules:** require a voter-facing reason on every rule failure

### Features

* **rules:** require a voter-facing reason on every rule failure ([e8a7ee4](https://github.com/bitsocialnet/pubsub-voting/commit/e8a7ee4869672cf95eae4d31d6a568c9dff2b881))

## [0.3.0](https://github.com/bitsocialnet/pubsub-voting/compare/v0.2.1...v0.3.0) (2026-08-09)

### ⚠ BREAKING CHANGES

* **rules:** the `Rule` interface changed. `evaluate` takes
`{ options, wallet: { address, sampleBlock }, ctx }` instead of
`{ options, walletAddress, ctx }`; `evaluateMany` takes `{ wallets }` and
returns `{ results }`; `ChainReadContext` is now `{ chain, head, cache }` with
no `blockNumber`. A chain-reading custom rule must memoize through `ctx.cache`
or it loses the read-amplification bound. `gate-result-cache.ts` is replaced by
`rules/cache.ts`.

### Features

* **rules:** let a rule own its block and its cache, and gate on the head ([a43eecc](https://github.com/bitsocialnet/pubsub-voting/commit/a43eecce7c704a7dc57e8ce1c2f1b09a63612fa3))

### Bug Fixes

* **bench:** adapt the real-chain probe rule to evaluateMany's new shape ([a05b7d3](https://github.com/bitsocialnet/pubsub-voting/commit/a05b7d3475068034abe0032611b2f34006b3013a))
* **client:** namespace the weight memo by the weight rule's own chain ([f68e8a8](https://github.com/bitsocialnet/pubsub-voting/commit/f68e8a8fff4b7139d7fdd527f9d5f934f39c74c7))
* **rules:** call evaluateMany by name, not through `this` ([d6861ee](https://github.com/bitsocialnet/pubsub-voting/commit/d6861ee11c606fb70929ac7377c7f11bf61d8196)), closes [#29](https://github.com/bitsocialnet/pubsub-voting/issues/29)
* **rules:** parallelize memoMany lookups; correct stale references ([8467f40](https://github.com/bitsocialnet/pubsub-voting/commit/8467f400d139f75272ec2b3dc63b31f2ef43b19e))

## [0.2.1](https://github.com/bitsocialnet/pubsub-voting/compare/v0.2.0...v0.2.1) (2026-08-07)

## [0.2.0](https://github.com/bitsocialnet/pubsub-voting/compare/v0.1.7...v0.2.0) (2026-08-07)

### ⚠ BREAKING CHANGES

* **rules:** the v1 gate rule is now `erc5192-min-balance`; criteria naming
`erc721-min-balance` recuse via `UnknownRuleError` unless the host registers it
explicitly. Both halves re-CID every criteria document, so every contest gets a
new topic — land as one cutover (release, upgrade clients, redeploy the Pass
locked, then flip the manifest). See DESIGN.md "Cutover ordering".

### Features

* **rules:** gate on ERC-5192, unregister erc721-min-balance ([35b4eca](https://github.com/bitsocialnet/pubsub-voting/commit/35b4eca8c056163b50fbe121476e3c45decabc5f)), closes [#28](https://github.com/bitsocialnet/pubsub-voting/issues/28) [#27](https://github.com/bitsocialnet/pubsub-voting/issues/27)

### Bug Fixes

* **rules:** address review — drop `this`, validate the probe's interface id ([a97bd29](https://github.com/bitsocialnet/pubsub-voting/commit/a97bd29307fcd4aa61178ae584f6318e6e2805c6)), closes [#29](https://github.com/bitsocialnet/pubsub-voting/issues/29)

## [0.1.7](https://github.com/bitsocialnet/pubsub-voting/compare/v0.1.6...v0.1.7) (2026-07-30)

### Bug Fixes

* keep the directory fixture's gate on its declared chain, pin the example manifest ([48d9a8f](https://github.com/bitsocialnet/pubsub-voting/commit/48d9a8f5fc31af3151802f66835d066d3b6accc9)), closes [#24](https://github.com/bitsocialnet/pubsub-voting/issues/24)

## [0.1.6](https://github.com/bitsocialnet/pubsub-voting/compare/v0.1.5...v0.1.6) (2026-07-30)

## [0.1.5](https://github.com/bitsocialnet/pubsub-voting/compare/v0.1.4...v0.1.5) (2026-07-22)

### Features

* answer every joined contest's root record in one fetch ([1795cd5](https://github.com/bitsocialnet/pubsub-voting/commit/1795cd5c80917ea8a126373b8168da1765794b0e))
* carry the whole cold pull in the bulk answer, and spend one answer on every contest ([06ed65c](https://github.com/bitsocialnet/pubsub-voting/commit/06ed65ccb715027ffb96a06f68fd7a6387a390df))

### Bug Fixes

* bound a hung cold-join provider dial at 3s, not the 10s router timeout ([dc47111](https://github.com/bitsocialnet/pubsub-voting/commit/dc47111b09a81c0153e9edd88a78950a39596d1a)), closes [#discoverProviders](https://github.com/bitsocialnet/pubsub-voting/issues/discoverProviders)
* fall back to per-topic when a peer ERRORs the bulk root key, not just when it NOT_FOUNDs ([983cd57](https://github.com/bitsocialnet/pubsub-voting/commit/983cd5747ef0ca0ad655ca1b7c5916f5b48593ba))

### Performance Improvements

* coalesce the cold-start gating-chain head-read storm (252 -> 66 getBlockNumber, -74%) ([931371e](https://github.com/bitsocialnet/pubsub-voting/commit/931371ebd2656ccd853de73a241a06dc8217154e))

## [0.1.4](https://github.com/bitsocialnet/pubsub-voting/compare/v0.1.3...v0.1.4) (2026-07-19)

## [0.1.3](https://github.com/bitsocialnet/pubsub-voting/compare/v0.1.2...v0.1.3) (2026-07-19)

## [0.1.2](https://github.com/bitsocialnet/pubsub-voting/compare/v0.1.1...v0.1.2) (2026-07-17)

## [0.1.1](https://github.com/bitsocialnet/pubsub-voting/compare/v0.1.0...v0.1.1) (2026-07-17)

### Features

* fail fast on invalid community names and report own-vote evictions ([32dca7e](https://github.com/bitsocialnet/pubsub-voting/commit/32dca7ed52535d9eec939029bd77e57a77036a88))

## [0.1.0](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.10...v0.1.0) (2026-07-17)

### ⚠ BREAKING CHANGES

* drop RPC URLs from the criteria document

### Features

* drop RPC URLs from the criteria document ([17dbc67](https://github.com/bitsocialnet/pubsub-voting/commit/17dbc67abd799725eac8655de674fdcd074496eb))

## [0.0.10](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.9...v0.0.10) (2026-07-16)

### Features

* re-run the cold-start pull on gossipsub subscription-change ([c838023](https://github.com/bitsocialnet/pubsub-voting/commit/c8380239b9e73d1e59d4512d82c0bef12a95e7fc)), closes [#15](https://github.com/bitsocialnet/pubsub-voting/issues/15) [#14](https://github.com/bitsocialnet/pubsub-voting/issues/14) [#16](https://github.com/bitsocialnet/pubsub-voting/issues/16)

## [0.0.9](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.8...v0.0.9) (2026-07-16)

### Features

* persist checkpoint snapshots under dataPath so a seeder restart keeps the tally ([9cccea0](https://github.com/bitsocialnet/pubsub-voting/commit/9cccea0150d4f18b86df346b0017005943fa5815))

### Bug Fixes

* close the orphaned sqlite handle when [#open](https://github.com/bitsocialnet/pubsub-voting/issues/open)() fails mid-initialization ([e144e1a](https://github.com/bitsocialnet/pubsub-voting/commit/e144e1a06551d75b6f5ec02fe28256733486d986))

## [0.0.8](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.7...v0.0.8) (2026-07-16)

## [0.0.7](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.6...v0.0.7) (2026-07-16)

### Features

* **transport:** announce wildcard rewrite sentinels so zero-config seeders are discoverable ([7459d5b](https://github.com/bitsocialnet/pubsub-voting/commit/7459d5bf2e24d778f767f574e176c01e1d0ac808))

## [0.0.6](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.5...v0.0.6) (2026-07-16)

## [0.0.5](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.4...v0.0.5) (2026-07-15)

### Features

* **benchmark:** real-chain mode — gate reads against live Base mainnet ([f4db7f0](https://github.com/bitsocialnet/pubsub-voting/commit/f4db7f037f1d367aea4e4b0d0bd5dbfbf87981ca))

### Bug Fixes

* **chain:** decompose pinned multicalls into the coalescer pool ([a5f3671](https://github.com/bitsocialnet/pubsub-voting/commit/a5f367113c8e27fdc74c94786202a602de49b6e4))
* **chain:** route pinned multicalls with exotic options around the coalescer ([72f59c5](https://github.com/bitsocialnet/pubsub-voting/commit/72f59c5a34edba0bd9fb72856e13f31766fc0b2b))
* **rules:** chunk and coalesce gate reads so free public RPCs don't throttle verification ([bb7ef83](https://github.com/bitsocialnet/pubsub-voting/commit/bb7ef83ee7fd911c128f88320988b95bf9703977))

## [0.0.4](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.3...v0.0.4) (2026-07-15)

### Features

* **transport:** chase checkpoint roots through advertiser-seeded bitswap sessions ([63a522e](https://github.com/bitsocialnet/pubsub-voting/commit/63a522e7d92ffb72db2642057af1262f3df0f823)), closes [#191](https://github.com/bitsocialnet/pubsub-voting/issues/191) [#5](https://github.com/bitsocialnet/pubsub-voting/issues/5)

### Bug Fixes

* **transport:** enforce ChaseSession never-throw contracts at the session boundary ([4a7e93a](https://github.com/bitsocialnet/pubsub-voting/commit/4a7e93a6925a3fcf3a83d44f8f2d52190a5541c4))

## [0.0.3](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.2...v0.0.3) (2026-07-14)

### Features

* **schema:** export deriveDirectoryCriteria for directory manifests ([be03365](https://github.com/bitsocialnet/pubsub-voting/commit/be03365ffc5f3b38c98e75657ecbfd71cd2d3c6e))
* **transport:** announce provider records to HTTP routers from the seeder ([b472d2f](https://github.com/bitsocialnet/pubsub-voting/commit/b472d2f059d3c812e526117efbad569cc2d66b25)), closes [#6](https://github.com/bitsocialnet/pubsub-voting/issues/6)

## [0.0.2](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.1...v0.0.2) (2026-07-12)

### Reverts

* Revert "feat(schema): export deriveDirectoryCriteria for directory manifests" ([b28dc1a](https://github.com/bitsocialnet/pubsub-voting/commit/b28dc1a40c4d769cedd36cc33c1fdd97082f7469))

## 0.0.1 (2026-07-12)

### ⚠ BREAKING CHANGES

* **verify:** CommunityTally.verified is replaced by chainVerified +
nameResolved; TallyOptions/verifyBudget are removed (getTally() takes no
options); RootChaserDeps takes verifyOffline/deferVerify instead of
verifier; VoteCrdt gains currentEntries/remove and prune returns the
removed CIDs. No wire change — bundle, message, and checkpoint layouts
(and their frozen vectors) are untouched.
* **client:** address contests by criteria document; drop the manifest

### refactor

* **client:** address contests by criteria document; drop the manifest ([ef788e7](https://github.com/bitsocialnet/pubsub-voting/commit/ef788e7034e72ccca9153c280fc8155b7d9ac9eb))

### Features

* **api:** type PubsubVoter manifest option as DirectoryManifest ([86097cc](https://github.com/bitsocialnet/pubsub-voting/commit/86097ccd06ecc3a9a7da1a6bb75c17c135abcb01))
* **bench:** measure START→ALL-VERIFIED in the directory cold-load bench ([943b12f](https://github.com/bitsocialnet/pubsub-voting/commit/943b12f1c78432bb350298998f89937acd0604e4))
* board is { name?, publicKey }; strict B58 IPNS identity ([2e451eb](https://github.com/bitsocialnet/pubsub-voting/commit/2e451eb2bc288d245eff7573f4b89cdcc67ddaec))
* board names are verified claims; pairwise-distinct boards per bundle ([5ebdc76](https://github.com/bitsocialnet/pubsub-voting/commit/5ebdc761a3a8daaf90a7f377ca20a1d908f5a269)), closes [bso-resolver#3](https://github.com/bitsocialnet/bso-resolver/issues/3)
* **checkpoint:** on-demand encode + root heartbeat + directed-bitswap chase ([aaac950](https://github.com/bitsocialnet/pubsub-voting/commit/aaac9503699cad9bc7fac6c36568e5727fba817c))
* **client:** implement republish scheduler, durable persistence, and withdrawal semantics ([e85c80d](https://github.com/bitsocialnet/pubsub-voting/commit/e85c80db74b1b85defa8226a1587ba6f16f68e9f))
* **client:** make voter.destroy() terminal, mirroring pkc-js ([47e7558](https://github.com/bitsocialnet/pubsub-voting/commit/47e755856b9b80c978a7db339698acae5938fc8f)), closes [#engines](https://github.com/bitsocialnet/pubsub-voting/issues/engines)
* **client:** persist gate results and name resolutions under dataPath ([fe97719](https://github.com/bitsocialnet/pubsub-voting/commit/fe97719c5b53a0a7bb5d8bade5d043fede589da5))
* **client:** require manifest, rename contest→contestId, add getContest ([1afbea5](https://github.com/bitsocialnet/pubsub-voting/commit/1afbea5b865b8d87e158c1e236da53d0b4ec651c))
* **client:** surface publish peer-reach as recipientCount ([9f559f2](https://github.com/bitsocialnet/pubsub-voting/commit/9f559f220f3863030c9c45e1322d95c763228aa4))
* **crdt:** read-time expiry filter so decayed votes can't pollute heads ([eb7ed97](https://github.com/bitsocialnet/pubsub-voting/commit/eb7ed976a6d409ea692bcd7f3197c5f8fe3820d8))
* freeze v1 EIP-712 ballot layout with a conformance vector ([463941c](https://github.com/bitsocialnet/pubsub-voting/commit/463941caadbab8664419c51052824c6d407b85a4))
* **gate:** anti-amplification caches + network-free checkpoints ([e92d241](https://github.com/bitsocialnet/pubsub-voting/commit/e92d241420874c6302141aeed7ca0b8fcbc03945))
* **gate:** bound verdict cache + per-fetch abort against amplification ([064e04b](https://github.com/bitsocialnet/pubsub-voting/commit/064e04b7397f9a816c289c1c63f83fa4114927aa))
* implement encoding/topic/manifest foundation + PubsubVoter facade ([21f3c45](https://github.com/bitsocialnet/pubsub-voting/commit/21f3c454f6f114b7ad3ff7a5cf1eb5f1d4cf9ae2))
* interpreter scores are exact bigint via { score } result ([6351c53](https://github.com/bitsocialnet/pubsub-voting/commit/6351c53acae8a94b585df67d59bbbcb10df0738e))
* **schema:** export deriveDirectoryCriteria for directory manifests ([9a03c42](https://github.com/bitsocialnet/pubsub-voting/commit/9a03c4233431784f4ba47ee5ea209622e86e4ef7))
* single-kind interpreter registry (one file per type) ([f2790ba](https://github.com/bitsocialnet/pubsub-voting/commit/f2790ba84d5513be49984caba991f53324eba405))
* take host Helia node directly; validate pubsub + blockstore at construction ([23a4200](https://github.com/bitsocialnet/pubsub-voting/commit/23a4200d57c4a5c7bbbfa263ad750cb2f0809157))
* **transport:** cold-start discovery via HTTP content router; fix fetch key bytes ([4a302a9](https://github.com/bitsocialnet/pubsub-voting/commit/4a302a99d1bdf9a8fb201cdbb41be2f5fbc50319))
* **transport:** libp2p-fetch root-record pull — responder, cold join, MissingFetchError ([3495b36](https://github.com/bitsocialnet/pubsub-voting/commit/3495b36e6e854d4afb495fd1269cc9ab5c25c9bf))
* **transport:** live-delta gossip — inline bundles + root records, no gate fetch ([a82de02](https://github.com/bitsocialnet/pubsub-voting/commit/a82de02df72d7170bc4011ed36be78bdea2d30de)), closes [#2](https://github.com/bitsocialnet/pubsub-voting/issues/2)
* validate-before-forward gossip gate + engine (verify/crdt/tally/transport) ([d1d4e96](https://github.com/bitsocialnet/pubsub-voting/commit/d1d4e969aa446f4210e23aa1e020a8fcd5d9e5df))
* **verify:** defer cold-join chain checks to a batched background verifier ([4afc6d7](https://github.com/bitsocialnet/pubsub-voting/commit/4afc6d7690fce9d71f1c0d7f0bad0f6b44275f7d))
* voter lifecycle (start/stop/destroy), republish cadence, and dataPath persistence ([2820bad](https://github.com/bitsocialnet/pubsub-voting/commit/2820badcac1901e7df4bf3dd9bba99aa0295f853))
* **wire:** binary bundle block encoding + 253-byte name bound ([a133603](https://github.com/bitsocialnet/pubsub-voting/commit/a1336034bc9e941e54585dbe9c09654476776a1a))

### Bug Fixes

* **client:** fetch responder answers only joined topics ([a8156ef](https://github.com/bitsocialnet/pubsub-voting/commit/a8156ef9fd717f4f5fd0c6c70ab584ce075587bd))
* **client:** re-purge persisted gate results as the expiry horizon advances ([f0c346d](https://github.com/bitsocialnet/pubsub-voting/commit/f0c346dfd279ff644447130ce2d19ab4a96d0d7a))
* **client:** retry cold-start root-record fetch until a deadline ([2285f5e](https://github.com/bitsocialnet/pubsub-voting/commit/2285f5e70bb998f2af9e0fc5977e13c73e4f1ec5)), closes [#fetchRootWithRetry](https://github.com/bitsocialnet/pubsub-voting/issues/fetchRootWithRetry)
* **gate:** split forward-gate verdicts into reject vs ignore ([505eced](https://github.com/bitsocialnet/pubsub-voting/commit/505ecedf4794c2fb1d2f0232862fde15d4c12eb1))
* **storage:** reconcile the browser LRU's size counter before swapping ([ff12a19](https://github.com/bitsocialnet/pubsub-voting/commit/ff12a19116cbb8026c06b1c4edb49acd1fe994ab))

### Performance Improvements

* **benchmark:** dial seeder directly over WAN instead of an SSH tunnel ([6f78511](https://github.com/bitsocialnet/pubsub-voting/commit/6f78511252c0e3d982e249143a18a15d51e43c68))
* **client:** budget cold-start fetches per peer and shuffle subscriber pick ([647348c](https://github.com/bitsocialnet/pubsub-voting/commit/647348c925f933aaf95d474c0f4b56f10eb879c5))
* **transport:** pull checkpoint in one bitswap round-trip via piggybacked chunk index ([0393994](https://github.com/bitsocialnet/pubsub-voting/commit/0393994b01d1f10131e5b7dbffb5e917decbb001))
