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
 *   - `contest`: the criteria CID (equivalently the topic). Different rules -> different
 *     CID -> a signature gathered for one contest does not validate on another.
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
 * The EIP-712 `types` struct. `vote` is `int256` (signed) so a future criteria can widen
 * the range to downvotes without a layout change; v1 is upvote-only. Pinned here so every
 * client hashes byte-identical typed data — settle any change with a fixed test vector
 * (see DESIGN.md "Open questions").
 */
export const BALLOT_TYPES = {
    Vote: [
        { name: "board", type: "string" },
        { name: "vote", type: "int256" }
    ],
    Ballot: [
        { name: "contest", type: "string" },
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
        contest: string;
        votes: { board: string; vote: bigint }[];
        blockNumber: bigint;
    };
}

/**
 * Build the EIP-712 ballot typed data for a bundle. Both the signer (to sign) and the
 * verifier (to recover) call this with identical inputs, so the hashed structure matches.
 * Integer fields are emitted as `bigint` (EIP-712 256-bit ints).
 */
export function ballotTypedData(args: {
    /** The criteria CID string (e.g. `(await criteriaCid(criteria)).toString()`). */
    contestCid: string;
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
            contest: args.contestCid,
            votes: args.votes.map((v) => ({ board: v.board, vote: BigInt(v.vote) })),
            blockNumber: BigInt(args.blockNumber)
        }
    };
}
