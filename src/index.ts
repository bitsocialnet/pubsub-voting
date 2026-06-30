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
export * from "./schema/author.js";
export * from "./schema/votes.js";
export * from "./schema/criteria.js";
export * from "./interpreters/options.js";

// Implemented runtime: encoding, topic, manifest, errors, identity seam, facade.
export * from "./encoding/canonical.js";
export * from "./topic.js";
export * from "./manifest/manifest.js";
export * from "./errors.js";
export * from "./client/voter.js";
export type { VoteSigner } from "./signer/types.js";

// Design interfaces (types only) for the engine that is not yet implemented.
export type * from "./interpreters/types.js";
export type * from "./chain/types.js";
export type * from "./verify/types.js";
export type * from "./crdt/types.js";
export type * from "./transport/types.js";
export type * from "./tally/types.js";
