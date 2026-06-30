import type { Signature } from "../schema/common.js";
import type { BallotTypedData } from "./eip712.js";

/**
 * Identity seam (net-new).
 *
 * This is the third host-injected dependency, alongside the `HeliaInstance` (network +
 * blockstore) and `ChainClientFactory` (chain). It lets a host-agnostic core be driven by
 * pkc-js, plebbit, or a raw key without the library ever holding key material: the
 * library builds the EIP-712 ballot typed data and asks the host to sign it.
 *
 * The signer wraps the eligibility-chain wallet — the account that holds the Pass/ERC-20.
 * There is no pkc-js author and no author->wallet binding: the address recovered from the
 * ballot signature IS the voter (see DESIGN.md "Identity: the voting wallet, nothing
 * else"). A voter constructed without a signer is read-only (renders tallies, cannot
 * cast). See DESIGN.md "Votes wire".
 */
export interface VoteSigner {
    /**
     * The voting wallet's address (the eligibility-chain account holding the Pass/ERC-20).
     * Embedded as `bundle.address`; the verifier independently recovers it from the
     * signature, so a wrong value here fails verification rather than forging a vote.
     */
    address(): Promise<string> | string;
    /**
     * Sign the EIP-712 ballot typed data with the wallet key (e.g. viem
     * `account.signTypedData(typedData)`). The library builds the typed data; the private
     * key stays in the host. Returns the detached signature with its scheme tag
     * ({@link EIP712_SIGNATURE_TYPE}).
     */
    signBallot(typedData: BallotTypedData): Promise<Signature> | Signature;
}
