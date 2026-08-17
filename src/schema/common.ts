import { z } from "zod";

/**
 * Shared wire primitives.
 *
 * There is no pkc-js author in this library: a vote is signed directly by the
 * gating-chain wallet that holds the Pass/ERC-20 (see DESIGN.md "Identity: the
 * voting wallet, nothing else"). What survives from the old author/wallet schema is
 * one small, identity-agnostic primitive reused across the wire:
 *   - `SignatureSchema`: the detached `{ signature, type }` shape (kept from pkc-js),
 *     here carrying the wallet's EIP-712 ballot signature.
 *
 * Chains are named by numeric `chainId` (`criteria.bucketChainId`), never by ticker: a ticker is
 * a label local to a document, and two documents spelling one chain differently would be two
 * topics for one contest.
 */

/**
 * A detached signature with an explicit scheme tag. For a Votes bundle the `type` is
 * the EIP-712 scheme ({@link EIP712_SIGNATURE_TYPE}) and `signature` is the hex
 * signature the voting wallet produced over the ballot typed data.
 */
export const SignatureSchema = z.object({
    signature: z.string().min(1),
    type: z.string().min(1)
});

export type Signature = z.infer<typeof SignatureSchema>;
