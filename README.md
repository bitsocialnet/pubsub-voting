# @bitsocial/pubsub-votes

Trustless, leaderless voting over libp2p pubsub, designed to run on top of a host node's shared libp2p/Helia instance.

> **Status: engine and client lifecycle implemented and unit-tested.** The zod schemas, canonical dag-cbor encoding, topic/manifest derivation, the verify pipeline (signature + constraints + on-chain gate + board-name resolution), the Merkle-CRDT (LWW union), the tally, the transport's **validate-before-forward gossip gate**, the `PubsubVoter` client-level republish scheduler, and durable vote-intent persistence (Node SQLite / browser IndexedDB) are all implemented — so `start`, `castVotes`, `getTally`, and the full `PubsubVoter.start`/`stop`/`destroy` lifecycle are live. The gate runs the full validity pipeline in an async gossipsub topic validator *before* re-forwarding, so an invalid bundle (bad signature, wallet the gate rejects, squatted name) is never propagated and `reject` scores the sender. What remains is deferred, host-blocked work: cold-start winner-CID sync over the libp2p fetch protocol (needs a pkc-js-side fetch service) and checkpoint compaction. See [DESIGN.md](./DESIGN.md) for the architecture, the [Transport gate](./DESIGN.md#transport-gossipsub-topic--validation), and [open questions](./DESIGN.md#open-questions).

## What it is for

The first consumer is [5chan](https://github.com/bitsocialnet/5chan), a serverless, adminless imageboard on the Bitsocial protocol. 5chan has a [competitive directory system](https://github.com/bitsocialnet/5chan/blob/master/README.md#competitive-directory-system): many boards compete for each directory slot (for example, multiple "Business & Finance" boards), but only the highest-voted one appears on the homepage. Today those assignments are curated by hand through pull requests to [`5chan-directories.json`](https://github.com/bitsocialnet/lists/blob/master/5chan-directories.json). This library is the planned replacement: directory voting that is decided by holders rather than by maintainers, with no server to trust.

The same engine generalizes to the original use case in [pkc-js issue #25](https://github.com/pkcprotocol/pkc-js/issues/25) (a default-communities list voted on over pubsub) and to any future Bitsocial client that needs holder-weighted, censorship-resistant curation.

## Why a separate library (not in pkc-js)

[pkc-js](https://github.com/pkcprotocol/pkc-js) (Public Key Communities) is the protocol layer: communities, publications, the challenge exchange. Voting is application/governance layer. Keeping it separate means:

- Chain-RPC and governance churn stay out of pkc-js core. pkc-js deliberately touches chains only for name resolution; it has no balance lookups, no chainTicker-to-RPC mapping, and no off-chain vote signing or verification. This library owns all of that.
- The engine is reusable across clients and contests.
- The core (`schema/`, `verify/`, `crdt/`, `tally/`) is transport-agnostic and unit-testable without a network. libp2p only appears in `transport/`.

This library does not start its own node. It consumes the host's running Helia node directly — no adapter — and drives that node's gossipsub service and blockstore itself. The node must carry a pubsub service at `libp2p.services.pubsub` (a plain Helia node does not — register e.g. `@chainsafe/libp2p-gossipsub`) and a usable `blockstore`; construction throws `MissingPubsubError` / `MissingBlockstoreError` otherwise. With pkc-js today that node is reached at `pkc.clients.libp2pJsClients[key]._helia`; a version-stable accessor on pkc-js is a planned follow-up (see [DESIGN.md, Deferred pkc-js work](./DESIGN.md#deferred-pkc-js-work)).

## Design at a glance

- **Settings live in the topic.** `topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`. Two peers on the same topic provably ran identical rules, so the network validates itself with no intermediary.
- **Votes are a state-based grow-only CRDT.** A signed `Votes` bundle is a standalone dag-cbor block (no parent links); only winner bundle CIDs travel over pubsub; each unknown bundle is fetched by CID. State is a last-write-wins set keyed by wallet, so aggregation is a monotonic union: a peer can omit a vote but can never subtract one that an honest peer serves.
- **The gate and weight are data, not code.** A fixed rule registry (mirroring pkc-js's challenge registry) maps a `type` string to a verifier. v1 ships exactly the NFT path — an `erc721-min-balance` gate `rule` (5chan Pass) and `constant` weight (1 pass = 1 vote). Balance-derived (token-weighted) voting is deferred; see [ROADMAP.md](./ROADMAP.md).

See [DESIGN.md](./DESIGN.md) for the full rationale, including how this resists vote-dropping and how criteria upgrades fork cleanly.

## Usage

The library never starts a node and never takes a host SDK (there is no `pkc` argument). A host passes its own running Helia node in directly and injects its seams into a single `PubsubVoter`:

| Seam | Type | Required | Purpose |
|---|---|---|---|
| `helia` | `HeliaInstance` | yes | the host's running Helia node; must carry a gossipsub service at `libp2p.services.pubsub` (else `MissingPubsubError`) and a `blockstore` (else `MissingBlockstoreError`) |
| `chains` | `ChainClientFactory` | yes | builds a viem `PublicClient` per chain; rules read through it for the gate and weight |
| `signer` | `VoteSigner` | no | the voting wallet's address + EIP-712 ballot signing; omit for a read-only voter |
| `nameResolvers` | `NameResolver[]` | no | board-name resolvers (same interface and instances as pkc-js's `nameResolvers`, e.g. `@bitsocial/bso-resolver` for `name.bso`); the tally verifies each vote's `board.name` claim through them and drops bundles whose name does not resolve to the claimed `publicKey` |
| `manifest` | `unknown` | yes | the directory manifest this voter owns; the voter derives every contest from it at construction, addresses each by its unique `contestId` (`getContest`), and keeps them republished under one lifecycle (see [Lifecycle](#lifecycle-start--stop--destroy)). A duplicate `contestId` throws `DuplicateContestIdError`; a missing/invalid manifest throws `MissingManifestError` |
| `dataPath` | `string` | no | Node only: directory for the SQLite file that persists this voter's vote intents so republishing survives a restart (the same `dataPath` convention as pkc-js / `@bitsocial/bso-resolver`). In the browser the voter uses IndexedDB; with no `dataPath` on Node, persistence is in-memory (lost on restart) |
| `republishPollIntervalMs` | `number` | no | how often (wall-clock ms) the republish scheduler checks each contest for a due re-sign; defaults to 10 minutes. The cadence itself is bucket-based per contest (`ceil(voteExpiryBuckets / 2)`); this only sets the poll granularity. Lower it to react faster at the cost of more RPC head reads |

### Construct a voter

```ts
import { PubsubVoter } from "@bitsocial/pubsub-votes";

const voter = new PubsubVoter({
  helia,                        // the host's Helia node; needs a gossipsub service at libp2p.services.pubsub + a blockstore
  chains: viemChainFactory(),   // ({ chain, config }) => viem PublicClient
  manifest,                     // required: the directory manifest this voter owns (one contest per entry, unique contestId)
  signer: mySigner,             // optional; omit → read-only voter
  nameResolvers: [bsoResolver]  // optional; verifies board-name claims (e.g. @bitsocial/bso-resolver)
});
```

The `manifest` is mandatory: the voter derives every contest from it at construction and addresses each by its unique `contestId`. If you only care about one contest, pass a one-entry manifest (empty `defaults`, the criteria as the single `contests` entry).

Construction throws `MissingPubsubError` or `MissingBlockstoreError` if the node lacks a usable pubsub service or blockstore — the library fails fast rather than letting a later `publish`/`subscribe`/`fetch` fail obscurely. ("Bitswap" is not a separately checkable property — it is a block broker wired beneath `blockstore` — so the validated guarantee is a well-formed blockstore, the surface bitswap retrieves through.)

### Read a tally (no signer needed)

```ts
const contest = await voter.getContest({ contestId }); // contestId: a slot in the voter's manifest
await contest.start();
const tally = await contest.getTally();
const winner = tally.ranking[0]?.board; // { name?: string, publicKey: string } — identity is publicKey
```

### Cast or withdraw a vote (needs a signer)

```ts
await contest.castVotes([{ board: { publicKey: "12D3KooW..." }, vote: 1 }]); // board: { name?, publicKey } (B58 IPNS name); v1: one upvote per topic
await contest.castVotes([]);                                  // active withdrawal: broadcast an empty bundle that supersedes under LWW; the scheduler re-announces that tombstone (without re-signing it) until it expires, then drops it
await voter.forget({ contestId: "biz" });                     // passive withdrawal: drop the stored intent, publish nothing, and let the vote decay at its own expiry
```

A board's identity is its `publicKey`. The optional `name` is the board's resolvable domain (e.g. `memes.bso`) — unique per community, never a free label: the schema requires a TLD, and at tally time the name is resolved through the injected `nameResolvers` and any bundle whose name does not resolve to the claimed `publicKey` is dropped. Bundles must also name pairwise-distinct `board.publicKey`s. See [DESIGN.md, Votes wire](./DESIGN.md#votes-wire).

There are two ways to stop voting. `castVotes([])` is the **active** path: it broadcasts an empty bundle that immediately supersedes the prior vote under LWW. The scheduler then **re-announces that tombstone** — re-broadcasting its existing CID on the liveness cadence, *without* re-signing it, so its expiry clock is untouched — so peers that missed the one-shot flood converge within a cycle; once the tombstone expires the scheduler drops the intent and the bundle decays via expiry + prune (never an immortal heartbeat). `forget({ contestId })` is the **passive** path: it drops the stored intent and publishes nothing, so the vote simply decays once its last bundle expires. Both are idempotent; `forget` on an unknown `contestId` throws `UnknownContestError`.

`castVotes` on a voter built without a `signer` throws `ReadOnlyError`; `forget` on a read-only voter just drops any stored intent (there is none) and is a harmless no-op.

### Many contests from one manifest

A 5chan-style directory manifest derives one contest (one topic) per slot. The voter owns the manifest, so it already knows every contest — enumerate them by `contestId` and reach each with `getContest`:

```ts
const contests = await Promise.all(voter.contestIds.map((contestId) => voter.getContest({ contestId }))); // → VoteNetwork[]
```

### Lifecycle (`start` / `stop` / `destroy`)

Pass the `manifest` at construction and let one lifecycle own every contest. `start()` joins them all and arms a republish loop that keeps this wallet's votes alive by re-signing them with a fresh `blockNumber` on a per-contest cadence — `ceil(voteExpiryBuckets / 2)` buckets, half the expiry window, so a missed cycle still has slack. `stop()` leaves the topics (reusable); `destroy()` also disposes the vote store.

```ts
const voter = new PubsubVoter({ helia, chains, signer, manifest }); // manifest owned by the voter
await voter.start();     // join every contest + start republishing this wallet's votes
// … app runs …
await voter.destroy();   // stop the republish loops, leave all topics, dispose the store
```

Persistence is what lets republishing survive a restart: the voter stores its own re-signable *intent* per contest (which boards it picked), not the signed bundles. On Node, pass `dataPath` to keep those intents in a SQLite file under that directory; in the browser the voter uses IndexedDB automatically; with no `dataPath` on Node, persistence is in-memory and lost on restart.

```ts
const voter = new PubsubVoter({ helia, chains, signer, manifest, dataPath: "./.bitsocial-votes" }); // Node: SQLite under dataPath
```

### Pure helpers (no node, no network)

```ts
import { topicFor, deriveCriteria } from "@bitsocial/pubsub-votes";

const topic = await topicFor(criteria);       // "bitsocial-votes/" + CID(dag-cbor(criteria))
const allCriteria = deriveCriteria(manifest); // defaults ⊕ each entry, each validated
```

Full, type-checked call patterns for a pkc-js host, a plebbit/seedit host, and a read-only consumer are in [examples/](./examples/).

### Custom rules

The gate and weight are a single flat registry of rules, one `type` per file, mirroring the pkc-js challenge registry. Each rule owns its option schema and is evaluated at the bundle's bucket block. Chain-reading rules get `ctx.chain` — the viem `PublicClient` for their `options.chain` — and write their own reads (`readContract`, `getBalance`, ...), pinning each call to the sampled block with `blockNumber: BigInt(ctx.blockNumber)`. There is **one kind**: `evaluate → { score: bigint }`, a non-negative score where `0n` means "does not qualify" (a result object, not a bare `bigint`, so slot-specific fields can be added later). The criteria has two *slots* drawing from the one registry — the **rule** slot treats the score as a gate (`> 0n` admits), the **weight** slot as the vote's magnitude. A wallet's vote counts as `rule.score > 0n ? weight.score : 0n`. A rule that needs a threshold returns `0n` below it (so `erc721-min-balance`'s optional `min` gates), which lets the same rule serve either slot.

Built-ins: `erc721-min-balance` (v1) and `constant` (v1). A host adds or shadows rules by `type` via the `rules` option — this is how clients like 5chan or seedit register custom rules without forking the library:

```ts
import { PubsubVoter, type Rule } from "@bitsocial/pubsub-votes";
import { z } from "zod";

const seeditModAllowlist: Rule<{ type: "seedit-mod-allowlist"; allow: string[] }> = {
  type: "seedit-mod-allowlist",
  optionsSchema: z.object({ type: z.literal("seedit-mod-allowlist"), allow: z.array(z.string()) }),
  async evaluate({ options, walletAddress }) {
    return { score: options.allow.includes(walletAddress) ? 1n : 0n }; // gate: 1n admits, 0n rejects
  }
};

const voter = new PubsubVoter({
  libp2p, chains,
  rules: { "seedit-mod-allowlist": seeditModAllowlist } // flat map; shadows/extends built-ins by `type`
});
```

A custom `type` becomes part of `dag-cbor(criteria)`, so it is provably pinned to the topic it runs on, and a client that does not implement a `type` named in `criteria.requires.rules` throws `UnknownRuleError` and recuses itself rather than miscounting.

### Weighted voting (deferred)

v1 ships `constant` weight (one Pass, one vote) **on purpose** — it resists whale dominance and downvote weaponization. Balance-derived, token-weighted voting (Pass gate + BSO weight via `erc20-balance`) is a designed-but-unshipped capability: the rule path and result shape leave room for it with no engine change, but it is not in the v1 built-ins and carries open governance/abuse and lazy-tally questions. See [ROADMAP.md](./ROADMAP.md) and [DESIGN.md, Future improvements](./DESIGN.md#future-improvements).

## Layout

```
src/
  schema/        zod schemas (criteria, votes, shared wire primitives) + inferred types
  encoding/      canonical dag-cbor encoding                      [implemented]
  topic.ts       topic = "bitsocial-votes/" + CID(dag-cbor)       [implemented]
  manifest/      derive one criteria document per contest         [implemented]
  signer/        VoteSigner seam + EIP-712 ballot typed data       [implemented]
  store/         vote-intent persistence (memory / Node SQLite / browser IDB) [implemented]
  client/        PubsubVoter facade + per-contest VoteNetwork + republish scheduler [implemented]
  errors.ts      ReadOnly/MissingPubsub/Blockstore/MissingManifest/... [implemented]
  rules/         one file per `type` + registry/resolver          [implemented]
  chain/         ChainClient = viem PublicClient + bucket math     [implemented]
  verify/        signature + constraints + full BundleVerifier + verdict cache [implemented]
  crdt/          state-based LWW winner-set: union, codec, in-memory store [implemented]
  transport/     async validate-before-forward gossip gate + winner-CID codec + transport [implemented]
  tally/         deterministic aggregation over pre-validated bundles [implemented]
  index.ts       public entry: re-exports + facade + design types
```

## License

GPL-3.0-or-later, matching 5chan.
