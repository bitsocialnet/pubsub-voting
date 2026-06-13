# Design: @bitsocial/pubsub-votes

This document is the design of record. The repo currently implements **schemas and interfaces only**; this explains what they are for and how the runtime will behave once built.

## Context

- **Consumer:** [5chan](https://github.com/bitsocialnet/5chan) and its [competitive directory system](https://github.com/bitsocialnet/5chan/blob/master/README.md#competitive-directory-system). Many boards compete for each directory slot; only the highest-voted board appears on the homepage. Current curation is manual pull requests to [`5chan-directories.json`](https://github.com/bitsocialnet/lists/blob/master/5chan-directories.json). This library replaces that with holder-decided, censorship-resistant voting.
- **Origin:** [pkc-js issue #25](https://github.com/pkcprotocol/pkc-js/issues/25), which sketched pubsub voting (settings in the topic, bucketized block numbers, per-bucket heartbeat republish). This design keeps the good parts and replaces the bare heartbeat with a Merkle-CRDT.
- **Host:** [pkc-js](https://github.com/pkcprotocol/pkc-js) (Public Key Communities) provides the shared libp2p/Helia node, the author identity, and the ed25519 signing primitives. This library adds everything chain-related and the CRDT, none of which exist in pkc-js.

## Decisions

- **State model: Merkle-CRDT.** Votes form a last-write-wins element-set keyed by wallet, carried in a Merkle-DAG. Broadcast head CIDs over pubsub; fetch the diff by CID. Precedent: Merkle-CRDTs (Sanjuán et al., Protocol Labs 2020), `go-ds-crdt` (powers IPFS Cluster's shared pinset with no leader), OrbitDB, Secure Scuttlebutt.
- **Weighting v1: 5chan Pass only.** ERC-721 ownership gates eligibility; weight is constant (1 pass = 1 vote). The interpreter design keeps a combo path open (pass eligibility + BSO ERC-20 weight) without a redesign.
- **Voting is upvote-only in v1.** Downvotes turn a contest into a cheap weapon against competitors; approval-style upvotes (vote for as many boards as you like, capped by `maxVotesPerAddress`) avoid that. The wire keeps a numeric `vote` field so a future criteria could widen the range.

## Why this resists the hard failure modes

### Can always-online peers drop votes?

No single peer can remove a vote from the network.

1. **Gossipsub floods.** Every honest peer re-forwards every valid message to its mesh. Declining to forward only affects a peer's own links; as long as one honest path connects you to the voter, you receive the vote.
2. **Aggregation is a monotonic union (a CRDT join).** Votes are signed and idempotent, so combining two peers' sets can only add, never remove. A liar can omit a vote from what it serves you but cannot subtract one that an honest peer serves.
3. **Cold start pulls from k peers and unions.** On join, fetch current heads from several independent peers via the libp2p fetch protocol and union them. To hide a vote, every source you consult must lack it.

The residual threat is an eclipse attack (all your peers are sybils), which is the standard p2p threat, not specific to voting. Mitigations are high peer count and diverse bootstrap/rendezvous.

### Is there precedent for agreed state over pubsub?

Yes. Merkle-CRDT is exactly "a pubsub topic whose peers converge on a shared latest state with no leader." `go-ds-crdt` runs this in production for IPFS Cluster. The Merkle structure also makes missing data **detectable**: a head CID commits to its whole history, so a client can tell when a peer served a truncated state and heal the diff by CID. The open-membership limit (you cannot learn about heads nobody told you) is what the multi-peer fetch in the previous section covers.

### Who publishes snapshots?

Anyone, trustlessly. A snapshot is a head CID plus compacted state that every client re-verifies locally. The publisher has zero authority because state only ever joins by union, so a bad snapshot cannot subtract or forge. 5chan can run a couple of always-on availability nodes as convenience infrastructure (the eth-bootnode / IPFS-gateway pattern), not as an oracle. If they vanish, live gossip plus peer fetch still works with slower cold start.

### What happens when criteria change on upgrade?

A criteria change is a new interpreter `type` and/or new criteria bytes, which is a new CID, which is a **new topic**. Old clients that do not implement a `type` named in `requires` recuse themselves rather than miscount. The old topic drains as people update. There is no state migration because the heartbeat republish means there is no long-lived server state.

## Components

```
schema/        the wire and the criteria document (zod)
interpreters/  type -> verifier registry; eligibility + weight
chain/         historical-block reads (ERC-721 / ERC-20), chainTicker -> RPC
verify/        bundle signature, wallet binding, timestamp monotonicity   [interfaces only for now]
crdt/          Merkle-clock + LWW reduction
transport/     pubsub (broadcast heads) + libp2p fetch (cold-start sync)
tally/         deterministic per-contest aggregation, lazy top-down verify
```

The first three plus `verify/`, `crdt/`, and `tally/` have no libp2p dependency, so the engine is unit-testable without a network. libp2p appears only in `transport/`.

### Criteria document

Shipped static in the client bundle (offline), and `topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`. dag-cbor is canonical (sorted keys, rejects `undefined`), so identical bytes yield an identical topic, which is the self-validating binding. Optionally also publish the bytes to IPFS for out-of-band verifiers. One topic for all directories (the criteria lists every contest; each vote names its slot) so a client joins once. The `requires` block is the dependency manifest and doubles as version negotiation.

### Votes wire

```
VotesBundle { author, votes: Vote[], blockNumber, signature }
Vote        { contest, board, vote }
```

The author signs the bundle with their ed25519 key over a cbor-encoded set of signed property names, mirroring pkc-js `_signJson` in [src/signer/signatures.ts:142](https://github.com/pkcprotocol/pkc-js/blob/master/src/signer/signatures.ts#L142). Constraints: `votes.length <= maxVotesPerAddress`, and each `vote` within `voteSchema` (v1: exactly 1).

### Wallet binding (net-new; pkc-js has the schema but no verifier)

`author.wallets[chain] = { address, timestamp, signature }`, shape from [pkc-js src/schema/schema.ts:35](https://github.com/pkcprotocol/pkc-js/blob/master/src/schema/schema.ts#L35). The eligibility-chain wallet signs an EIP-191 message binding it to `author.address`; verification will use `viem.verifyMessage`. A binding whose `timestamp` is lower than the last seen for that wallet is rejected (the issue #25 revocation mitigation). **The exact signed-message format is an open question** (see below); pkc-js defines none today, so do not invent one before confirming the Bitsocial convention.

### CRDT

Last-write-wins element-set keyed by the eligibility-chain wallet address; value is the bundle; conflict resolution is highest `blockNumber`, tiebreak lowest bundle CID (for determinism across clients). Each bundle is a dag-cbor DAG node linking the heads known at signing, stored in the host's Helia blockstore. Only head CIDs go over pubsub; missing ancestors are fetched by CID. Prune bundles older than `voteExpiryBuckets` and those superseded per wallet.

### Tally

Deterministic per-contest aggregation. Verify lazily top-down: only verify the votes (signature, wallet binding, chain reads) that can still change the visible ranking, stopping once the remaining unverified weight cannot flip the order. Render provisional immediately and refine.

## Interpreters

Mirror the pkc-js challenge registry ([src/runtime/node/community/challenges/index.ts:94](https://github.com/pkcprotocol/pkc-js/blob/master/src/runtime/node/community/challenges/index.ts#L94)): a `Record<string, interpreter>` where user entries shadow builtins. Each interpreter owns its option schema and is evaluated at the bundle's bucket block via a `ChainClient`.

| Kind | type | v1 | Purpose |
|---|---|---|---|
| eligibility | `erc721-min-balance` | yes | Hold at least N of an ERC-721 (5chan Pass) |
| weight | `constant` | yes | Fixed weight per eligible voter (1 pass = 1 vote) |
| weight | `erc20-balance` | reserved | Weight by ERC-20 balance (BSO) for the combo path |
| weight | `sum` | reserved | Combine weight terms |

## Dependencies

Match pkc-js exact versions so DAG nodes interop with the shared Helia 6 node: `zod 4.3.6`, `multiformats 13.4.2`, plus (added by the implementation later) `cborg 4.5.8`, `@ipld/dag-cbor`, `uint8arrays 5.1.0`, `@noble/curves 2.2.0`. Add `viem` for isomorphic chain reads and `verifyMessage` (pkc-js has neither). `@pkcprotocol/pkc-js`, `helia`, and `@libp2p/interface` are peer dependencies so libp2p is not double-bundled.

## Deferred pkc-js work

pkc-js exposes the node only as `pkc.clients.libp2pJsClients[key]._helia` ([src/helia/libp2pjsClient.ts:20](https://github.com/pkcprotocol/pkc-js/blob/master/src/helia/libp2pjsClient.ts#L20)), private-by-convention and typed as raw Helia internals; the libp2p `fetch` service is registered but not exposed. Once this library's needs are firm, add a narrow, documented, version-stable accessor on pkc-js to subscribe/publish a topic and register a protocol/fetch responder, not the raw Helia object (its type churns, for example the multiformats 13/14 split). Track as a pkc-js issue and reference it here.

## Open questions

- **Wallet-binding signed-message format.** Reuse the existing Bitsocial/plebbit author-wallet convention (likely `{ domainSeparator, authorAddress, timestamp }` signed EIP-191), do not invent. pkc-js defines no format today.
- **Signer reuse vs direct crypto.** `@pkcprotocol/pkc-js` only exports `.`, `./challenges`, `./rpc`. If the signer utilities are not on the top-level entry, depend on `@noble/curves` + `cborg` directly (the same versions pkc-js uses).
- **Snapshot/compaction format** for fast cold start. Can land after the live path works.
