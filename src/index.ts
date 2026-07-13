/**
 * Public entry.
 *
 * The engine is implemented and unit-tested: the zod schemas, canonical dag-cbor encoding,
 * topic derivation, the verify pipeline (signature + constraints +
 * gate + name resolution), the state-based grow-only LWW winner-set CRDT, the tally, and the
 * transport's validate-before-forward gossip gate. The public facade is the reactive
 * `PubsubVoter` / `Contest` (`createContest`) / `ContestVote` (`createContestVote`) trio. Keeping a
 * live vote from decaying is the consuming client's job — this library publishes each vote once
 * (see `republishIntervalBuckets` and DESIGN.md "Republishing is the client's job"). See DESIGN.md
 * for architecture, and "Transport" for the forward-gate that verifies a bundle (signature,
 * on-chain gate, community-name resolution) before gossipsub re-forwards it.
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

// Implemented runtime: encoding, topic, errors, identity seam, facade.
export * from "./encoding/canonical.js";
export * from "./topic.js";
export * from "./errors.js";
export * from "./client/voter.js";
// There is no library-side vote persistence: republishing a live vote is the client's job, so
// the client tracks what it voted for (see DESIGN.md "Republishing is the client's job"). The
// facade exports `republishIntervalBuckets` to help the client schedule its own refreshes.
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
