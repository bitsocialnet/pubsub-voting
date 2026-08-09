import type { RuleResult } from "./types.js";

/**
 * The two things the pipeline does with a {@link RuleResult}, in one place so the gate path and
 * the background verifier cannot drift apart.
 *
 * Neither helper looks at which rule produced the result — that is the standing rule of this
 * codebase (AGENTS.md, "What a rule owns, and what the pipeline owns"). They read the discriminant
 * and nothing else.
 */

/** A rule that says `success: true` but scores nothing has a bug; refuse rather than admit. */
const NON_POSITIVE_SUCCESS = "the contest's rule reported success without a score, which is a bug in that rule";

/**
 * `undefined` when the wallet is admitted, else why it was not and whether the sender may be
 * blamed for it.
 *
 * `penalize` is normalised here (defaulting to `true`) so callers never repeat the
 * `!== false` dance, and a `success: true, score: 0n` — impossible per the contract, but not
 * expressible in the type — is treated as a failure rather than silently admitting a
 * zero-weight vote.
 */
export function gateFailure(result: RuleResult): { error: string; penalize: boolean } | undefined {
    if (!result.success) return { error: result.error, penalize: result.penalize !== false };
    if (result.score <= 0n) return { error: NON_POSITIVE_SUCCESS, penalize: true };
    return undefined;
}

/** The weight slot's reading: a failure contributes nothing rather than dropping the vote. */
export function scoreOrZero(result: RuleResult): bigint {
    return result.success && result.score > 0n ? result.score : 0n;
}
