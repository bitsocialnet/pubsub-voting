import type { PublicClient } from "viem";
import type { ChainConfig } from "../schema/criteria.js";

/**
 * Chain access.
 *
 * A `ChainClient` is just a viem `PublicClient`. The library does not wrap it in a
 * curated read API (no `balanceOfErc20`/`balanceOfErc721` helpers): every interpreter
 * writes its own reads with the full viem surface (`readContract`, `getBalance`,
 * `call`, multicall, ...) against whatever ABI it needs. That keeps custom
 * interpreters unconstrained — a host can read any contract shape without waiting for
 * a helper to be added here.
 *
 * Reads must be pinned to an explicit historical block (the sampled block for a
 * bundle's bucket) so every verifier prices the same state — interpreters pass
 * `blockNumber: BigInt(ctx.blockNumber)` to each viem call. viem is allowed in the
 * core (it carries no libp2p/helia import); only `src/transport/` touches the node.
 *
 * pkc-js has no equivalent: it touches chains only for name resolution and has no
 * balance reads or chainTicker-to-RPC mapping. All of this is net-new here.
 */
export type ChainClient = PublicClient;

/** chainTicker -> client, built from `criteria.requires.chains`. */
export type ChainClients = Record<string, ChainClient>;

/**
 * Factory the host provides: turn a chain config into a viem `PublicClient`
 * (typically `createPublicClient({ transport: http(config.rpcUrls[0]) })`).
 * Declared here so the public API can describe how chain clients are supplied.
 */
export type ChainClientFactory = (args: { chain: string; config: ChainConfig }) => ChainClient;

/**
 * Bucket math (documented here, implemented later).
 *
 *   bucketForBlock(block)        = Math.floor(block / blocksPerBucket)
 *   sampleBlockForBucket(bucket) = the canonical block at which balances are read
 *                                  for that bucket
 *
 * Using one sample block per bucket is what stops votes from flip-flopping mid
 * bucket and what makes every verifier agree. The exact sample-block rule (bucket
 * start, or a block derived from a blockhash to resist flash-loan timing) is a
 * tuning decision recorded in DESIGN.md.
 */
export interface BucketMath {
    bucketForBlock(blockNumber: number): number;
    sampleBlockForBucket(bucket: number): number;
}
