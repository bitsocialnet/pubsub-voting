import type { VotesBundle } from "../schema/votes.js";

/**
 * Verification interfaces, design only.
 *
 * Verification has two cheap, offline stages (no chain reads) and one chain stage:
 *   1. bundle signature: ed25519 over cbor(VotesSignedPropertyNames), against author.address
 *   2. wallet binding: the eligibility-chain wallet's signature binds it to author.address
 *   3. eligibility + weight: interpreters read chain state at the bucket block
 *
 * The tally runs stage 3 lazily (only where it can change the visible ranking),
 * so these are split.
 */

export type VerifyOk = { valid: true };
export type VerifyFail = { valid: false; reason: string };
export type VerifyResult = VerifyOk | VerifyFail;

/** Stage 1 + 2: signature and binding only. No chain access. */
export interface OfflineBundleVerifier {
    /** ed25519 signature over the signed property names, against author.address. */
    verifyBundleSignature(bundle: VotesBundle): Promise<VerifyResult>;

    /**
     * The eligibility-chain wallet's `signature` binds wallet.address to
     * author.address (EIP-191). The exact signed-message format is an open question
     * (see DESIGN.md); confirm the Bitsocial convention before implementing.
     */
    verifyWalletBinding(args: { bundle: VotesBundle; chain: string }): Promise<VerifyResult>;

    /**
     * Reject a wallet binding whose timestamp is lower than the last seen for that
     * wallet (the issue #25 revocation mitigation). Requires per-wallet state.
     */
    isBindingTimestampFresh(args: { walletAddress: string; timestamp: number }): boolean;
}
