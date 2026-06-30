import { z } from "zod";
import { SignatureSchema } from "./common.js";

/**
 * The Votes wire format.
 *
 * One bundle per voting wallet per heartbeat, scoped to the topic's single contest.
 * The bundle is the value stored at each Merkle-CRDT node. An empty `votes` array is
 * the withdrawal/abstention form: a newer bundle (higher blockNumber) with no votes
 * supersedes an earlier one under LWW, removing the vote from the tally without
 * breaking the monotonic union. See DESIGN.md "Votes wire", "Cancelling a vote", and
 * "CRDT".
 *
 * The bundle is signed directly by the eligibility-chain wallet as EIP-712 typed data
 * (see signer/eip712.ts); `address` is that wallet and MUST equal the address recovered
 * from `signature`. There is no pkc-js author and no author->wallet binding.
 */

/**
 * A single vote inside a bundle. The contest is implied by the topic (one contest
 * per topic), so it is not repeated on the wire.
 * - `board` is the community address being voted for.
 * - `vote` is numeric; its allowed range comes from `criteria.voteSchema`
 *   (v1 is upvote-only, so exactly 1). Range is enforced at verify time, not here,
 *   because the bounds live in the criteria, not in the wire type.
 */
export const VoteSchema = z.object({
    board: z.string().min(1),
    vote: z.number().int()
});

/**
 * The full wire node: the voting wallet, its votes, the bucket block, and the wallet's
 * EIP-712 signature over the ballot. `address` is carried so the LWW key and chain reads
 * are available without re-recovering; it MUST equal `recoverTypedDataAddress(signature)`
 * (a forged `address` fails the recovery check at verify time). The signed payload is
 * the EIP-712 ballot built from the contest CID + chainId + `votes` + `blockNumber`
 * (see signer/eip712.ts), not these wire bytes directly.
 */
export const VotesBundleSchema = z.object({
    address: z.string().min(1),
    votes: z.array(VoteSchema),
    blockNumber: z.number().int().nonnegative(),
    signature: SignatureSchema
});

export type Vote = z.infer<typeof VoteSchema>;
export type VotesBundle = z.infer<typeof VotesBundleSchema>;
