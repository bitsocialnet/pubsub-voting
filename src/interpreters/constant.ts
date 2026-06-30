import { z } from "zod";
import type { Interpreter } from "./types.js";

/**
 * A fixed score for every wallet. v1.
 *
 * In the weight slot this is "1 pass = 1 vote" (`value: 1`). In the eligibility slot a
 * positive `value` admits everyone (a no-op gate). No chain read.
 */
export const ConstantOptionsSchema = z.object({
    type: z.literal("constant"),
    value: z.number().positive().default(1)
});

export type ConstantOptions = z.infer<typeof ConstantOptionsSchema>;

export const constant: Interpreter<ConstantOptions> = {
    type: "constant",
    optionsSchema: ConstantOptionsSchema,
    async evaluate({ options }) {
        return options.value;
    }
};
