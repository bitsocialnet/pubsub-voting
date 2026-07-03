import type { VotesBundle } from "../schema/votes.js";

/**
 * Verification interfaces, design only.
 *
 * Verification has one cheap, offline stage (no chain reads) and one chain stage:
 *   1. offline: recover the EIP-712 signer and check it equals bundle.address, and the
 *      criteria-bound constraints (votes.length <= maxVotesPerAddress, vote in range).
 *      Pairwise-distinct board.publicKeys is enforced even earlier, by
 *      VotesBundleSchema at parse time (see DESIGN.md "Votes wire")
 *   2. chain: eligibility + weight interpreters read state at the bucket block, and
 *      each vote's board.name claim is resolved through the injected nameResolvers
 *      (a name that does not resolve to the claimed publicKey drops the bundle)
 *
 * The tally runs stage 2 lazily (only where it can change the visible ranking), so the
 * cheap offline check is split out and runs first — a bad signature drops a vote for zero
 * chain reads. There is no separate wallet-binding stage: the single wallet signature is
 * the identity. See DESIGN.md "Identity: the voting wallet, nothing else" and "Tally".
 */

export type VerifyOk = { valid: true };
export type VerifyFail = { valid: false; reason: string };
export type VerifyResult = VerifyOk | VerifyFail;

/** Stage 1: ballot signature only. No chain access. */
export interface OfflineBundleVerifier {
    /**
     * Rebuild the EIP-712 ballot typed data from the criteria CID bytes + chainId + the
     * bundle's `votes` and `blockNumber` (see signer/eip712.ts), recover the signer with
     * `viem.recoverTypedDataAddress`, and check it equals `bundle.address`. No chain read.
     */
    verifyBundleSignature(args: { bundle: VotesBundle; criteriaCid: Uint8Array; chainId: number }): Promise<VerifyResult>;
}
