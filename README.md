# @bitsocial/pubsub-votes

Trustless, leaderless voting over libp2p pubsub, designed to run on top of a host node's shared libp2p/Helia instance.

> **Status: foundation + facade implemented; engine still design.** Implemented and unit-tested today: the zod schemas, canonical dag-cbor encoding, topic derivation, manifest derivation, and the `PubsubVoter` facade (construction, per-contest caching, read-only enforcement). The live engine — CRDT, transport, verify, tally, chain reads — is still design-only, so `start`/`getTally`/`castVotes` throw `NotImplementedError` for now. See [DESIGN.md](./DESIGN.md) for the architecture, build order, and [open questions](./DESIGN.md#open-questions).

## What it is for

The first consumer is [5chan](https://github.com/bitsocialnet/5chan), a serverless, adminless imageboard on the Bitsocial protocol. 5chan has a [competitive directory system](https://github.com/bitsocialnet/5chan/blob/master/README.md#competitive-directory-system): many boards compete for each directory slot (for example, multiple "Business & Finance" boards), but only the highest-voted one appears on the homepage. Today those assignments are curated by hand through pull requests to [`5chan-directories.json`](https://github.com/bitsocialnet/lists/blob/master/5chan-directories.json). This library is the planned replacement: directory voting that is decided by holders rather than by maintainers, with no server to trust.

The same engine generalizes to the original use case in [pkc-js issue #25](https://github.com/pkcprotocol/pkc-js/issues/25) (a default-communities list voted on over pubsub) and to any future Bitsocial client that needs holder-weighted, censorship-resistant curation.

## Why a separate library (not in pkc-js)

[pkc-js](https://github.com/pkcprotocol/pkc-js) (Public Key Communities) is the protocol layer: communities, publications, the challenge exchange. Voting is application/governance layer. Keeping it separate means:

- Chain-RPC and governance churn stay out of pkc-js core. pkc-js deliberately touches chains only for name resolution; it has no balance lookups, no chainTicker-to-RPC mapping, and no wallet-binding verification. This library owns all of that.
- The engine is reusable across clients and contests.
- The core (`schema/`, `verify/`, `crdt/`, `tally/`) is transport-agnostic and unit-testable without a network. libp2p only appears in `transport/`.

This library does not start its own node. It consumes the host's shared libp2p/Helia instance. With pkc-js today that handle is reached at `pkc.clients.libp2pJsClients[key]._helia`; a narrow, version-stable accessor on pkc-js is a planned follow-up (see [DESIGN.md, Deferred pkc-js work](./DESIGN.md#deferred-pkc-js-work)).

## Design at a glance

- **Settings live in the topic.** `topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`. Two peers on the same topic provably ran identical rules, so the network validates itself with no intermediary.
- **Votes are a Merkle-CRDT.** A signed `Votes` bundle is a DAG node; only head CIDs travel over pubsub; missing history is fetched by CID. State is a last-write-wins set keyed by wallet, so aggregation is a monotonic union: a peer can omit a vote but can never subtract one that an honest peer serves.
- **Eligibility and weight are data, not code.** A fixed interpreter registry (mirroring pkc-js's challenge registry) maps a `type` string to a verifier. v1 ships `erc721-min-balance` eligibility (5chan Pass) and `constant` weight (1 pass = 1 vote), with `erc20-balance` / `sum` reserved for a pass + BSO combo.

See [DESIGN.md](./DESIGN.md) for the full rationale, including how this resists vote-dropping and how criteria upgrades fork cleanly.

## Usage

The library never starts a node and never takes a host SDK (there is no `pkc` argument). A host adapts its own libp2p/Helia node to a `Libp2pHandle` and injects up to three seams into a single `PubsubVoter`:

| Seam | Type | Required | Purpose |
|---|---|---|---|
| `libp2p` | `Libp2pHandle` | yes | the host's shared node (publish / subscribe / fetch) |
| `chains` | `ChainClientFactory` | yes | builds a viem `PublicClient` per chain; interpreters read through it for eligibility and weight |
| `signer` | `VoteSigner` | no | author identity + ed25519 signing; omit for a read-only voter |

### Construct a voter

```ts
import { PubsubVoter } from "@bitsocial/pubsub-votes";

const voter = new PubsubVoter({
  libp2p: hostLibp2pHandle(), // host adapts pkc / plebbit / raw Helia → Libp2pHandle
  chains: viemChainFactory(), // ({ chain, config }) => viem PublicClient
  signer: mySigner            // optional; omit → read-only voter
});
```

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

Built-ins: `erc721-min-balance` (v1), `constant` (v1), `erc20-balance` and `sum` (reserved for the pass + BSO combo). A host adds or shadows interpreters by `type` via the `interpreters` option — this is how clients like 5chan or seedit register custom rules without forking the library:

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

## Layout

```
src/
  schema/        zod schemas (criteria, votes, author/wallet) + inferred types
  encoding/      canonical dag-cbor encoding                      [implemented]
  topic.ts       topic = "bitsocial-votes/" + CID(dag-cbor)       [implemented]
  manifest/      derive one criteria document per contest         [implemented]
  signer/        VoteSigner identity seam                         [implemented]
  client/        PubsubVoter facade + per-contest VoteNetwork     [implemented]
  errors.ts      NotImplementedError, ReadOnlyError               [implemented]
  interpreters/  one file per `type` + registry/resolver           [leaves implemented]
  chain/         ChainClient = viem PublicClient (historical-block reads)
  crdt/          Merkle-CRDT interfaces                           [design only]
  transport/     libp2p transport interfaces (pubsub + fetch)     [design only]
  tally/         tally interfaces                                 [design only]
  index.ts       public entry: re-exports + facade + design types
```

## License

GPL-3.0-or-later, matching 5chan.
