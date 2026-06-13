import type { z } from "zod";
import type { ChainClient } from "../chain/types.js";

/**
 * Interpreter interfaces, design only.
 *
 * An interpreter turns a criteria `{ type, ...options }` reference into a decision
 * about a voter, evaluated at the bundle's bucket block. The registry maps a `type`
 * string to an interpreter, exactly like the pkc-js challenge registry
 * (Record<string, factory>, user entries shadow builtins).
 */

/** Everything an interpreter needs to read chain state for one evaluation. */
export interface ChainReadContext {
    /** The client for the interpreter's `options.chain`. */
    chain: ChainClient;
    /** The single sampled block for the bundle's bucket. */
    blockNumber: number;
}

/**
 * Eligibility: is this wallet allowed to vote at all?
 * `O` is the interpreter's validated options type (from its `optionsSchema`).
 */
export interface EligibilityInterpreter<O = unknown> {
    readonly type: string;
    readonly optionsSchema: z.ZodType<O>;
    isEligible(args: { options: O; walletAddress: string; ctx: ChainReadContext }): Promise<boolean>;
}

/**
 * Weight: how much does an eligible wallet's vote count?
 * Returns a non-negative number; 0 is equivalent to ineligible.
 */
export interface WeightInterpreter<O = unknown> {
    readonly type: string;
    readonly optionsSchema: z.ZodType<O>;
    weightOf(args: { options: O; walletAddress: string; ctx: ChainReadContext }): Promise<number>;
}

/**
 * The registry. Built-ins are provided by this library; consumers may pass
 * overrides that shadow built-ins by `type`. Mirrors pkc-js
 * src/runtime/node/community/challenges/index.ts.
 */
export interface InterpreterRegistry {
    eligibility: Record<string, EligibilityInterpreter>;
    weight: Record<string, WeightInterpreter>;
}
