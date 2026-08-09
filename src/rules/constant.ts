import { z } from "zod";
import type { Rule } from "./types.js";

/**
 * A fixed score for every wallet. v1.
 *
 * In the weight slot this is "1 pass = 1 vote" (`value: 1`). In the rule slot a
 * positive `value` admits everyone (a no-op gate). No chain read.
 */
export const ConstantOptionsSchema = z.object({
    type: z.literal("constant"),
    value: z.number().int().positive().default(1)
});

export type ConstantOptions = z.infer<typeof ConstantOptionsSchema>;

export const constant: Rule<ConstantOptions> = {
    type: "constant",
    optionsSchema: ConstantOptionsSchema,
    async evaluate({ options }) {
        // `value` is schema-constrained positive, so this rule has no failing branch at all —
        // in the rule slot it is the no-op gate that admits everyone.
        return { success: true, score: BigInt(options.value) };
    }
};
