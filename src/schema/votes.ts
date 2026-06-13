import { z } from "zod";
import { SignatureSchema, VoteAuthorSchema } from "./author.js";

/**
 * The Votes wire format.
 *
 * One bundle per author per heartbeat. The bundle is the unit of signing and the
 * value stored at each Merkle-CRDT node. See DESIGN.md "Votes wire" and "CRDT".
 */

/**
 * A single vote inside a bundle.
 * - `contest` is a directory-slot code; it must be one of `criteria.contests`.
 * - `board` is the community address being voted for.
 * - `vote` is numeric; its allowed range comes from `criteria.voteSchema`
 *   (v1 is upvote-only, so exactly 1). Range is enforced at verify time, not here,
 *   because the bounds live in the criteria, not in the wire type.
 */
export const VoteSchema = z.object({
    contest: z.string().min(1),
    board: z.string().min(1),
    vote: z.number().int()
});

/**
 * The portion of a bundle that is covered by the signature. The property order
 * here is the canonical signing order (see VotesSignedPropertyNames). Mirrors the
 * pkc-js `_signJson` pattern: cbor-encode exactly these properties, then ed25519
 * sign the bytes.
 */
export const VotesBundleSignedSchema = z.object({
    author: VoteAuthorSchema,
    votes: z.array(VoteSchema),
    blockNumber: z.number().int().nonnegative()
});

/** The full bundle: signed payload plus the author's ed25519 signature over it. */
export const VotesBundleSchema = VotesBundleSignedSchema.extend({
    signature: SignatureSchema
});

/**
 * Exactly the properties covered by `VotesBundle.signature`, in canonical order.
 * The verifier and signer must agree on this list and its order.
 */
export const VotesSignedPropertyNames = ["author", "votes", "blockNumber"] as const;

export type Vote = z.infer<typeof VoteSchema>;
export type VotesBundleSigned = z.infer<typeof VotesBundleSignedSchema>;
export type VotesBundle = z.infer<typeof VotesBundleSchema>;
