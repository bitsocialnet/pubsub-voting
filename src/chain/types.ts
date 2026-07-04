import type { PublicClient } from "viem";
import type { ChainConfig } from "../schema/criteria.js";

/**
 * Chain access.
 *
 * A `ChainClient` is just a viem `PublicClient`. The library does not wrap it in a
 * curated read API (no `balanceOfErc20`/`balanceOfErc721` helpers): every rule
 * writes its own reads with the full viem surface (`readContract`, `getBalance`,
 * `call`, multicall, ...) against whatever ABI it needs. That keeps custom
 * rules unconstrained — a host can read any contract shape without waiting for
 * a helper to be added here.
 *
 * Reads must be pinned to an explicit historical block (the sampled block for a
 * bundle's bucket) so every verifier prices the same state — rules pass
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
 * A board-name resolver the host injects (`PubsubVoterOptions.nameResolvers`). The
 * shape is structurally identical to pkc-js's `NameResolverInterface`, so a host passes
 * the very same instances it already gives pkc-js (e.g. `@bitsocial/bso-resolver`'s
 * `BsoResolver`, which resolves `name.bso` through the `bitsocial` text record) —
 * declared here rather than imported so this library depends on no resolver package.
 *
 * The tally uses it to verify a vote's `board.name` claim: resolve the name and drop
 * the bundle when it does not resolve or resolves to a different `publicKey` than the
 * vote claims (see DESIGN.md "Tally"). `resolve` returning `undefined` means the name
 * has no record. `resolve` accepts an optional `blockNumber` to pin the read to a
 * canonical historical block (bso-resolver#3, since resolved upstream); when omitted it
 * resolves at head. v1 still resolves at head: the registry lives on its own chain, so
 * pinning also needs a canonical per-bucket block *on the registry's chain* — that
 * multi-chain block-selection half is still open. See DESIGN.md "Open questions",
 * "Pinned-block name resolution".
 */
export interface NameResolver {
    /** Identifies this resolver instance (e.g. "bso-viem"). */
    key: string;
    /** The backing provider label (e.g. "viem"). */
    provider: string;
    /** Resolve a name to its record; `undefined` when the name has no record. */
    resolve: (opts: {
        name: string;
        /**
         * Pin the text-record read to a canonical historical block; resolves at head
         * when omitted. v1 leaves it unset (head) until per-bucket block selection on
         * the registry's chain lands — see the interface note above.
         */
        blockNumber?: bigint;
        abortSignal?: AbortSignal;
    }) => Promise<{ publicKey: string; [key: string]: string } | undefined>;
    /** True when this resolver handles the name's TLD (e.g. ends with ".bso"). */
    canResolve: (opts: { name: string }) => boolean;
    destroy?: () => Promise<void>;
}

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
