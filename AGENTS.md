# Agent Instructions for @bitsocial/pubsub-votes

Trustless pubsub voting library that runs on a host's shared libp2p/Helia node. The **engine and client lifecycle are implemented** (schemas, canonical encoding, topic/manifest derivation, the `PubsubVoter` facade, the CRDT, transport, verify, tally, chain reads, the **client-level republish scheduler**, and durable vote-intent persistence via Node SQLite / browser IndexedDB — `VoteNetwork.start`/`castVotes`/`getTally` and the full `PubsubVoter.start`/`stop`/`destroy` lifecycle are live). The **live-delta transport is implemented too**: the pubsub payload is a two-kind union — one inline bundle per message, or a tiny **root record** — with root-record checkpoint sync (on-demand encode, suppressed topic heartbeat, libp2p-fetch pull with the `MissingFetchError` construction guard, divergent roots chased over directed bitswap) and a binary bundle block encoding. The **two-node gossipsub integration test is implemented** (`src/transport/integration/`, real `@libp2p/gossipsub` `16.0.3`, run via `npm run test:integration`, excluded from the unit `npm test`). What remains is host-side only: pkc-js registering gossipsub + `@libp2p/fetch` on the shared node. Read [DESIGN.md](./DESIGN.md) before changing anything.

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
- **Wire changes re-pin vectors.** The bundle block, message envelope, and checkpoint layouts are frozen by fixed test vectors (`src/crdt/codec.test.ts`, `src/transport/messages.test.ts`, `src/checkpoint/codec.test.ts`); any layout change is a breaking wire change that re-freezes them. The EIP-712 ballot vector (`src/signer/eip712.test.ts`) MUST NOT change — it is independent of the block encoding by design.
- **Two-node gossipsub integration test — done** (`src/transport/integration/two-node.integration.test.ts` + `harness.ts`): two real loopback libp2p + Helia nodes on `@libp2p/gossipsub` `16.0.3` (above the **>= 15.0.23** CVE-2026-46679 floor), excluded from the unit `npm test` and run via `npm run test:integration`. It pins what a fake cannot: an invalid inline bundle is NOT forwarded and its sender is `reject`-scored (P₄); a valid bundle IS forwarded and merges; a verify past the deadline yields `ignore` with no penalty and stays re-evaluable (uncached); a converged pair's matching root triggers no chase; a divergent root is chased over directed bitswap to convergence. The pure decision logic remains unit-tested (`src/transport/gossip-validator.test.ts`). It surfaced a real bug: the injected Helia `blockstore.get` is an async generator, now normalised by `adaptBlockstore` (`src/transport/helia.ts`).
- Never include identifying information (absolute home paths, usernames, hostnames, personal emails) in issues, PRs, or commit messages.
