import { z } from "zod";
import type { Criteria, RuleRef } from "../schema/criteria.js";

/**
 * Resolve which chain a rule reads. A rule's parsed options may name a
 * `chain` ticker (e.g. `erc721-min-balance` -> "base"); a chainless rule (e.g.
 * `constant`) names none, so callers fall back to the first configured chain. Shared by the
 * verifier, the tally, and the facade so the fallback rule stays identical everywhere.
 */

/** The `chain` ticker named in a rule's parsed options, or `undefined` if none. */
export function chainTickerOf(options: unknown): string | undefined {
    const parsed = z.object({ chain: z.string().min(1) }).safeParse(options);
    return parsed.success ? parsed.data.chain : undefined;
}

/**
 * The chain ticker a rule ref uses: its own `chain` option, else the first chain in
 * `requires.chains`. Throws if neither exists (a chainless rule with no configured
 * chains cannot be read).
 */
export function tickerForRef(criteria: Criteria, ref: RuleRef, options: unknown): string {
    const ticker = chainTickerOf(options) ?? Object.keys(criteria.requires.chains)[0];
    if (!ticker) {
        throw new Error(
            `criteria rule "${ref.type}" names no chain and requires.chains is empty; ` +
                `cannot resolve a chain client to read it`
        );
    }
    return ticker;
}
