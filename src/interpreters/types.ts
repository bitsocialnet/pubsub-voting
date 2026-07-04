import type { z } from "zod";
import type { ChainClient } from "../chain/types.js";

/**
 * Interpreter interface, design + leaves implemented.
 *
 * An interpreter turns a criteria `{ type, ...options }` reference into a non-negative
 * score for one wallet, evaluated at the bundle's bucket block. There is a SINGLE kind
 * (mirroring the flat pkc-js challenge registry: `Record<string, interpreter>`, user
 * entries shadow builtins). The criteria still has two slots that draw from this one
 * registry:
 *
 *   - eligibility slot: the score is a GATE. `> 0n` admits the wallet, `0n` rejects it.
 *   - weight slot:      the score is the vote's MAGNITUDE.
 *
 * Final vote value = `evaluate(eligibility).score === 0n ? 0n : evaluate(weight).score`.
 *
 * A single numeric return covers both roles: an interpreter that needs a threshold
 * (min Passes, min balance) bakes it in by returning 0n when the wallet falls short.
 * That is why eligibility does not need a separate boolean kind.
 */

/**
 * The result of one evaluation. `score` is a non-negative `bigint`; `0n` means "does not
 * qualify" (rejected in the eligibility slot, no weight in the weight slot). It is an
 * object, not a bare `bigint`, so slot-specific fields can be added without changing the
 * signature again — e.g. a self-declared `ceiling` for balance-derived weight, which the
 * lazy tally needs as a wire-side upper bound (see DESIGN.md "Open questions").
 */
export interface InterpreterResult {
    score: bigint;
}

/** Everything an interpreter needs to read chain state for one evaluation. */
export interface ChainReadContext {
    /**
     * The viem `PublicClient` for the interpreter's `options.chain`. Use the full viem
     * read surface directly (`readContract`, `getBalance`, ...), pinning every call to
     * the sampled block with `blockNumber: BigInt(ctx.blockNumber)`.
     */
    chain: ChainClient;
    /** The single sampled block for the bundle's bucket. */
    blockNumber: number;
}

/**
 * The one interpreter kind. `O` is the validated options type (from its `optionsSchema`).
 * `evaluate` returns an `InterpreterResult` whose `score` is a non-negative `bigint`; `0n`
 * means "does not qualify" (rejected in the eligibility slot, no weight in the weight slot).
 */
export interface Interpreter<O = unknown> {
    readonly type: string;
    readonly optionsSchema: z.ZodType<O>;
    evaluate(args: { options: O; walletAddress: string; ctx: ChainReadContext }): Promise<InterpreterResult>;
}

/**
 * The registry: a flat `type -> interpreter` map. Built-ins are provided by this
 * library; hosts may pass overrides that shadow built-ins by `type`. Mirrors pkc-js
 * src/runtime/node/community/challenges/index.ts.
 */
export type InterpreterRegistry = Record<string, Interpreter>;
