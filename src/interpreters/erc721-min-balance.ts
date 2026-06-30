import { erc721Abi, getAddress } from "viem";
import { z } from "zod";
import { ChainTickerSchema } from "../schema/author.js";
import type { Interpreter } from "./types.js";

/**
 * Hold at least `min` of an ERC-721 (the 5chan Pass). v1.
 *
 * Score = the wallet's holding at the bucket block if it meets `min`, else 0. In the
 * eligibility slot, `> 0` admits the wallet (it holds the Pass); in the weight slot it
 * weights by the number of Passes held. The body reads its own `balanceOf` via the
 * injected viem client (no libp2p/helia import), unit-testable against a stubbed client.
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
        const balance = await ctx.chain.readContract({
            address: getAddress(options.contract),
            abi: erc721Abi,
            functionName: "balanceOf",
            args: [getAddress(walletAddress)],
            blockNumber: BigInt(ctx.blockNumber)
        });
        return balance >= BigInt(options.min) ? Number(balance) : 0;
    }
};
