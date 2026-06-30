import { z } from "zod";
import { ChainTickerSchema } from "../schema/author.js";
import type { Interpreter } from "./types.js";

/**
 * Hold at least `min` of an ERC-721 (the 5chan Pass). v1.
 *
 * Score = the wallet's holding at the bucket block if it meets `min`, else 0. In the
 * eligibility slot, `> 0` admits the wallet (it holds the Pass); in the weight slot it
 * weights by the number of Passes held. The body reads only the injected `ChainClient`,
 * so it carries no libp2p/helia/viem import and is unit-testable against a mock chain.
 */

export const Erc721MinBalanceOptionsSchema = z.object({
    type: z.literal("erc721-min-balance"),
    chain: ChainTickerSchema,
    contract: z.string(),
    min: z.number().int().positive().default(1)
});

export type Erc721MinBalanceOptions = z.infer<typeof Erc721MinBalanceOptionsSchema>;

export const erc721MinBalance: Interpreter<Erc721MinBalanceOptions> = {
    type: "erc721-min-balance",
    optionsSchema: Erc721MinBalanceOptionsSchema,
    async evaluate({ options, walletAddress, ctx }) {
        const balance = await ctx.chain.balanceOfErc721({
            contract: options.contract,
            owner: walletAddress,
            blockNumber: ctx.blockNumber
        });
        return balance >= BigInt(options.min) ? Number(balance) : 0;
    }
};
