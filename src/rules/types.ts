import type { z } from "zod";
import type { ChainClient } from "../chain/types.js";

/**
 * Rule interface, design + leaves implemented.
 *
 * A rule turns a criteria `{ type, ...options }` reference into a non-negative
 * score for one wallet, evaluated at the bundle's bucket block. There is a SINGLE kind
 * (mirroring the flat pkc-js challenge registry: `Record<string, rule>`, user
 * entries shadow builtins). The criteria still has two slots that draw from this one
 * registry:
 *
 *   - rule slot:   the score is a GATE. `> 0n` admits the wallet, `0n` rejects it.
 *   - weight slot: the score is the vote's MAGNITUDE.
 *
 * Final vote value = `evaluate(rule).score === 0n ? 0n : evaluate(weight).score`.
 *
 * A single numeric return covers both roles: a rule that needs a threshold
 * (min Passes, min balance) bakes it in by returning 0n when the wallet falls short.
 * That is why the gate slot does not need a separate boolean kind.
 */

/**
 * The result of one evaluation. `score` is a non-negative `bigint`; `0n` means "does not
 * qualify" (rejected in the rule slot, no weight in the weight slot). It is an
 * object, not a bare `bigint`, so slot-specific fields can be added without changing the
 * signature again — e.g. a self-declared `ceiling` for balance-derived weight, which the
 * lazy tally needs as a wire-side upper bound (see DESIGN.md "Open questions").
 */
export interface RuleResult {
    score: bigint;
}

/** Everything a rule needs to read chain state for one evaluation. */
export interface ChainReadContext {
    /**
     * The viem `PublicClient` for the rule's `options.chain`. Use the full viem
     * read surface directly (`readContract`, `getBalance`, ...), pinning every call to
     * the sampled block with `blockNumber: BigInt(ctx.blockNumber)`.
     */
    chain: ChainClient;
    /** The single sampled block for the bundle's bucket. */
    blockNumber: number;
}

/**
 * The one rule kind. `O` is the validated options type (from its `optionsSchema`).
 * `evaluate` returns a `RuleResult` whose `score` is a non-negative `bigint`; `0n`
 * means "does not qualify" (rejected in the rule slot, no weight in the weight slot).
 */
export interface Rule<O = unknown> {
    readonly type: string;
    readonly optionsSchema: z.ZodType<O>;
    evaluate(args: { options: O; walletAddress: string; ctx: ChainReadContext }): Promise<RuleResult>;
    /**
     * Optional batched form of {@link evaluate}: score many wallets at the SAME sampled block in
     * as few RPC round trips as the rule can manage (e.g. one multicall3 `aggregate3` for a whole
     * checkpoint's wallets). Returns one result per input wallet, in order. Semantics MUST equal
     * mapping `evaluate` over the wallets — this is a transport optimization, never a different
     * answer. The background chain verifier prefers it when present and falls back to per-wallet
     * `evaluate` calls otherwise (see verify/background.ts).
     */
    evaluateMany?(args: { options: O; walletAddresses: string[]; ctx: ChainReadContext }): Promise<RuleResult[]>;
}

/**
 * The registry: a flat `type -> rule` map. Built-ins are provided by this
 * library; hosts may pass overrides that shadow built-ins by `type`. Mirrors pkc-js
 * src/runtime/node/community/challenges/index.ts.
 */
export type RuleRegistry = Record<string, Rule>;
