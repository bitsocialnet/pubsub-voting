import { erc721Abi, getAddress } from "viem";
import { CHAIN_CHUNK_RETRY_DELAY_MS, CHAIN_MULTICALL_CONCURRENCY, CHAIN_READS_PER_MULTICALL } from "../chain/coalescer.js";
import type { ChainReadContext } from "./types.js";

/**
 * The shared `balanceOf` read path behind the two NFT gate rules (`erc5192-min-balance`, the
 * registered v1 gate, and the unregistered `erc721-min-balance`). Internal — not exported from
 * `src/index.ts`, not part of the public API.
 *
 * Both rules score the same way (`balance >= min ? balance : 0n`); they differ only in whether
 * the contract must additionally declare ERC-5192. Keeping ONE copy of the chunking policy
 * matters: the numbers below are tuned against real public endpoints (see below), and two
 * drifting copies would silently reintroduce the burst this exists to prevent.
 */

/**
 * Chunking policy shared with the voter-level read coalescer (src/chain/coalescer.ts). viem's
 * own default chunking (1,024 bytes of calldata ≈ 27 `balanceOf`s) would split a 1000-wallet
 * batch into ~38 chunks and fire them ALL concurrently — a burst public RPC endpoints throttle
 * (measured against `mainnet.base.org`: 33/38 requests answered HTTP 429 `-32016 over rate
 * limit` and the batch never settled). 200 reads is ~45 KB of calldata and ~2–5M `eth_call`
 * gas — inside public request-size and gas caps — so a 1000-wallet batch is 5 round trips.
 * The in-flight bound here is per batch call; the coalescer additionally enforces the
 * same budget globally across parallel contests (its wrapped `multicall` is what the batched
 * path below runs through).
 */
const READS_PER_MULTICALL = CHAIN_READS_PER_MULTICALL;
const MULTICALL_CONCURRENCY = CHAIN_MULTICALL_CONCURRENCY;
const CHUNK_RETRY_DELAY_MS = CHAIN_CHUNK_RETRY_DELAY_MS;

/** Score from one balance: the holding when it meets `min`, else `0n` (does not qualify). */
export function scoreOf(balance: bigint, min: number): bigint {
    return balance >= BigInt(min) ? balance : 0n;
}

/**
 * The voter-facing wording for a token-count shortfall ({@link RuleResult.error}), shared by
 * every balance-scored rule so they explain themselves identically.
 *
 * Deliberately generic: a rule knows a contract address and a threshold, not that the deployment
 * calls this token a "5chan Pass". A client renders it verbatim, which is the point — it then
 * needs to know nothing about which block the rule read or what `min` is.
 */
export function shortfallError(balance: bigint, min: number, contract: string): string {
    return balance === 0n
        ? `this wallet holds none of the gate token (${contract})`
        : `this wallet holds ${balance} of the gate token (${contract}), but ${min} are required`;
}

/**
 * True when the client can run multicall3 `aggregate3` batches — it needs both the action and
 * its chain's multicall3 deployment. A client built without a `chain` (or on a chain without
 * multicall3) takes the per-wallet path instead.
 */
export function canBatch(args: { ctx: ChainReadContext }): { batchable: boolean } {
    const { ctx } = args;
    return { batchable: typeof ctx.chain.multicall === "function" && Boolean(ctx.chain.chain?.contracts?.multicall3) };
}

/** One wallet's `balanceOf` at `block` (the caller's choice — a pinned block or the head). */
export async function balanceOf(args: {
    contract: `0x${string}`;
    wallet: string;
    block: number;
    ctx: ChainReadContext;
}): Promise<{ balance: bigint }> {
    const balance = await args.ctx.chain.readContract({
        address: args.contract,
        abi: erc721Abi,
        functionName: "balanceOf",
        args: [getAddress(args.wallet)],
        blockNumber: BigInt(args.block)
    });
    return { balance };
}

/**
 * Many wallets' `balanceOf` at ONE block — the path the background chain verifier rides on a
 * cold join. Requires {@link canBatch}; callers fall back to mapping {@link balanceOf}.
 *
 * The wallets are chunked HERE (`READS_PER_MULTICALL` per aggregate3, `batchSize: 0` disables
 * viem's own 1KB re-chunking) and the chunks are sent with bounded concurrency plus one retry
 * each, so a big batch is a handful of polite round trips rather than a ~40-request burst a
 * public endpoint throttles — and the retry re-reads only the chunk that failed, never a
 * completed one (viem's own whole-batch retry re-fired the entire burst). A chunk that fails
 * twice still fails the whole call: the caller gets one rejection, not partial results.
 */
export async function balancesOfBatched(args: {
    contract: `0x${string}`;
    wallets: string[];
    block: number;
    ctx: ChainReadContext;
}): Promise<{ balances: bigint[] }> {
    const { contract, wallets: walletAddresses, block, ctx } = args;
    const chunks: string[][] = [];
    for (let at = 0; at < walletAddresses.length; at += READS_PER_MULTICALL) {
        chunks.push(walletAddresses.slice(at, at + READS_PER_MULTICALL));
    }
    const balances = new Array<bigint>(walletAddresses.length);
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
            blockNumber: BigInt(block)
        });
    let nextChunk = 0;
    const worker = async (): Promise<void> => {
        while (nextChunk < chunks.length) {
            const index = nextChunk++;
            const chunk = chunks[index]!;
            let read: readonly bigint[];
            try {
                read = await readChunk(chunk);
            } catch {
                await new Promise((resolve) => setTimeout(resolve, CHUNK_RETRY_DELAY_MS));
                read = await readChunk(chunk);
            }
            for (let i = 0; i < chunk.length; i++) {
                balances[index * READS_PER_MULTICALL + i] = read[i]!;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(MULTICALL_CONCURRENCY, chunks.length) }, worker));
    return { balances };
}
