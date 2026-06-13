# @bitsocial/pubsub-votes

Trustless, leaderless voting over libp2p pubsub, designed to run on top of a host node's shared libp2p/Helia instance.

> **Status: schema + design scaffold.** This repo currently contains only zod schemas, TypeScript design interfaces, and design docs. There is no runtime implementation yet. See [DESIGN.md](./DESIGN.md) for the architecture and [the open questions](./DESIGN.md#open-questions) before implementing.

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

## Layout

```
src/
  schema/        zod schemas (criteria, votes, author/wallet) + inferred types
  interpreters/  interpreter interfaces + v1/combo option schemas
  chain/         ChainClient interface (historical-block reads)
  crdt/          Merkle-CRDT interfaces
  transport/     libp2p transport interfaces (pubsub + fetch)
  tally/         tally interfaces
  index.ts       public entry: re-exports + VoteNetwork interface
```

## License

GPL-3.0-or-later, matching 5chan.
