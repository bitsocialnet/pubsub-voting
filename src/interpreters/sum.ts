import { z } from "zod";
import type { Interpreter } from "./types.js";
import { NotImplementedError } from "../errors.js";

/**
 * Sum of nested interpreter terms (for example constant + erc20-balance). Reserved for
 * the combo path. `terms` is kept loose to avoid a recursive schema; the real
 * implementation will resolve each term against the registry.
 *
 * This is a combinator: unlike the leaf interpreters it must resolve and invoke OTHER
 * interpreters, and each term may name its own `chain`. The current `ChainReadContext`
 * exposes a single `chain` and no registry handle, so the resolution protocol is still
 * an open design question (see DESIGN.md "Open questions"). Until that lands, evaluating
 * `sum` throws rather than miscount.
 */
export const SumOptionsSchema = z.object({
    type: z.literal("sum"),
    terms: z.array(z.looseObject({ type: z.string().min(1) })).nonempty()
});

export type SumOptions = z.infer<typeof SumOptionsSchema>;

export const sum: Interpreter<SumOptions> = {
    type: "sum",
    optionsSchema: SumOptionsSchema,
    async evaluate() {
        throw new NotImplementedError("interpreter 'sum' (combinator term resolution)");
    }
};
