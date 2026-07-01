# @bitsocial/pubsub-votes

Trustless, leaderless voting over libp2p pubsub, designed to run on top of a host node's shared libp2p/Helia instance.

> **Status: foundation + facade implemented; engine still design.** Implemented and unit-tested today: the zod schemas, canonical dag-cbor encoding, topic derivation, manifest derivation, and the `PubsubVoter` facade (construction, per-contest caching, read-only enforcement). The live engine — CRDT, transport, verify, tally, chain reads — is still design-only, so `start`/`getTally`/`castVotes` throw `NotImplementedError` for now. See [DESIGN.md](./DESIGN.md) for the architecture, build order, and [open questions](./DESIGN.md#open-questions).

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
- **Votes are a Merkle-CRDT.** A signed `Votes` bundle is a DAG node; only head CIDs travel over pubsub; missing history is fetched by CID. State is a last-write-wins set keyed by wallet, so aggregation is a monotonic union: a peer can omit a vote but can never subtract one that an honest peer serves.
- **Eligibility and weight are data, not code.** A fixed interpreter registry (mirroring pkc-js's challenge registry) maps a `type` string to a verifier. v1 ships `erc721-min-balance` eligibility (5chan Pass) and `constant` weight (1 pass = 1 vote), with `erc20-balance` reserved for a pass + BSO combo (see [Weighted voting](#weighted-voting)).

See [DESIGN.md](./DESIGN.md) for the full rationale, including how this resists vote-dropping and how criteria upgrades fork cleanly.

## Usage

The library never starts a node and never takes a host SDK (there is no `pkc` argument). A host passes its own running Helia node in directly and injects up to three seams into a single `PubsubVoter`:

| Seam | Type | Required | Purpose |
|---|---|---|---|
| `helia` | `HeliaInstance` | yes | the host's running Helia node; must carry a gossipsub service at `libp2p.services.pubsub` (else `MissingPubsubError`) and a `blockstore` (else `MissingBlockstoreError`) |
| `chains` | `ChainClientFactory` | yes | builds a viem `PublicClient` per chain; interpreters read through it for eligibility and weight |
| `signer` | `VoteSigner` | no | the voting wallet's address + EIP-712 ballot signing; omit for a read-only voter |

### Construct a voter

```ts
import { PubsubVoter } from "@bitsocial/pubsub-votes";

const voter = new PubsubVoter({
  helia,                      // the host's Helia node; needs a gossipsub service at libp2p.services.pubsub + a blockstore
  chains: viemChainFactory(), // ({ chain, config }) => viem PublicClient
  signer: mySigner            // optional; omit → read-only voter
});
```

Construction throws `MissingPubsubError` or `MissingBlockstoreError` if the node lacks a usable pubsub service or blockstore — the library fails fast rather than letting a later `publish`/`subscribe`/`fetch` fail obscurely. ("Bitswap" is not a separately checkable property — it is a block broker wired beneath `blockstore` — so the validated guarantee is a well-formed blockstore, the surface bitswap retrieves through.)

### Read a tally (no signer needed)

```ts
const contest = await voter.contest(criteria); // criteria: one validated CriteriaSchema document
await contest.start();
const tally = await contest.getTally();
const winner = tally.ranking[0]?.board;
```

### Cast or withdraw a vote (needs a signer)

```ts
await contest.castVotes([{ board: "12D3KooW...", vote: 1 }]); // v1: one upvote per topic
await contest.castVotes([]);                                  // withdraw: empty bundle supersedes under LWW
```

`castVotes` on a voter built without a `signer` throws `ReadOnlyError`.

### Many contests from one manifest

A 5chan-style directory manifest derives one contest (one topic) per slot:

```ts
const contests = await voter.contestsFromManifest(manifest); // → VoteNetwork[]
```

### Pure helpers (no node, no network)

```ts
import { topicFor, deriveCriteria } from "@bitsocial/pubsub-votes";

const topic = await topicFor(criteria);       // "bitsocial-votes/" + CID(dag-cbor(criteria))
const allCriteria = deriveCriteria(manifest); // defaults ⊕ each entry, each validated
```

Full, type-checked call patterns for a pkc-js host, a plebbit/seedit host, and a read-only consumer are in [examples/](./examples/).

### Custom interpreters

Eligibility and weight are a single flat registry of interpreters, one `type` per file, mirroring the pkc-js challenge registry. Each interpreter owns its option schema and is evaluated at the bundle's bucket block. Chain-reading interpreters get `ctx.chain` — the viem `PublicClient` for their `options.chain` — and write their own reads (`readContract`, `getBalance`, ...), pinning each call to the sampled block with `blockNumber: BigInt(ctx.blockNumber)`. There is **one kind**: `evaluate → number`, a non-negative score where `0` means "does not qualify". The criteria has two *slots* drawing from the one registry — the **eligibility** slot treats the score as a gate (`> 0` admits), the **weight** slot as the vote's magnitude. A wallet's vote counts as `eligibility > 0 ? weight : 0`. An interpreter that needs a threshold returns `0` below it (so `erc721-min-balance` and `erc20-balance`'s optional `min` can gate), which lets the same interpreter serve either slot.

Built-ins: `erc721-min-balance` (v1), `constant` (v1), and `erc20-balance` (reserved for the pass + BSO combo — see [Weighted voting](#weighted-voting)). A host adds or shadows interpreters by `type` via the `interpreters` option — this is how clients like 5chan or seedit register custom rules without forking the library:

```ts
import { PubsubVoter, type Interpreter } from "@bitsocial/pubsub-votes";
import { z } from "zod";

const seeditModAllowlist: Interpreter<{ type: "seedit-mod-allowlist"; allow: string[] }> = {
  type: "seedit-mod-allowlist",
  optionsSchema: z.object({ type: z.literal("seedit-mod-allowlist"), allow: z.array(z.string()) }),
  async evaluate({ options, walletAddress }) {
    return options.allow.includes(walletAddress) ? 1 : 0; // gate: 1 admits, 0 rejects
  }
};

const voter = new PubsubVoter({
  libp2p, chains,
  interpreters: { "seedit-mod-allowlist": seeditModAllowlist } // flat map; shadows/extends built-ins by `type`
});
```

A custom `type` becomes part of `dag-cbor(criteria)`, so it is provably pinned to the topic it runs on, and a client that does not implement a `type` named in `criteria.requires.interpreters` throws `UnknownInterpreterError` and recuses itself rather than miscounting.

### Weighted voting

v1 ships `constant` weight (one Pass, one vote) **on purpose** — it resists whale dominance and downvote weaponization. But weight is a *magnitude*: any interpreter that returns a holding or balance turns votes into holder-weighted power with no engine change. Keep the Pass gate in `eligibility` and swap the `weight` slot:

```ts
import type { InterpreterRef } from "@bitsocial/pubsub-votes";

// Among Pass-holders, voting power = BSO balance: 1000 BSO ⇒ 1000 votes.
const bsoWeight: InterpreterRef = { type: "erc20-balance", chain: "base", contract: "0x…BSO", decimals: 18 };

// Or one vote per Pass held — 5 Passes ⇒ 5 votes (the gate interpreter, reused as weight).
const passCountWeight: InterpreterRef = { type: "erc721-min-balance", chain: "base", contract: "0x…Pass", min: 1 };
```

List every interpreter used in `criteria.requires.interpreters`. This is a **capability, not 5chan's default**: token-weighting carries governance/abuse questions, and balance-derived weight drops the lazy-tally ceiling (see [DESIGN.md, Open questions](./DESIGN.md#open-questions)). A full, derivable document is in [examples/weighted.ts](./examples/weighted.ts).

## Layout

```
src/
  schema/        zod schemas (criteria, votes, shared wire primitives) + inferred types
  encoding/      canonical dag-cbor encoding                      [implemented]
  topic.ts       topic = "bitsocial-votes/" + CID(dag-cbor)       [implemented]
  manifest/      derive one criteria document per contest         [implemented]
  signer/        VoteSigner seam + EIP-712 ballot typed data       [implemented]
  client/        PubsubVoter facade + per-contest VoteNetwork     [implemented]
  errors.ts      NotImplemented/ReadOnly/MissingPubsub/Blockstore [implemented]
  interpreters/  one file per `type` + registry/resolver           [leaves implemented]
  chain/         ChainClient = viem PublicClient (historical-block reads)
  crdt/          Merkle-CRDT interfaces                           [design only]
  transport/     helia/libp2p transport (pubsub + blockstore)     [requireHeliaServices live; rest design]
  tally/         tally interfaces                                 [design only]
  index.ts       public entry: re-exports + facade + design types
```

## License

GPL-3.0-or-later, matching 5chan.
