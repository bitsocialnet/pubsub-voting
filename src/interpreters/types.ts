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
 *   - eligibility slot: the score is a GATE. `> 0` admits the wallet, `0` rejects it.
 *   - weight slot:      the score is the vote's MAGNITUDE.
 *
 * Final vote value = `evaluate(eligibility) === 0 ? 0 : evaluate(weight)`.
 *
 * A single numeric return covers both roles: an interpreter that needs a threshold
 * (min Passes, min balance) bakes it in by returning 0 when the wallet falls short.
 * That is why eligibility does not need a separate boolean kind.
 */

/** Everything an interpreter needs to read chain state for one evaluation. */
export interface ChainReadContext {
    /** The client for the interpreter's `options.chain`. */
    chain: ChainClient;
    /** The single sampled block for the bundle's bucket. */
    blockNumber: number;
}

/**
 * The one interpreter kind. `O` is the validated options type (from its `optionsSchema`).
 * `evaluate` returns a non-negative number; `0` means "does not qualify" (rejected in the
 * eligibility slot, no weight in the weight slot).
 */
export interface Interpreter<O = unknown> {
    readonly type: string;
    readonly optionsSchema: z.ZodType<O>;
    evaluate(args: { options: O; walletAddress: string; ctx: ChainReadContext }): Promise<number>;
}

/**
 * The registry: a flat `type -> interpreter` map. Built-ins are provided by this
 * library; hosts may pass overrides that shadow built-ins by `type`. Mirrors pkc-js
 * src/runtime/node/community/challenges/index.ts.
 */
export type InterpreterRegistry = Record<string, Interpreter>;
