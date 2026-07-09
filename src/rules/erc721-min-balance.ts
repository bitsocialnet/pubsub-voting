import { erc721Abi, getAddress } from "viem";
import { z } from "zod";
import { ChainTickerSchema } from "../schema/common.js";
import type { Rule } from "./types.js";

/**
 * Hold at least `min` of an ERC-721 (the 5chan Pass). v1.
 *
 * Score = the wallet's holding at the bucket block if it meets `min`, else 0. In the
 * rule slot, `> 0` admits the wallet (it holds the Pass); in the weight slot it
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

/** Score from one balance: the holding when it meets `min`, else `0n` (does not qualify). */
function scoreOf(balance: bigint, min: number): bigint {
    return balance >= BigInt(min) ? balance : 0n;
}

export const erc721MinBalance: Rule<Erc721MinBalanceOptions> = {
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
        return { score: scoreOf(balance, options.min) };
    },
    async evaluateMany({ options, walletAddresses, ctx }) {
        const contract = getAddress(options.contract);
        // One multicall3 `aggregate3` eth_call covers every wallet — the batched path the
        // background chain verifier rides on a cold join (N wallets, ~1 RPC round trip). It
        // needs the client to know its chain's multicall3 deployment; a client built without a
        // `chain` (or on a chain without multicall3) takes the per-wallet fallback below.
        if (typeof ctx.chain.multicall === "function" && ctx.chain.chain?.contracts?.multicall3) {
            const balances = await ctx.chain.multicall({
                contracts: walletAddresses.map((wallet) => ({
                    address: contract,
                    abi: erc721Abi,
                    functionName: "balanceOf" as const,
                    args: [getAddress(wallet)] as const
                })),
                allowFailure: false,
                blockNumber: BigInt(ctx.blockNumber)
            });
            return balances.map((balance) => ({ score: scoreOf(balance, options.min) }));
        }
        return Promise.all(walletAddresses.map((walletAddress) => this.evaluate({ options, walletAddress, ctx })));
    }
};
