import { z } from "zod";
import { base58btc } from "multiformats/bases/base58";
import * as Digest from "multiformats/hashes/digest";
import { SignatureSchema } from "./common.js";

/**
 * True when `x` is a base58btc IPNS name (a `12D3KooW…` key), i.e. it decodes to a
 * multihash digest. This is the same check pkc-js uses (`isIpns`): a community identity is
 * either a resolvable domain (contains a dot) or this self-certifying B58 key. A community's
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
 * The bundle is signed directly by the gating-chain wallet as EIP-712 typed data
 * (see signer/eip712.ts); `address` is that wallet and MUST equal the address recovered
 * from `signature`. There is no pkc-js author and no author->wallet binding.
 */

/**
 * True when `x` is a dotted domain name — at least two non-empty, whitespace-free labels
 * (e.g. "memes.bso"). Community names must carry a TLD so they are resolvable through a
 * name resolver; the TLD itself is deliberately not pinned (`.bso` today, possibly other
 * naming systems later) — which names actually resolve is decided by the host-injected
 * `nameResolvers` at tally time, not by this schema.
 */
function isDottedDomain(x: string): boolean {
    const labels = x.split(".");
    return labels.length >= 2 && labels.every((label) => label.length > 0 && !/\s/.test(label));
}

/**
 * The community being voted for: identified by its `publicKey`, with an
 * optional resolvable domain `name` (e.g. "memes.bso"). Community identity — the key the
 * tally aggregates on — is `publicKey` alone, but a carried `name` is a *verified
 * claim*, not a free label: names are unique (the naming registry maps one name to one
 * community), and at tally time a bundle whose `name` does not resolve to the claimed
 * `publicKey` is dropped. A vote that omits `name` still folds into the same
 * `publicKey` row. See DESIGN.md "Votes wire" and "Tally".
 */
export const CommunitySchema = z.object({
    // A pkc-js community identity: `name` is an optional resolvable domain (must be
    // dotted — carry a TLD — e.g. "memes.bso" via @bitsocial/bso-resolver), `publicKey`
    // is the B58 IPNS name (e.g. "12D3KooW..."): the self-certifying key the tally
    // aggregates on. Not an EVM address; the gating-chain wallet lives on the
    // enclosing bundle's `address`, not here. We validate the key strictly
    // (`isB58IpnsKey`) — stricter than pkc-js's loose `z.string().min(1)` field —
    // because this is the vote-identity boundary: a domain or garbage in the identity
    // slot must not reach the tally.
    name: z
        .string()
        .min(1)
        .refine(isDottedDomain, "name must be a resolvable domain with a TLD (e.g. memes.bso)")
        .optional(),
    publicKey: z
        .string()
        .min(1)
        .refine(isB58IpnsKey, "publicKey must be a base58btc IPNS key (e.g. 12D3KooW…), not a domain")
});

/**
 * A single vote inside a bundle. The contest is implied by the topic (one contest
 * per topic), so it is not repeated on the wire.
 * - `community` is the community being voted for (`{ name?, publicKey }`).
 * - `vote` is numeric; its allowed range comes from `criteria.voteSchema`
 *   (v1 is upvote-only, so exactly 1). Range is enforced at verify time, not here,
 *   because the bounds live in the criteria, not in the wire type.
 */
export const VoteSchema = z.object({
    community: CommunitySchema,
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
export const VotesBundleSchema = z
    .object({
        address: z.string().min(1),
        votes: z.array(VoteSchema),
        blockNumber: z.number().int().nonnegative(),
        signature: SignatureSchema
    })
    // The votes must name pairwise-distinct communities. `maxVotesPerAddress` caps how many
    // entries a bundle carries, but only distinctness makes that a cap on *communities*:
    // without it a wallet allowed N approval votes could list one community N times and
    // stack N× weight on it. Unlike the criteria-dependent constraints (length cap,
    // vote range — enforced at verify time because their bounds live in the criteria),
    // distinctness is pure wire shape, so the schema owns it. Duplicate *names* need no
    // rule: same name + different keys dies at name resolution, same name + same key is
    // caught here. See DESIGN.md "Votes wire".
    .refine((bundle) => new Set(bundle.votes.map((v) => v.community.publicKey)).size === bundle.votes.length, {
        message: "votes must name pairwise-distinct community.publicKeys (one entry per community)",
        path: ["votes"]
    });

export type Community = z.infer<typeof CommunitySchema>;
export type Vote = z.infer<typeof VoteSchema>;
export type VotesBundle = z.infer<typeof VotesBundleSchema>;
