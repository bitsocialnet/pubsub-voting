import { erc721Abi, getAddress } from "viem";
import { z } from "zod";
import { CHAIN_CHUNK_RETRY_DELAY_MS, CHAIN_MULTICALL_CONCURRENCY, CHAIN_READS_PER_MULTICALL } from "../chain/coalescer.js";
import { ChainTickerSchema } from "../schema/common.js";
import type { Rule, RuleResult } from "./types.js";

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

/**
 * Chunking policy shared with the voter-level read coalescer (src/chain/coalescer.ts). viem's
 * own default chunking (1,024 bytes of calldata ≈ 27 `balanceOf`s) would split a 1000-wallet
 * batch into ~38 chunks and fire them ALL concurrently — a burst public RPC endpoints throttle
 * (measured against `mainnet.base.org`: 33/38 requests answered HTTP 429 `-32016 over rate
 * limit` and the batch never settled). 200 reads is ~45 KB of calldata and ~2–5M `eth_call`
 * gas — inside public request-size and gas caps — so a 1000-wallet batch is 5 round trips.
 * The in-flight bound here is per evaluateMany call; the coalescer additionally enforces the
 * same budget globally across parallel contests (its wrapped `multicall` is what this rule's
 * batched path runs through).
 */
const READS_PER_MULTICALL = CHAIN_READS_PER_MULTICALL;
const MULTICALL_CONCURRENCY = CHAIN_MULTICALL_CONCURRENCY;
const CHUNK_RETRY_DELAY_MS = CHAIN_CHUNK_RETRY_DELAY_MS;

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
        // Multicall3 `aggregate3` batching — the path the background chain verifier rides on a
        // cold join. The wallets are chunked HERE (`READS_PER_MULTICALL` per aggregate3,
        // `batchSize: 0` disables viem's own 1KB re-chunking) and the chunks are sent with
        // bounded concurrency plus one in-rule retry each, so a big batch is a handful of
        // polite round trips rather than a ~40-request burst a public endpoint throttles —
        // and one failed chunk never discards the others' results. Needs the client to know
        // its chain's multicall3 deployment; a client built without a `chain` (or on a chain
        // without multicall3) takes the per-wallet fallback below.
        if (typeof ctx.chain.multicall === "function" && ctx.chain.chain?.contracts?.multicall3) {
            const chunks: string[][] = [];
            for (let at = 0; at < walletAddresses.length; at += READS_PER_MULTICALL) {
                chunks.push(walletAddresses.slice(at, at + READS_PER_MULTICALL));
            }
            const results = new Array<RuleResult>(walletAddresses.length);
            const readChunk = async (chunk: string[]): Promise<readonly bigint[]> =>
                ctx.chain.multicall({
                    contracts: chunk.map((wallet) => ({
                        address: contract,
                        abi: erc721Abi,
                        functionName: "balanceOf" as const,
                        args: [getAddress(wallet)] as const
                    })),
                    allowFailure: false,
                    batchSize: 0,
                    blockNumber: BigInt(ctx.blockNumber)
                });
            let nextChunk = 0;
            const worker = async (): Promise<void> => {
                while (nextChunk < chunks.length) {
                    const index = nextChunk++;
                    const chunk = chunks[index]!;
                    let balances: readonly bigint[];
                    try {
                        balances = await readChunk(chunk);
                    } catch {
                        await new Promise((resolve) => setTimeout(resolve, CHUNK_RETRY_DELAY_MS));
                        balances = await readChunk(chunk);
                    }
                    for (let i = 0; i < chunk.length; i++) {
                        results[index * READS_PER_MULTICALL + i] = { score: scoreOf(balances[i]!, options.min) };
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(MULTICALL_CONCURRENCY, chunks.length) }, worker));
            return results;
        }
        return Promise.all(walletAddresses.map((walletAddress) => this.evaluate({ options, walletAddress, ctx })));
    }
};
