import { encodeFunctionData, type Abi } from "viem";
import type { ChainClient, ChainClientFactory } from "./types.js";

/**
 * Chain-read coalescing — a DataLoader for pinned-block contract reads.
 *
 * Rules read the chain through the full viem surface (`readContract`, `multicall`, ...), and
 * verification runs in parallel: a directory join verifies dozens of contests at once, the
 * gossip forward-gate verifies each incoming vote individually, and the background verifier
 * batches per bucket. Left alone, that parallelism turns into a burst of concurrent HTTP posts
 * that free public RPC endpoints throttle (measured against `mainnet.base.org`: 38 concurrent
 * `aggregate3` posts → 33× HTTP 429 `-32016 over rate limit`). Per-call politeness inside one
 * rule invocation cannot fix this — the burst forms ACROSS calls — so the voter wraps each
 * chain client ONCE ({@link coalescingChainFactory}) and every consumer shares the wrapper:
 *
 *   - `readContract` calls pinned to an explicit `blockNumber` are collected for a short
 *     window ({@link COALESCE_WINDOW_MS} — noise next to a WAN RTT), deduped on
 *     `(block, contract, calldata)`, grouped per block (an `eth_call` reads ONE block, so
 *     different bucket sample blocks can never share a multicall), and flushed as multicall3
 *     `aggregate3` chunks of {@link CHAIN_READS_PER_MULTICALL} reads.
 *   - Explicit `multicall` calls (e.g. a rule's own `evaluateMany` batching) pass through
 *     unchanged but count against the SAME in-flight budget.
 *   - At most {@link CHAIN_MULTICALL_CONCURRENCY} round trips are in flight per underlying
 *     client, across everything; a failed coalesced chunk retries once
 *     ({@link CHAIN_CHUNK_RETRY_DELAY_MS}) without re-reading completed chunks.
 *
 * Caveat (shared with any multicall batching): a coalesced read executes as an inner CALL from
 * the multicall3 contract, so `msg.sender` differs from a direct `eth_call`. That is irrelevant
 * for `balanceOf`-style views — and reads that must not batch keep their semantics by omitting
 * `blockNumber` or passing extra call options, which routes them through the raw client.
 * Clients without a known multicall3 deployment are returned unwrapped.
 */

/** `balanceOf`-sized reads per multicall3 `aggregate3` round trip (~45 KB calldata, ~2–5M gas). */
export const CHAIN_READS_PER_MULTICALL = 200;

/** Multicall round trips in flight at once per chain client — polite to free public endpoints. */
export const CHAIN_MULTICALL_CONCURRENCY = 2;

/** One retry per failed coalesced chunk, after this pause. */
export const CHAIN_CHUNK_RETRY_DELAY_MS = 500;

/** How long the first read of a batch waits for company before its chunk flushes. */
const COALESCE_WINDOW_MS = 25;

export interface CoalescerOptions {
    readsPerCall?: number;
    concurrency?: number;
    windowMs?: number;
}

/** The pinned single-read `readContract` shape the coalescer can turn into a multicall entry. */
interface CoalescableRead {
    address: `0x${string}`;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: unknown;
}

interface PendingRead {
    contract: { address: `0x${string}`; abi: Abi; functionName: string; args: readonly unknown[] };
    key: string;
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

interface PendingGroup {
    blockNumber: bigint;
    reads: PendingRead[];
    timer: ReturnType<typeof setTimeout>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap one chain client with the shared read coalescer + in-flight budget. Idempotent per
 * client only via {@link coalescingChainFactory} — call sites should not wrap twice.
 */
export function coalescingChainClient(client: ChainClient, options: CoalescerOptions = {}): ChainClient {
    // Without a known multicall3 deployment there is nothing to coalesce INTO — pass through.
    if (typeof client.multicall !== "function" || !client.chain?.contracts?.multicall3) return client;

    const readsPerCall = options.readsPerCall ?? CHAIN_READS_PER_MULTICALL;
    const concurrency = options.concurrency ?? CHAIN_MULTICALL_CONCURRENCY;
    const windowMs = options.windowMs ?? COALESCE_WINDOW_MS;

    // --- the shared in-flight budget (coalesced chunks AND explicit multicalls) ---
    let active = 0;
    const queue: Array<() => void> = [];
    const acquire = (): Promise<void> =>
        new Promise((resolve) => {
            const attempt = (): void => {
                if (active < concurrency) {
                    active++;
                    resolve();
                } else {
                    queue.push(attempt);
                }
            };
            attempt();
        });
    const release = (): void => {
        active--;
        queue.shift()?.();
    };

    // --- pending pinned reads, grouped per block; deduped until their read settles ---
    const groups = new Map<string, PendingGroup>();
    const inFlight = new Map<string, PendingRead>();

    const runChunk = async (reads: PendingRead[], blockNumber: bigint): Promise<void> => {
        await acquire();
        try {
            const call = (): Promise<Array<{ status: "success" | "failure"; result?: unknown; error?: unknown }>> =>
                client.multicall({
                    contracts: reads.map((read) => read.contract),
                    allowFailure: true,
                    batchSize: 0,
                    blockNumber
                }) as Promise<Array<{ status: "success" | "failure"; result?: unknown; error?: unknown }>>;
            let results: Awaited<ReturnType<typeof call>>;
            try {
                results = await call();
            } catch {
                await delay(CHAIN_CHUNK_RETRY_DELAY_MS);
                results = await call();
            }
            for (let i = 0; i < reads.length; i++) {
                const outcome = results[i];
                if (outcome?.status === "success") reads[i]!.resolve(outcome.result);
                else reads[i]!.reject(outcome?.error ?? new Error("multicall returned no result for this read"));
            }
        } catch (err) {
            for (const read of reads) read.reject(err);
        } finally {
            release();
            for (const read of reads) inFlight.delete(read.key);
        }
    };

    const flushGroup = (blockKey: string): void => {
        const group = groups.get(blockKey);
        if (!group) return;
        clearTimeout(group.timer);
        groups.delete(blockKey);
        for (let at = 0; at < group.reads.length; at += readsPerCall) {
            void runChunk(group.reads.slice(at, at + readsPerCall), group.blockNumber);
        }
    };

    const rawReadContract = client.readContract.bind(client);
    const readContract = (async (params: CoalescableRead & Record<string, unknown>) => {
        const { address, abi, functionName, args, blockNumber, ...rest } = params;
        // Coalesce only the plain pinned-block read shape; anything else (head reads, blockTag,
        // account/state overrides, ...) keeps direct-call semantics through the raw client.
        if (typeof blockNumber !== "bigint" || Object.keys(rest).length > 0 || !address || !abi || !functionName) {
            return rawReadContract(params as Parameters<typeof rawReadContract>[0]);
        }
        let calldata: string;
        try {
            calldata = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
        } catch {
            return rawReadContract(params as Parameters<typeof rawReadContract>[0]);
        }
        const key = `${blockNumber}:${address.toLowerCase()}:${calldata}`;
        const existing = inFlight.get(key);
        if (existing) return existing.promise;

        let resolve!: (value: unknown) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<unknown>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const read: PendingRead = { contract: { address, abi, functionName, args: args ?? [] }, key, promise, resolve, reject };
        inFlight.set(key, read);

        const blockKey = blockNumber.toString();
        let group = groups.get(blockKey);
        if (!group) {
            group = { blockNumber, reads: [], timer: setTimeout(() => flushGroup(blockKey), windowMs) };
            groups.set(blockKey, group);
        }
        group.reads.push(read);
        if (group.reads.length >= readsPerCall) flushGroup(blockKey);
        return promise;
    }) as ChainClient["readContract"];

    const rawMulticall = client.multicall.bind(client);
    const multicall = (async (params: Parameters<typeof rawMulticall>[0]) => {
        await acquire();
        try {
            return await rawMulticall(params);
        } finally {
            release();
        }
    }) as ChainClient["multicall"];

    return { ...client, readContract, multicall } as ChainClient;
}

/**
 * Wrap a host's `ChainClientFactory` so every client it hands out is coalesced, memoized on the
 * UNDERLYING client instance: a host factory that returns one shared client per chain (the
 * normal shape — and what makes cross-contest coalescing possible at all) gets exactly one
 * coalescer per chain, shared by every contest, the gossip gate, and the background verifier.
 */
export function coalescingChainFactory(factory: ChainClientFactory, options?: CoalescerOptions): ChainClientFactory {
    const wrapped = new WeakMap<ChainClient, ChainClient>();
    return (args) => {
        const client = factory(args);
        let coalesced = wrapped.get(client);
        if (!coalesced) {
            coalesced = coalescingChainClient(client, options);
            wrapped.set(client, coalesced);
        }
        return coalesced;
    };
}
