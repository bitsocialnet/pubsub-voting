import { erc20Abi, getAddress } from "viem";
import { z } from "zod";
import { ChainTickerSchema } from "../schema/author.js";
import type { Interpreter } from "./types.js";

/**
 * Score by ERC-20 balance (for example BSO). Reserved for the pass + BSO combo path.
 *
 * Score = the wallet's balance at the bucket block, scaled by `decimals`, if it meets
 * `min`, else 0. `min` (in scaled units, default 0) is what lets this single interpreter
 * serve BOTH slots: in the weight slot leave `min` at 0 and the score is the magnitude;
 * in the eligibility slot set `min` and a wallet below it scores 0 (rejected).
 *
 * The chain returns raw integer units (wei); scaling to a JS number loses precision for
 * balances above ~2^53 base units after scaling — acceptable for vote weights. If exact
 * large-balance weighting is ever needed, return `bigint` and sort the tally as bigints.
 * See DESIGN.md "Open questions".
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
        const scaled = Number(raw) / 10 ** options.decimals;
        return scaled >= options.min ? scaled : 0;
    }
};
