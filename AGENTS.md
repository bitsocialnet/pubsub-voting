# Agent Instructions for @bitsocial/pubsub-votes

Trustless pubsub voting library that runs on a host's shared libp2p/Helia node. The **foundation and public facade are implemented** (schemas, canonical encoding, topic derivation, manifest derivation, the `PubsubVoter` facade); the **live engine** (CRDT, transport, verify, tally, chain reads) is still **design only** and its facade methods throw `NotImplementedError`. Read [DESIGN.md](./DESIGN.md) before changing anything.

## Scope rules

- **MUST** keep the core (`src/schema/`, `src/rules/`, `src/chain/`, `src/crdt/`, `src/tally/`, `src/verify/`) free of any `libp2p` / `helia` import. Network code lives only under `src/transport/`. This is what keeps the engine unit-testable without a network.
- **MUST** keep this library out of pkc-js's protocol concerns. It consumes pkc-js, it does not modify it. Anything chain-related (balance reads, wallet binding, chainTicker-to-RPC) lives here, never upstream.
- **MUST NOT** start a libp2p node. Accept an injected handle from the host (today `pkc.clients.libp2pJsClients[key]._helia`).
- **MUST NOT** use `any` or cast to `any` without asking. This repo stays fully typed.

## Before committing

- **MUST** run the full test suite (`npm test`) before every commit and confirm it passes. Do not commit with failing or skipped tests. Also run `npm run typecheck` and `npm run typecheck:examples` when changing types or the public API.

## Documentation

- **MUST** update [README.md](./README.md) (the "Usage" section) in the same change whenever the public API changes — anything exported from [src/index.ts](./src/index.ts): the `PubsubVoter` constructor/options, the injected seams (`HeliaInstance`, `ChainClientFactory`, `VoteSigner`), the `VoteNetwork`/`VoteClient` methods, or the pure helpers (`topicFor`, `deriveCriteria`). README usage snippets must stay copy-pasteable and match the real types. Keep [examples/](./examples/) in sync too.

## Dependencies

- Pin **exact** versions (no `^`, no `~`, no `*` in dependency ranges).
- Match pkc-js's exact versions for anything that touches Merkle-DAG bytes or the shared node (`zod`, `multiformats`, `cborg`, `@ipld/dag-cbor`, `uint8arrays`, `@noble/curves`, `helia`, `@libp2p/*`) so DAG nodes interop with the host's Helia 6 node.

## Schema rules

- Schemas are zod v4 (`z.looseObject`, `z.record(key, value)`, `z.strictObject`/`.strict()`, `z.discriminatedUnion`). Check `package.json` for the exact zod version before using version-sensitive APIs.
- The criteria document must be canonically encodable with dag-cbor (no `undefined`, sorted keys), because `topic = CID(dag-cbor(criteria))`. A non-canonical criteria object is a bug: it changes the topic.
- Each rule owns its own option schema. The top-level `CriteriaSchema` keeps `rule`/`weight` loose (`{ type, ...options }`) so custom rules can register without a schema change.
- A vote bundle carries **no pkc-js author**. The voting wallet signs each bundle directly as EIP-712 typed data; the bundle is `{ address, votes, blockNumber, signature }` where `address` MUST equal the address recovered from `signature`. You may reuse pkc-js's detached-signature shape (`{ signature, type }`) for the `signature` field, but do not carry a pkc-js author object or an author→wallet binding. See [DESIGN.md, Votes wire](./DESIGN.md).

## When implementing later (not now)

- Reproduce any reported bug deterministically in a test first.
- Vote-signature format: EIP-712 typed data signed by the voting wallet (no pkc-js author, no author→wallet binding). The model is decided; only the concrete EIP-712 `types` layout is open — pin it with a fixed test vector. See [DESIGN.md, Votes wire](./DESIGN.md) and [Open questions](./DESIGN.md#open-questions).
- **Cold-start head sync over the libp2p fetch protocol is not wired.** The `fetchHeadsFromPeer` seam (`src/transport/transport.ts`) is accepted but left unset, so `start()`'s cold start returns only local heads and relies on live gossip to converge. Wiring it needs pkc-js to register/expose a fetch service on the node: a responder that answers a topic→current-heads request, and a requester that pulls up to `k` peers' heads and validates each set **through the same gate** (`gate.validate(encodeHeads(heads), …)`), so a single liar cannot inject a bad vote nor hide an honest one. See [DESIGN.md, Transport](./DESIGN.md) and "Deferred pkc-js work".
- **Add a two-node gossipsub integration test** (real `@libp2p/gossipsub` 15.0.21, gated behind an integration flag) pinning the await-before-`forwardMessage` behavior the forward-gate depends on: an invalid bundle is NOT forwarded and its sender is `reject`-scored (P₄); a valid bundle IS forwarded and merges on the peer; a fetch that exceeds the 10s deadline yields `ignore` with no penalty. The pure decision logic is already unit-tested (`src/transport/gossip-validator.test.ts`) — this pins the real-gossipsub timing a fake cannot prove.
- Never include identifying information (absolute home paths, usernames, hostnames, personal emails) in issues, PRs, or commit messages.
