import { z } from "zod";
import { base58btc } from "multiformats/bases/base58";
import * as Digest from "multiformats/hashes/digest";
import { SignatureSchema } from "./common.js";

/**
 * True when `x` is a base58btc IPNS name (a `12D3KooW…` key), i.e. it decodes to a
 * multihash digest. This is the same check pkc-js uses (`isIpns`): a community identity is
 * either a resolvable domain (contains a dot) or this self-certifying B58 key. A board's
 * `publicKey` must be the B58 key — the stable identity the tally aggregates on — never a
 * domain, which is mutable/re-pointable. The leading `z` is base58btc's multibase prefix.
 */
function isB58IpnsKey(x: string): boolean {
    try {
        Digest.decode(base58btc.decode(`z${x}`));
        return true;
    } catch {
        return false;
    }
}

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
 * The board being voted for: a community identified by its `publicKey`, with an
 * optional human-readable `name` (display only). Board identity — the key the tally
 * aggregates on — is `publicKey` alone; `name` never participates in identity, so two
 * votes for the same `publicKey` with different (or missing) names still count as one
 * board and cannot be split or spoofed apart. See DESIGN.md "Votes wire".
 */
export const BoardSchema = z.object({
    // A pkc-js community identity: `name` is an optional human label (may be a resolvable
    // domain, e.g. "business.eth"), `publicKey` is the B58 IPNS name (e.g. "12D3KooW..."):
    // the self-certifying key the tally aggregates on. Not an EVM address; the eligibility-
    // chain wallet lives on the enclosing bundle's `address`, not here. We validate the key
    // strictly (`isB58IpnsKey`) — stricter than pkc-js's loose `z.string().min(1)` field —
    // because this is the vote-identity boundary: a domain or garbage in the identity slot
    // must not reach the tally.
    name: z.string().min(1).optional(),
    publicKey: z
        .string()
        .min(1)
        .refine(isB58IpnsKey, "publicKey must be a base58btc IPNS key (e.g. 12D3KooW…), not a domain")
});

/**
 * A single vote inside a bundle. The contest is implied by the topic (one contest
 * per topic), so it is not repeated on the wire.
 * - `board` is the community being voted for (`{ name?, publicKey }`).
 * - `vote` is numeric; its allowed range comes from `criteria.voteSchema`
 *   (v1 is upvote-only, so exactly 1). Range is enforced at verify time, not here,
 *   because the bounds live in the criteria, not in the wire type.
 */
export const VoteSchema = z.object({
    board: BoardSchema,
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

export type Board = z.infer<typeof BoardSchema>;
export type Vote = z.infer<typeof VoteSchema>;
export type VotesBundle = z.infer<typeof VotesBundleSchema>;
