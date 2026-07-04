import type { VotesBundle } from "../schema/votes.js";

/**
 * Verification interfaces, design only.
 *
 * Verification has one cheap, offline stage (no chain reads) and one chain stage:
 *   1. offline: recover the EIP-712 signer and check it equals bundle.address, and the
 *      criteria-bound constraints (votes.length <= maxVotesPerAddress, vote in range).
 *      Pairwise-distinct board.publicKeys is enforced even earlier, by
 *      VotesBundleSchema at parse time (see DESIGN.md "Votes wire")
 *   2. chain: the `rule` (gate) + weight rules read state at the bucket block, and
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

/**
 * A passing full-bundle verdict. Beyond `valid: true` it carries the work the gate already
 * did so downstream stages need not redo it:
 *   - `ruleScore`: the gate `rule`'s score for the voting wallet at the bucket block
 *     (always `> 0n` here — `0n` would have failed the gate).
 *   - `resolvedNames`: for each vote that carried a `board.name`, the `publicKey` the name
 *     resolved to (equal to the claimed key, since a mismatch fails the gate). Votes with no
 *     name are absent. Lets a UI show a verified name without re-resolving.
 */
export interface BundleVerdictValid {
    valid: true;
    ruleScore: bigint;
    resolvedNames: Record<string, string>;
}

/**
 * The full validity verdict for one bundle: signature + criteria constraints + on-chain
 * gate (`rule`) + board-name resolution, in cheap-to-expensive order with early exit. This is
 * what the gossip forward-gate runs *before* re-forwarding (see DESIGN.md "Transport"): a
 * failing verdict is dropped and never forwarded, stored, or counted. Weight *magnitude*
 * (ranking, not validity) is deliberately NOT computed here — the tally derives it lazily.
 */
export type BundleVerdict = BundleVerdictValid | VerifyFail;

/** Runs the full validity pipeline for one already-fetched, schema-parsed bundle. */
export interface BundleVerifier {
    verify(bundle: VotesBundle): Promise<BundleVerdict>;
}
