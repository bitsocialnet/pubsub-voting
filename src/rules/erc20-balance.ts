import { erc20Abi, formatUnits, getAddress, parseUnits } from "viem";
import { z } from "zod";
import { ChainTickerSchema } from "../schema/common.js";
import type { Rule } from "./types.js";

/**
 * Score by ERC-20 balance (for example BSO). Reserved for the pass + BSO combo path.
 *
 * **NOT registered** in `builtinRegistry` — a criteria naming it recuses via
 * `UnknownRuleError`. Two independent blockers: the design-open lazy-tally ceiling for a
 * balance-derived weight, and the Sybil amplification a fungible gate reopens (one balance
 * walked through several wallets inside one expiry window backs several concurrent votes;
 * a balance can be neither non-transferable nor LWW-keyed by token id, so it needs a
 * hold-duration guard instead). See registry.ts and issue #28 before re-registering it.
 *
 * Score = the wallet's raw balance (base units) at the bucket block if it meets `min`,
 * else 0n. `min` (in whole tokens, default 0) is what lets this single rule serve
 * BOTH slots: in the weight slot leave `min` at 0 and the score is the magnitude; in the
 * rule slot set `min` and a wallet below it scores 0n (rejected).
 *
 * The score is the exact `bigint` viem returns — no `Number()` cast, no precision loss.
 * We deliberately do NOT divide by `decimals`: that divide is monotonic, so it never
 * changes the ranking, and doing it in a JS `number` is exactly what used to lose
 * precision. `decimals` is retained only to convert `min` (whole tokens) to base units
 * via viem `parseUnits`, so the gate compares like-for-like. The score's absolute
 * magnitude is therefore base units; formatting to whole tokens for display is a caller
 * concern (`viem.formatUnits`). See DESIGN.md "Rules".
 *
 * (Edge: `min` is a normal token threshold. A `min` large enough that `.toString()`
 * yields scientific notation would break `parseUnits` — out of scope for real thresholds.)
 */
export const Erc20BalanceOptionsSchema = z.object({
    type: z.literal("erc20-balance"),
    chain: ChainTickerSchema,
    contract: z.string(),
    decimals: z.number().int().nonnegative().default(18),
    min: z.number().nonnegative().default(0)
});

export type Erc20BalanceOptions = z.infer<typeof Erc20BalanceOptionsSchema>;

export const erc20Balance: Rule<Erc20BalanceOptions> = {
    type: "erc20-balance",
    optionsSchema: Erc20BalanceOptionsSchema,
    // Scores at the bundle's OWN pinned block: a fungible balance is the least stable score
    // there is — it moves in both directions with every transfer — so it may not be read at the
    // head, and a `0n` here is attributable (`penalize` stays at its default). See registry.ts
    // for why this rule is unregistered regardless.
    async evaluate({ options, wallet, ctx }) {
        const raw = await ctx.chain.readContract({
            address: getAddress(options.contract),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [getAddress(wallet.address)],
            blockNumber: BigInt(wallet.sampleBlock)
        });
        const minUnits = parseUnits(options.min.toString(), options.decimals);
        if (raw >= minUnits) return { success: true, score: raw };
        return {
            success: false,
            error:
                `this wallet holds ${formatUnits(raw, options.decimals)} of the gate token ` +
                `(${getAddress(options.contract)}), but ${options.min} is required`
        };
    }
};
