/**
 * Public entry.
 *
 * The engine is implemented and unit-tested: the zod schemas, canonical dag-cbor encoding,
 * topic derivation, manifest derivation, the verify pipeline (signature + constraints +
 * gate + name resolution), the state-based grow-only LWW winner-set CRDT, the tally, and the
 * transport's validate-before-forward gossip gate (`VoteNetwork.start`/`castVotes`/`getTally`
 * are live), plus the `PubsubVoter` client-level republish scheduler and durable vote-intent
 * persistence (Node SQLite / browser IndexedDB), so the full `start`/`stop`/`destroy` lifecycle
 * works. See DESIGN.md for architecture, and "Transport" for the forward-gate that verifies a
 * bundle (signature, on-chain gate, community-name resolution) before gossipsub re-forwards it.
 */

// Schemas (runtime values) and their inferred types.
export * from "./schema/common.js";
export * from "./schema/votes.js";
export * from "./schema/criteria.js";

// Rules: a single kind, one file per `type`, each owning its option schema and an
// `evaluate` returning `{ score: bigint }` (the `rule` slot gates on `score > 0n`,
// the weight slot uses the magnitude), plus the registry (built-ins, the host-shadowing resolver, and criteria
// validation). The leaf rules read through the injected viem `PublicClient`
// (`ctx.chain`). Rule composition (combining several into one slot) is a
// documented future extension, not a built-in — see DESIGN.md "Future improvements".
// v1 ships the NFT path only: `erc721-min-balance` + `constant`. `erc20-balance` stays in
// the tree but is not registered or re-exported — see ROADMAP.md ("Deferred").
export * from "./rules/erc721-min-balance.js";
export * from "./rules/constant.js";
export * from "./rules/registry.js";

// Implemented runtime: encoding, topic, manifest, errors, identity seam, facade.
export * from "./encoding/canonical.js";
export * from "./topic.js";
export * from "./manifest/manifest.js";
export * from "./errors.js";
export * from "./client/voter.js";
// Vote-intent persistence is internal: the voter selects a backend by environment (SQLite
// under `dataPath` on Node, IndexedDB in the browser) — there is no host-facing store seam,
// only the `dataPath` option. The `VoteStore` contract and backends stay in `src/store/`.
// See DESIGN.md "Persistence".
// Identity seam: the EIP-712 ballot builder + constants a host needs to implement a
// signer, plus the signer interface itself.
export * from "./signer/eip712.js";
export type { VoteSigner } from "./signer/types.js";

// The engine's type seams (types only): the interfaces the implemented rules, chain reads,
// verify pipeline, CRDT, transport, and tally are written against.
export type * from "./rules/types.js";
export type * from "./chain/types.js";
export type * from "./verify/types.js";
export type * from "./crdt/types.js";
export type * from "./transport/types.js";
export type * from "./tally/types.js";
