import { z } from "zod";
import { ChainTickerSchema } from "./common.js";

/**
 * The criteria document.
 *
 * Shipped static in the client bundle and used to derive the pubsub topic:
 *   topic = "bitsocial-votes/" + CID(dag-cbor(criteria))
 *
 * One criteria document describes exactly one contest (one directory slot), so there
 * is one topic per contest. The differing `contestId` value makes each contest's bytes
 * distinct, which forks the topic automatically. A client joins only the contests it
 * cares about, which is what keeps cold start cheap. See DESIGN.md "Criteria document".
 *
 * Because the topic is the CID of the canonical encoding of this object, two peers
 * on the same topic provably ran identical rules. Therefore this object MUST be
 * canonically encodable (no `undefined`, deterministic key order under dag-cbor);
 * a non-canonical change silently changes the topic.
 */

/** Inclusive numeric bounds for a single `vote` value. v1 is { min: 1, max: 1 }. */
export const VoteRangeSchema = z.object({
    min: z.number().int(),
    max: z.number().int()
});

/**
 * A reference to a rule by `type`, plus rule-specific options.
 * Kept loose on purpose: each rule owns and validates its own option schema
 * (see rules/types.ts), so custom rules can be referenced without
 * changing CriteriaSchema. This mirrors pkc-js challenge settings
 * ({ name, options }) where the named challenge validates its own options.
 */
export const RuleRefSchema = z.looseObject({
    type: z.string().min(1)
});

/** RPC configuration for one chain ticker. Part of the dependency manifest. */
export const ChainConfigSchema = z.object({
    chainId: z.number().int().positive(),
    rpcUrls: z.array(z.string().min(1)).nonempty()
});

/**
 * The dependency manifest. A client reads this on join and checks that it
 * implements every named rule; if not, it is too old and must recuse
 * itself rather than miscount. This is how criteria upgrades fork cleanly.
 */
export const RequiresSchema = z.object({
    rules: z.array(z.string().min(1)).nonempty(),
    chains: z.record(ChainTickerSchema, ChainConfigSchema)
});

export const CriteriaSchema = z
    .object({
        /** Human-readable label, not consensus-critical beyond changing the CID. */
        name: z.string().min(1),
        /**
         * The directory-slot code this topic decides. One contest per topic; it is how a host
         * addresses a contest (`PubsubVoter.createContest`), so it MUST be unique within a manifest.
         */
        contestId: z.string().min(1),
        /** Allowed range for each `vote` value. v1: { min: 1, max: 1 }. */
        voteSchema: VoteRangeSchema,
        /**
         * Max community selections per wallet in this contest (anti-spam). v1 = 1, the
         * one-vote-per-topic rule: a wallet picks one community. An empty `votes` array is
         * always allowed as withdrawal/abstention regardless of this cap.
         */
        maxVotesPerAddress: z.number().int().positive(),
        /** Block bucket size; all verifiers price the same block per bucket. */
        blocksPerBucket: z.number().int().positive(),
        /** How many buckets a bundle stays valid after its blockNumber. */
        voteExpiryBuckets: z.number().int().positive(),
        /** Who may vote (gates a wallet in or out). */
        rule: RuleRefSchema,
        /** How much an eligible vote counts. */
        weight: RuleRefSchema,
        /** Dependency manifest + version negotiation. */
        requires: RequiresSchema
    })
    .strict();

export type VoteRange = z.infer<typeof VoteRangeSchema>;
export type RuleRef = z.infer<typeof RuleRefSchema>;
export type ChainConfig = z.infer<typeof ChainConfigSchema>;
export type Requires = z.infer<typeof RequiresSchema>;
export type Criteria = z.infer<typeof CriteriaSchema>;
