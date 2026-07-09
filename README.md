# @bitsocial/pubsub-votes

Trustless, leaderless voting over libp2p pubsub, designed to run on top of a host node's shared libp2p/Helia instance.

> **Status: engine, reactive facade, and live-delta transport implemented and unit-tested.** The zod schemas, canonical dag-cbor encoding, topic/manifest derivation, the verify pipeline (signature + constraints + on-chain gate + community-name resolution), the LWW winner-set CRDT with its binary bundle codec, the tally, the transport's **validate-before-forward gossip gate** over **inline bundle deltas**, and the **root-record checkpoint sync** (on-demand encode, suppressed 10-minute topic heartbeat, libp2p-fetch pull, divergent roots chased via directed bitswap) are all implemented — so the reactive `PubsubVoter` / `Contest` (`createContest`) / `ContestVote` (`createContestVote`) facade is live. The gate runs the full validity pipeline on the message bytes in an async gossipsub topic validator *before* re-forwarding, so an invalid bundle (bad signature, wallet the gate rejects, squatted name) is never propagated and `reject` scores the sender. **Keeping a live vote from decaying is the consuming client's job** — this library publishes each vote once and exposes `republishIntervalBuckets` so the client can schedule its own refreshes (see [DESIGN.md, Republishing is the client's job](./DESIGN.md#republishing-is-the-clients-job-not-this-librarys)). What remains is host-side (pkc-js registering gossipsub + `@libp2p/fetch` on the shared node) — see [ROADMAP.md](./ROADMAP.md), [DESIGN.md](./DESIGN.md), the [Transport gate](./DESIGN.md#transport-gossipsub-topic--validation), and [open questions](./DESIGN.md#open-questions).

## What it is for

The first consumer is [5chan](https://github.com/bitsocialnet/5chan), a serverless, adminless imageboard on the Bitsocial protocol. 5chan has a [competitive directory system](https://github.com/bitsocialnet/5chan/blob/master/README.md#competitive-directory-system): many communities compete for each directory slot (for example, multiple "Business & Finance" communities), but only the highest-voted one appears on the homepage. Today those assignments are curated by hand through pull requests to [`5chan-directories.json`](https://github.com/bitsocialnet/lists/blob/master/5chan-directories.json). This library is the planned replacement: directory voting that is decided by holders rather than by maintainers, with no server to trust.

The same engine generalizes to the original use case in [pkc-js issue #25](https://github.com/pkcprotocol/pkc-js/issues/25) (a default-communities list voted on over pubsub) and to any future Bitsocial client that needs holder-weighted, censorship-resistant curation.

## Why a separate library (not in pkc-js)

[pkc-js](https://github.com/pkcprotocol/pkc-js) (Public Key Communities) is the protocol layer: communities, publications, the challenge exchange. Voting is application/governance layer. Keeping it separate means:

- Chain-RPC and governance churn stay out of pkc-js core. pkc-js deliberately touches chains only for name resolution; it has no balance lookups, no chainTicker-to-RPC mapping, and no off-chain vote signing or verification. This library owns all of that.
- The engine is reusable across clients and contests.
- The core (`schema/`, `verify/`, `crdt/`, `tally/`) is transport-agnostic and unit-testable without a network. libp2p only appears in `transport/`.

This library does not start its own node. It consumes the host's running Helia node directly — no adapter — and drives that node's gossipsub service and blockstore itself. The node must carry a pubsub service at `libp2p.services.pubsub` (a plain Helia node does not — register e.g. `@chainsafe/libp2p-gossipsub`), a usable `blockstore`, and a libp2p fetch service at `libp2p.services.fetch` (register `@libp2p/fetch` — the checkpoint root-record pull rides it); construction throws `MissingPubsubError` / `MissingBlockstoreError` / `MissingFetchError` otherwise. With pkc-js today that node is reached at `pkc.clients.libp2pJsClients[key]._helia`; a version-stable accessor on pkc-js is a planned follow-up (see [DESIGN.md, Deferred pkc-js work](./DESIGN.md#deferred-pkc-js-work)).

## Design at a glance

- **Settings live in the topic.** `topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`. Two peers on the same topic provably ran identical rules, so the network validates itself with no intermediary.
- **Votes are a state-based grow-only CRDT.** A signed `Votes` bundle is a standalone dag-cbor block (no parent links); each wallet gossips its own bundle **inline as a live delta**, validated straight from the message bytes — no fetch toward the publisher. State is a last-write-wins set keyed by wallet, so aggregation is a monotonic union: a peer can omit a vote but can never subtract one that an honest peer serves. Cold start and gap-fill exchange a tiny **root record** (libp2p-fetch pull + a slow topic heartbeat) and pull the checkpoint blocks behind it via directed bitswap from its advertisers.
- **The gate and weight are data, not code.** A fixed rule registry (mirroring pkc-js's challenge registry) maps a `type` string to a verifier. v1 ships exactly the NFT path — an `erc721-min-balance` gate `rule` (5chan Pass) and `constant` weight (1 pass = 1 vote). Balance-derived (token-weighted) voting is deferred; see [ROADMAP.md](./ROADMAP.md).

See [DESIGN.md](./DESIGN.md) for the full rationale, including how this resists vote-dropping and how criteria upgrades fork cleanly.

## Usage

The library never starts a node and never takes a host SDK (there is no `pkc` argument). A host passes its own running Helia node in directly and injects its seams into a single `PubsubVoter`:

| Seam | Type | Required | Purpose |
|---|---|---|---|
| `helia` | `HeliaInstance` | yes | the host's running Helia node; must carry a gossipsub service at `libp2p.services.pubsub` (else `MissingPubsubError`) and a `blockstore` (else `MissingBlockstoreError`) |
| `chains` | `ChainClientFactory` | yes | builds a viem `PublicClient` per chain; rules read through it for the gate and weight |
| `signer` | `VoteSigner` | no | the voting wallet's address + EIP-712 ballot signing; omit for a read-only voter |
| `nameResolvers` | `NameResolver[]` | no | community-name resolvers (same interface and instances as pkc-js's `nameResolvers`, e.g. `@bitsocial/bso-resolver` for `name.bso`); the tally verifies each vote's `community.name` claim through them and drops bundles whose name does not resolve to the claimed `publicKey` |
| `manifest` | `DirectoryManifest` | yes | the directory manifest this voter owns (structural type — runtime-validated at construction via `deriveCriteria`, so a malformed manifest still throws `MissingManifestError`); the voter derives every contest from it and addresses each by its unique `contestId` (`createContest` / `createContestVote`). A duplicate `contestId` throws `DuplicateContestIdError` |

### Construct a voter

```ts
import { PubsubVoter } from "@bitsocial/pubsub-votes";

const voter = new PubsubVoter({
  helia,                        // the host's Helia node; needs a gossipsub service at libp2p.services.pubsub + a blockstore
  chains: viemChainFactory(),   // ({ chain, config }) => viem PublicClient
  manifest,                     // required: the directory manifest this voter owns (one contest per entry, unique contestId)
  signer: mySigner,             // optional; omit → read-only voter
  nameResolvers: [bsoResolver]  // optional; verifies community-name claims (e.g. @bitsocial/bso-resolver)
});
```

The `manifest` is mandatory: the voter derives every contest from it at construction and addresses each by its unique `contestId`. If you only care about one contest, pass a one-entry manifest (empty `defaults`, the criteria as the single `contests` entry).

Construction throws `MissingPubsubError`, `MissingBlockstoreError`, or `MissingFetchError` if the node lacks a usable pubsub service, blockstore, or libp2p fetch service — the library fails fast rather than letting a later `publish`/`subscribe`/`fetch` fail obscurely. ("Bitswap" is not a separately checkable property — it is a block broker wired beneath `blockstore` — so the validated guarantee is a well-formed blockstore, the surface bitswap retrieves through. The fetch service carries the checkpoint root-record pull; the library registers its own responder on it.)

### Read a tally reactively (no signer needed)

`createContest` mints a per-contest read object; `update()` starts syncing and it emits `update` (carrying a fresh `tally`) and `error`, just like a plebbit-js `subplebbit`:

```ts
const contest = await voter.createContest({ contestId }); // contestId: a slot in the voter's manifest
contest.on("update", () => render(contest.tally));        // tally rides the object; recomputed before each emit
contest.on("error", (err) => showConnectivityWarning(err)); // e.g. the tally's chain read failed
await contest.update();                                   // join the topic, cold-start, begin emitting
const winner = contest.tally?.ranking[0]?.community;      // { name?: string, publicKey: string } — identity is publicKey
// const fresh = await contest.getTally();                // or force a fresh read, bypassing the cache
// await contest.stop();                                  // leave the topic
```

### Publish or withdraw a vote (needs a signer)

`createContestVote` mints a publishable ballot; `publish()` signs and broadcasts it once and emits `publishingstatechange`, like a plebbit-js publication:

```ts
const vote = await voter.createContestVote({ contestId: "biz", votes: [{ community: { publicKey: "12D3KooW..." }, vote: 1 }] });
vote.on("publishingstatechange", (state) => console.log(state)); // stopped → signing → publishing → succeeded (or failed)
const bundle = await vote.publish();                             // resolves the signed VotesBundle

// Withdraw (active): publish an empty ballot; it supersedes the prior vote under LWW.
await (await voter.createContestVote({ contestId: "biz", votes: [] })).publish();
```

A community's identity is its `publicKey`. The optional `name` is the community's resolvable domain (e.g. `memes.bso`) — unique per community, never a free label: the schema requires a TLD, and at tally time the name is resolved through the injected `nameResolvers` and any bundle whose name does not resolve to the claimed `publicKey` is dropped. Bundles must also name pairwise-distinct `community.publicKey`s. See [DESIGN.md, Votes wire](./DESIGN.md#votes-wire).

`publish()` on a voter built without a `signer` throws `ReadOnlyError` (and emits an `error`).

### Republishing is the client's job

A vote is not permanent: a bundle is valid only for `voteExpiryBuckets` after its `blockNumber`, so a live vote must be re-published before it decays. **This library does not do that automatically** — it publishes each vote once and the consuming client decides when (or whether) to refresh. To refresh, just `createContestVote(...).publish()` again; a new bundle at the current bucket supersedes the old one. To stop, simply stop refreshing and let the vote lapse. The library gives you what you need to schedule it — all pure, no chain reads:

```ts
import { republishIntervalBuckets } from "@bitsocial/pubsub-votes";

const cadence = republishIntervalBuckets(criteria); // ceil(voteExpiryBuckets / 2) — the recommended cadence, in buckets
// A vote sampled at bucket b (bundle.blockNumber / criteria.blocksPerBucket) expires once the
// current bucket exceeds b + criteria.voteExpiryBuckets; refresh before then.
```

See [DESIGN.md, Republishing is the client's job](./DESIGN.md#republishing-is-the-clients-job-not-this-librarys) for why an always-on re-signer was deliberately kept out of a library that runs on the host's shared node.

### Many contests from one manifest

A 5chan-style directory manifest derives one contest (one topic) per slot. The voter owns the manifest, so it already knows every contest — enumerate them by `contestId` and reach each with `createContest`:

```ts
const contests = await Promise.all(voter.contestIds.map((contestId) => voter.createContest({ contestId }))); // → Contest[]
```

### Whole-directory lifecycle (`start` / `stop` / `destroy`)

For a seeder or full host that wants to participate in and serve *every* contest at once, `voter.start()` joins all of them and registers the checkpoint fetch responder; a light client can skip it and just `createContest`/`createContestVote` the slots it cares about. `stop()` leaves the topics but keeps the voter **reusable** — each `Contest` can `update()` again and you can `start()`/`createContest` afterward. `destroy()` is **terminal** (like pkc-js): it leaves every topic, unregisters the responder, and marks the voter and its contests dead — any later `createContest`/`createContestVote`/`start`, or a pre-existing `Contest.update()`/`ContestVote.publish()`, throws `VoterDestroyedError`. Construct a new `PubsubVoter` to participate again. (There is no store to dispose — republishing is the client's concern.)

```ts
const voter = new PubsubVoter({ helia, chains, signer, manifest }); // manifest owned by the voter
await voter.start();     // join + serve every contest
// … app runs …
await voter.destroy();   // terminal: leave all topics, unregister the responder, forbid reuse
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
  client/        reactive facade: PubsubVoter + Contest (createContest) + ContestVote (createContestVote) [implemented]
  errors.ts      ReadOnly/MissingPubsub/Blockstore/MissingManifest/... [implemented]
  rules/         one file per `type` + registry/resolver          [implemented]
  chain/         ChainClient = viem PublicClient + bucket math     [implemented]
  verify/        signature + constraints + full BundleVerifier + verdict cache [implemented]
  crdt/          state-based LWW winner-set: union, binary bundle codec, in-memory store [implemented]
  checkpoint/    deterministic checkpoint codec (root manifest + size-capped chunks) [implemented]
  transport/     async validate-before-forward gossip gate + message codec (inline bundle / root record) + root chase + transport [implemented]
  tally/         deterministic aggregation over pre-validated bundles [implemented]
  index.ts       public entry: re-exports + facade + design types
```

## License

GPL-3.0-or-later, matching 5chan.
