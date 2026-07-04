import { z } from "zod";
import type { Criteria, InterpreterRef } from "../schema/criteria.js";

/**
 * Resolve which chain an interpreter reads. An interpreter's parsed options may name a
 * `chain` ticker (e.g. `erc721-min-balance` -> "base"); a chainless interpreter (e.g.
 * `constant`) names none, so callers fall back to the first configured chain. Shared by the
 * verifier, the tally, and the facade so the fallback rule stays identical everywhere.
 */

/** The `chain` ticker named in an interpreter's parsed options, or `undefined` if none. */
export function chainTickerOf(options: unknown): string | undefined {
    const parsed = z.object({ chain: z.string().min(1) }).safeParse(options);
    return parsed.success ? parsed.data.chain : undefined;
}

/**
 * The chain ticker an interpreter ref uses: its own `chain` option, else the first chain in
 * `requires.chains`. Throws if neither exists (a chainless interpreter with no configured
 * chains cannot be read).
 */
export function tickerForRef(criteria: Criteria, ref: InterpreterRef, options: unknown): string {
    const ticker = chainTickerOf(options) ?? Object.keys(criteria.requires.chains)[0];
    if (!ticker) {
        throw new Error(
            `criteria interpreter "${ref.type}" names no chain and requires.chains is empty; ` +
                `cannot resolve a chain client to read it`
        );
    }
    return ticker;
}
