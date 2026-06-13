import { z } from "zod";
import { ChainTickerSchema } from "../schema/author.js";

/**
 * Option schemas for the built-in interpreters.
 *
 * Each interpreter owns its option schema. `CriteriaSchema` keeps `eligibility`
 * and `weight` loose (`{ type, ...options }`); the matching interpreter parses the
 * options with the schema here. This mirrors the pkc-js challenge registry, where
 * a named challenge validates its own options. See DESIGN.md "Interpreters".
 *
 * v1 ships erc721-min-balance (eligibility) and constant (weight). erc20-balance
 * and sum are reserved for the pass + BSO combo path and are schema-only for now.
 */

/** Eligibility: hold at least `min` of an ERC-721 (the 5chan Pass). v1. */
export const Erc721MinBalanceOptionsSchema = z.object({
    type: z.literal("erc721-min-balance"),
    chain: ChainTickerSchema,
    contract: z.string(),
    min: z.number().int().positive().default(1)
});

/** Weight: a fixed weight per eligible voter (1 pass = 1 vote). v1. */
export const ConstantWeightOptionsSchema = z.object({
    type: z.literal("constant"),
    value: z.number().positive().default(1)
});

/** Weight: by ERC-20 balance (for example BSO). Reserved for the combo path. */
export const Erc20BalanceWeightOptionsSchema = z.object({
    type: z.literal("erc20-balance"),
    chain: ChainTickerSchema,
    contract: z.string(),
    decimals: z.number().int().nonnegative().default(18)
});

/**
 * Weight: sum of nested weight terms (for example constant + erc20-balance).
 * Reserved for the combo path. `terms` is kept loose here to avoid a recursive
 * schema in the scaffold; the real schema will validate each term against the
 * weight union below.
 */
export const SumWeightOptionsSchema = z.object({
    type: z.literal("sum"),
    terms: z.array(z.looseObject({ type: z.string().min(1) })).nonempty()
});

/** Discriminated unions over the built-in interpreter option shapes. */
export const EligibilityOptionsSchema = z.discriminatedUnion("type", [Erc721MinBalanceOptionsSchema]);

export const WeightOptionsSchema = z.discriminatedUnion("type", [
    ConstantWeightOptionsSchema,
    Erc20BalanceWeightOptionsSchema,
    SumWeightOptionsSchema
]);

/** type ids the v1 implementation must register; checked against `requires.interpreters`. */
export const V1_BUILTIN_INTERPRETER_TYPES = ["erc721-min-balance", "constant"] as const;

export type Erc721MinBalanceOptions = z.infer<typeof Erc721MinBalanceOptionsSchema>;
export type ConstantWeightOptions = z.infer<typeof ConstantWeightOptionsSchema>;
export type Erc20BalanceWeightOptions = z.infer<typeof Erc20BalanceWeightOptionsSchema>;
export type SumWeightOptions = z.infer<typeof SumWeightOptionsSchema>;
export type EligibilityOptions = z.infer<typeof EligibilityOptionsSchema>;
export type WeightOptions = z.infer<typeof WeightOptionsSchema>;
