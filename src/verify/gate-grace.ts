/**
 * What the pipeline does with a gate score of `0n` that the rule declined to blame on anyone
 * (`RuleResult.penalize: false` — see rules/types.ts).
 *
 * These two numbers are pipeline policy, not rule policy, which is why they live here: they are
 * about how long the library is willing to hold an unsettled bundle in its own working set, not
 * about how any rule reads the chain. What the rule owns — which block it scores at and how long
 * it memoizes the answer — lives in the rule (see rules/cache.ts).
 */

/**
 * How long the background verifier keeps a provisionally-admitted bundle whose gate scored `0n`
 * without blaming anyone, before giving up on it.
 *
 * An unattributable `0n` means "not yet", not "no": the wallet may have acquired the gate asset
 * in a block this verifier has not seen, or may acquire it seconds from now (a client that signs
 * its ballot the instant it mints races its own transaction). Evicting immediately would make
 * whether a vote counts depend on whose RPC was a few blocks ahead. Retrying forever is the other
 * failure — a never-holder's bundles would pend until they expire, which is memory a spammer
 * chooses. So: re-examine within a grace window, then evict `ignore`-class (uncached, so a later
 * re-publish is judged fresh rather than inheriting this verdict).
 */
export const GATE_GRACE_MS = 120_000;

/**
 * How often a still-`0n` bundle is re-examined inside the grace window.
 *
 * Cheap by design: the rule memoizes its own reads under its own epoch (rules/cache.ts), so a
 * re-examination whose epoch has not rolled costs no chain work at all. The real cost is one
 * batched read per rule epoch, no matter how many bundles are pending or how often this fires —
 * which is also why the grace window must be comfortably longer than the rule's epoch, or the
 * retries would never see a fresh read.
 */
export const GATE_RETRY_MS = 10_000;
