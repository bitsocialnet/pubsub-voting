import type { PublicClient } from "viem";

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
 * Factory the host provides: resolve a chain named by the criteria (`requires.chains`,
 * ticker + chainId) to a viem `PublicClient`. The RPC endpoint is the HOST's setting —
 * deliberately not part of the criteria document (see schema/criteria.ts,
 * `ChainConfigSchema`) — so this factory is where ticker/chainId meets the gateways this
 * client trusts (typically `createPublicClient({ chain, transport: http(myRpcUrl) })`).
 *
 * Return `undefined` (or throw) when no RPC is configured for the named chain: the voter
 * then throws `MissingChainClientError` at the create seam (`createContest` /
 * `createContestVote`) — this client must recuse the contest rather than miscount.
 *
 * Return ONE shared client per chain (memoize on `chainId`), not a fresh client per call:
 * the voter wraps each distinct client with the cross-contest read coalescer
 * (src/chain/coalescer.ts), so sharing is what merges parallel contests' pinned-block reads
 * into shared multicalls under one in-flight budget. Pick a gateway that serves historical
 * state at least `voteExpiryBuckets × blocksPerBucket` blocks behind head (gate reads pin
 * to bucket sample blocks) and carries a multicall3 deployment in its viem `chain` config.
 */
export type ChainClientFactory = (args: { chain: string; chainId: number }) => ChainClient | undefined;

/**
 * A community-name resolver the host injects (`PubsubVoterOptions.nameResolvers`). The
 * shape is structurally identical to pkc-js's `NameResolverInterface`, so a host passes
 * the very same instances it already gives pkc-js (e.g. `@bitsocial/bso-resolver`'s
 * `BsoResolver`, which resolves `name.bso` through the `bitsocial` text record) —
 * declared here rather than imported so this library depends on no resolver package.
 *
 * The tally uses it to verify a vote's `community.name` claim: resolve the name and drop
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
