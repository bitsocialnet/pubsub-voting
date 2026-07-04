import { recoverTypedDataAddress } from "viem";
import type { VotesBundle } from "../schema/votes.js";
import { ballotTypedData, EIP712_SIGNATURE_TYPE } from "../signer/eip712.js";
import type { OfflineBundleVerifier, VerifyResult } from "./types.js";

/**
 * Offline verify stage 1, signature half: recover the EIP-712 ballot signer and check it
 * equals `bundle.address`. Pure and cheap (no chain read), so it runs first in the gate —
 * a bad signature drops a vote before any fetch or chain work (see DESIGN.md "Transport").
 *
 * The recovered signer *is* the voter (there is no pkc-js author, no author->wallet
 * binding). Rebuilding the typed data from the criteria CID bytes + chainId + the bundle's
 * `votes`/`blockNumber` means a signature gathered for one contest, chain, or block cannot
 * validate on another — the binding is in the hash, not in a trusted `address` field, so a
 * forged `address` simply fails the recovery check here.
 */

/** True when `s` is `0x`-hex, narrowing it to viem's `Hex` without an `any` cast. */
function isHex(s: string): s is `0x${string}` {
    return s.startsWith("0x");
}

export async function verifyBundleSignature(args: {
    bundle: VotesBundle;
    criteriaCid: Uint8Array;
    chainId: number;
}): Promise<VerifyResult> {
    const { bundle, criteriaCid, chainId } = args;

    if (bundle.signature.type !== EIP712_SIGNATURE_TYPE) {
        return {
            valid: false,
            reason: `unsupported signature type "${bundle.signature.type}" (expected "${EIP712_SIGNATURE_TYPE}")`
        };
    }
    if (!isHex(bundle.signature.signature)) {
        return { valid: false, reason: "signature is not 0x-hex" };
    }

    const typedData = ballotTypedData({
        criteriaCid,
        chainId,
        votes: bundle.votes,
        blockNumber: bundle.blockNumber
    });

    let recovered: string;
    try {
        recovered = await recoverTypedDataAddress({ ...typedData, signature: bundle.signature.signature });
    } catch (err) {
        return { valid: false, reason: `signature does not recover: ${(err as Error).message}` };
    }

    // The recovered address is EIP-55 checksummed; `bundle.address` may be lowercase or
    // differently cased. Compare case-insensitively.
    if (recovered.toLowerCase() !== bundle.address.toLowerCase()) {
        return { valid: false, reason: `recovered signer ${recovered} does not match bundle.address ${bundle.address}` };
    }
    return { valid: true };
}

/** The {@link OfflineBundleVerifier} seam, backed by {@link verifyBundleSignature}. */
export const offlineBundleVerifier: OfflineBundleVerifier = { verifyBundleSignature };
