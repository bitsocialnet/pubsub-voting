import { erc20Abi, getAddress, parseUnits } from "viem";
import { z } from "zod";
import { ChainTickerSchema } from "../schema/common.js";
import type { Interpreter } from "./types.js";

/**
 * Score by ERC-20 balance (for example BSO). Reserved for the pass + BSO combo path.
 *
 * Score = the wallet's raw balance (base units) at the bucket block if it meets `min`,
 * else 0n. `min` (in whole tokens, default 0) is what lets this single interpreter serve
 * BOTH slots: in the weight slot leave `min` at 0 and the score is the magnitude; in the
 * eligibility slot set `min` and a wallet below it scores 0n (rejected).
 *
 * The score is the exact `bigint` viem returns — no `Number()` cast, no precision loss.
 * We deliberately do NOT divide by `decimals`: that divide is monotonic, so it never
 * changes the ranking, and doing it in a JS `number` is exactly what used to lose
 * precision. `decimals` is retained only to convert `min` (whole tokens) to base units
 * via viem `parseUnits`, so the gate compares like-for-like. The score's absolute
 * magnitude is therefore base units; formatting to whole tokens for display is a caller
 * concern (`viem.formatUnits`). See DESIGN.md "Interpreters".
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

export const erc20Balance: Interpreter<Erc20BalanceOptions> = {
    type: "erc20-balance",
    optionsSchema: Erc20BalanceOptionsSchema,
    async evaluate({ options, walletAddress, ctx }) {
        const raw = await ctx.chain.readContract({
            address: getAddress(options.contract),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [getAddress(walletAddress)],
            blockNumber: BigInt(ctx.blockNumber)
        });
        const minUnits = parseUnits(options.min.toString(), options.decimals);
        return { score: raw >= minUnits ? raw : 0n };
    }
};
