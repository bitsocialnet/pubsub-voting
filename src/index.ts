/**
 * Public entry.
 *
 * Implemented today (pure, offline, unit-tested): the zod schemas, canonical dag-cbor
 * encoding, topic derivation, manifest derivation, and the `PubsubVoter` facade
 * (construction, contest caching, read-only enforcement). The live engine
 * (CRDT/transport/verify/tally/chain) is still design-only; facade methods that need
 * it throw `NotImplementedError`. See DESIGN.md for architecture and build order.
 */

// Schemas (runtime values) and their inferred types.
export * from "./schema/common.js";
export * from "./schema/votes.js";
export * from "./schema/criteria.js";

// Interpreters: a single kind, one file per `type`, each owning its option schema and a
// numeric `evaluate` (the eligibility slot gates on `> 0`, the weight slot uses the
// magnitude), plus the registry (built-ins, the host-shadowing resolver, and criteria
// validation). The leaf interpreters read through the injected viem `PublicClient`
// (`ctx.chain`). Interpreter composition (combining several into one slot) is a
// documented future extension, not a built-in — see DESIGN.md "Future improvements".
export * from "./interpreters/erc721-min-balance.js";
export * from "./interpreters/constant.js";
export * from "./interpreters/erc20-balance.js";
export * from "./interpreters/registry.js";

// Implemented runtime: encoding, topic, manifest, errors, identity seam, facade.
export * from "./encoding/canonical.js";
export * from "./topic.js";
export * from "./manifest/manifest.js";
export * from "./errors.js";
export * from "./client/voter.js";
// Identity seam: the EIP-712 ballot builder + constants a host needs to implement a
// signer, plus the signer interface itself.
export * from "./signer/eip712.js";
export type { VoteSigner } from "./signer/types.js";

// Design interfaces (types only) for the engine that is not yet implemented.
export type * from "./interpreters/types.js";
export type * from "./chain/types.js";
export type * from "./verify/types.js";
export type * from "./crdt/types.js";
export type * from "./transport/types.js";
export type * from "./tally/types.js";
