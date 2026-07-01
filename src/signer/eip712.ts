import type { Vote } from "../schema/votes.js";

/**
 * EIP-712 ballot typed data.
 *
 * The voting wallet signs this structure, not the raw wire bytes: it is the single
 * canonical artifact the signer produces and the verifier recovers against (via viem's
 * `signTypedData` / `recoverTypedDataAddress`). It replaces the old cbor "signed
 * property names" scheme. See DESIGN.md "Votes wire".
 *
 * The signature binds three things so a vote cannot be replayed onto another contest or
 * app, and cannot be re-stamped to a different block:
 *   - `criteria`: the criteria CID (equivalently the topic), carried as the raw binary
 *     CID bytes (`cid.bytes`) so there is no multibase/version representation ambiguity —
 *     every client hashes the same bytes. Different rules -> different CID -> a signature
 *     gathered for one contest does not validate on another. (This is the CID of the whole
 *     criteria document, distinct from the `criteria.contest` slot-code field inside it.)
 *   - `votes`: each board + numeric vote.
 *   - `blockNumber`: the LWW key and the bucketized block every verifier reads at.
 *
 * The `domain.chainId` is the eligibility chain, giving cross-chain/cross-app domain
 * separation for free. This module is pure: no key material, no network, no viem import
 * — it only shapes the object both sides feed to viem.
 */

/** EIP-712 domain name shared by every contest. */
export const EIP712_DOMAIN_NAME = "bitsocial-votes";
/** EIP-712 domain version. Bump only on a breaking change to the ballot layout. */
export const EIP712_DOMAIN_VERSION = "1";
/** The `type` tag carried in a bundle's {@link Signature} for an EIP-712 ballot signature. */
export const EIP712_SIGNATURE_TYPE = "eip712";

/**
 * The EIP-712 `types` struct — frozen for v1 (see DESIGN.md "Wire freeze (v1)"). Field
 * names and order are part of the type hash, so any change here is a breaking wire change
 * that must bump {@link EIP712_DOMAIN_VERSION} and re-freeze the conformance vector in
 * eip712.test.ts.
 *   - `criteria` is `bytes` (the raw binary CID, `cid.bytes`), not a string: hashing the
 *     canonical bytes avoids the multibase/version ambiguity a stringified CID would bake
 *     in, so independent clients recover identical signers.
 *   - `vote` is `int256` (signed) so a future criteria can widen the range to downvotes
 *     without a layout change; v1 is upvote-only.
 */
export const BALLOT_TYPES = {
    Vote: [
        { name: "board", type: "string" },
        { name: "vote", type: "int256" }
    ],
    Ballot: [
        { name: "criteria", type: "bytes" },
        { name: "votes", type: "Vote[]" },
        { name: "blockNumber", type: "uint256" }
    ]
} as const;

/** The EIP-712 typed-data object handed to viem to sign or to recover a signer from. */
export interface BallotTypedData {
    domain: { name: string; version: string; chainId: number };
    types: typeof BALLOT_TYPES;
    primaryType: "Ballot";
    message: {
        criteria: `0x${string}`;
        votes: { board: string; vote: bigint }[];
        blockNumber: bigint;
    };
}

/** Lowercase `0x`-hex encoding of raw bytes, for the EIP-712 `bytes` message field. */
function bytesToHex(bytes: Uint8Array): `0x${string}` {
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return `0x${hex}`;
}

/**
 * Build the EIP-712 ballot typed data for a bundle. Both the signer (to sign) and the
 * verifier (to recover) call this with identical inputs, so the hashed structure matches.
 * Integer fields are emitted as `bigint` (EIP-712 256-bit ints).
 */
export function ballotTypedData(args: {
    /** The criteria CID's raw binary bytes (`(await criteriaCid(criteria)).bytes`). */
    criteriaCid: Uint8Array;
    /** The eligibility chain's numeric chainId (`criteria.requires.chains[chain].chainId`). */
    chainId: number;
    votes: Vote[];
    blockNumber: number;
}): BallotTypedData {
    return {
        domain: { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: args.chainId },
        types: BALLOT_TYPES,
        primaryType: "Ballot",
        message: {
            criteria: bytesToHex(args.criteriaCid),
            votes: args.votes.map((v) => ({ board: v.board, vote: BigInt(v.vote) })),
            blockNumber: BigInt(args.blockNumber)
        }
    };
}
