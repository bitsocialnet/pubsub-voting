import { describe, it, expect } from "vitest";
import { createPublicClient, erc721Abi, http } from "viem";
import type { ChainClient } from "./types.js";
import { coalescingChainClient, coalescingChainFactory } from "./coalescer.js";

/**
 * The coalescer is pure transport policy over an injected viem client, so it is fully testable
 * offline: a stub client records the multicall traffic the wrapper produces. `windowMs: 1`
 * keeps tests fast; reads issued in the same tick coalesce regardless of the window length.
 */

const MC3 = { address: "0xca11bde05977b3631167028862be2a173976ca11" as const };
const CONTRACT = "0x00000000000000000000000000000000000000fa" as const;
const wallet = (i: number): `0x${string}` => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`;

interface MulticallSeen {
    contracts: Array<{ address: string; functionName: string; args: readonly [string] }>;
    blockNumber?: bigint;
    batchSize?: number;
    allowFailure?: boolean;
}

/** A stub client whose multicall answers each read with `handler(walletAddress)`. */
function stubClient(handler: (walletArg: string, seen: MulticallSeen) => unknown, opts: { delayMs?: number; multicall3?: boolean } = {}) {
    const seenCalls: MulticallSeen[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client = createPublicClient({ transport: http("http://localhost") });
    if (opts.multicall3 !== false) (client as { chain?: unknown }).chain = { contracts: { multicall3: MC3 } };
    client.multicall = (async (params: MulticallSeen & { allowFailure?: boolean }) => {
        seenCalls.push(params);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        inFlight--;
        return params.contracts.map((c) => {
            try {
                const result = handler(c.args[0], params);
                return params.allowFailure === false ? result : { status: "success", result };
            } catch (error) {
                if (params.allowFailure === false) throw error;
                return { status: "failure", error };
            }
        });
    }) as unknown as ChainClient["multicall"];
    return { client: client as unknown as ChainClient, seenCalls, maxInFlight: () => maxInFlight };
}

/** One pinned `balanceOf` read through the wrapper. */
const readBalance = (chain: ChainClient, walletAddress: `0x${string}`, blockNumber = 100n): Promise<bigint> =>
    chain.readContract({
        address: CONTRACT,
        abi: erc721Abi,
        functionName: "balanceOf",
        args: [walletAddress],
        blockNumber
    }) as Promise<bigint>;

describe("coalescingChainClient", () => {
    it("coalesces same-tick pinned reads into ONE aggregate3 (allowFailure, viem re-chunking off)", async () => {
        const { client, seenCalls } = stubClient((w) => BigInt(parseInt(w.slice(2), 16)));
        const chain = coalescingChainClient(client, { windowMs: 1 });
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => readBalance(chain, wallet(i))));
        expect(seenCalls).toHaveLength(1);
        expect(seenCalls[0]!.contracts).toHaveLength(10);
        expect(seenCalls[0]!.blockNumber).toBe(100n);
        expect(seenCalls[0]!.batchSize).toBe(0);
        expect(seenCalls[0]!.allowFailure).toBe(true);
        expect(results).toEqual(Array.from({ length: 10 }, (_, i) => BigInt(i + 1)));
    });

    it("never merges reads pinned to different blocks (one eth_call reads one block)", async () => {
        const { client, seenCalls } = stubClient(() => 1n);
        const chain = coalescingChainClient(client, { windowMs: 1 });
        await Promise.all([readBalance(chain, wallet(0), 100n), readBalance(chain, wallet(1), 200n)]);
        expect(seenCalls).toHaveLength(2);
        expect(seenCalls.map((c) => c.blockNumber).sort()).toEqual([100n, 200n]);
    });

    it("chunks big same-block batches and honors the shared in-flight budget", async () => {
        const { client, seenCalls, maxInFlight } = stubClient(() => 1n, { delayMs: 5 });
        const chain = coalescingChainClient(client, { windowMs: 1, readsPerCall: 200, concurrency: 2 });
        await Promise.all(Array.from({ length: 450 }, (_, i) => readBalance(chain, wallet(i))));
        expect(seenCalls.map((c) => c.contracts.length)).toEqual([200, 200, 50]);
        expect(maxInFlight()).toBeLessThanOrEqual(2);
    });

    it("dedupes identical in-flight reads — two callers, one wire read, both resolve", async () => {
        const { client, seenCalls } = stubClient(() => 7n);
        const chain = coalescingChainClient(client, { windowMs: 1 });
        const [a, b] = await Promise.all([readBalance(chain, wallet(0)), readBalance(chain, wallet(0))]);
        expect(a).toBe(7n);
        expect(b).toBe(7n);
        expect(seenCalls).toHaveLength(1);
        expect(seenCalls[0]!.contracts).toHaveLength(1);
    });

    it("a per-read failure rejects ONLY that caller; batchmates still resolve", async () => {
        const bad = wallet(1);
        const { client } = stubClient((w) => {
            if (w.toLowerCase() === bad.toLowerCase()) throw new Error("execution reverted");
            return 3n;
        });
        const chain = coalescingChainClient(client, { windowMs: 1 });
        const outcomes = await Promise.allSettled([readBalance(chain, wallet(0)), readBalance(chain, bad), readBalance(chain, wallet(2))]);
        expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    });

    it("retries a whole failed chunk once, then rejects its readers", async () => {
        let calls = 0;
        const { client, seenCalls } = stubClient(() => 5n);
        const raw = client.multicall.bind(client);
        client.multicall = (async (params: unknown) => {
            calls++;
            if (calls === 1) throw new Error("429 over rate limit");
            return raw(params as Parameters<typeof raw>[0]);
        }) as ChainClient["multicall"];
        const chain = coalescingChainClient(client, { windowMs: 1 });
        const results = await Promise.all([readBalance(chain, wallet(0)), readBalance(chain, wallet(1))]);
        expect(results).toEqual([5n, 5n]);
        expect(calls).toBe(2); // one failure, one retry — the group was not re-enqueued
        expect(seenCalls).toHaveLength(1); // only the successful attempt reached the stub recorder
    });

    it("DECOMPOSES pinned explicit multicalls into the shared pool — contests' batches merge and dedupe", async () => {
        const { client, seenCalls } = stubClient((w) => BigInt(parseInt(w.slice(2), 16)));
        const chain = coalescingChainClient(client, { windowMs: 1 });
        const batch = (wallets: Array<`0x${string}`>) =>
            chain.multicall({
                contracts: wallets.map((w) => ({ address: CONTRACT, abi: erc721Abi, functionName: "balanceOf" as const, args: [w] as const })),
                allowFailure: false,
                blockNumber: 100n
            }) as Promise<bigint[]>;
        // Two "contests" batch-verify concurrently (one shared wallet) + a lone coalesced read.
        const [a, b, single] = await Promise.all([batch([wallet(0), wallet(1)]), batch([wallet(1), wallet(2)]), readBalance(chain, wallet(3))]);
        expect(seenCalls).toHaveLength(1); // ONE aggregate3 on the wire...
        expect(seenCalls[0]!.contracts).toHaveLength(4); // ...with wallet(1) read once, not twice
        expect(a).toEqual([1n, 2n]);
        expect(b).toEqual([2n, 3n]);
        expect(single).toBe(4n);
    });

    it("decomposed multicall keeps viem result semantics for both allowFailure modes", async () => {
        const bad = wallet(1);
        const { client } = stubClient((w) => {
            if (w.toLowerCase() === bad.toLowerCase()) throw new Error("execution reverted");
            return 3n;
        });
        const chain = coalescingChainClient(client, { windowMs: 1 });
        const contracts = [wallet(0), bad].map((w) => ({ address: CONTRACT, abi: erc721Abi, functionName: "balanceOf" as const, args: [w] as const }));
        // allowFailure: true → per-entry status objects, batchmates unaffected.
        const soft = (await chain.multicall({ contracts, allowFailure: true, blockNumber: 100n })) as Array<{ status: string; result?: unknown }>;
        expect(soft.map((r) => r.status)).toEqual(["success", "failure"]);
        expect(soft[0]!.result).toBe(3n);
        // allowFailure: false → the whole call rejects (the rule's chunk retry path).
        await expect(chain.multicall({ contracts, allowFailure: false, blockNumber: 100n })).rejects.toThrow("execution reverted");
    });

    it("unpinned multicalls pass through but count against the SAME in-flight budget", async () => {
        const { client, seenCalls, maxInFlight } = stubClient(() => 1n, { delayMs: 5 });
        const chain = coalescingChainClient(client, { windowMs: 1, concurrency: 2 });
        const contracts = [{ address: CONTRACT, abi: erc721Abi, functionName: "balanceOf" as const, args: [wallet(0)] as const }];
        await Promise.all(Array.from({ length: 4 }, () => chain.multicall({ contracts, allowFailure: false }))); // no blockNumber
        expect(seenCalls).toHaveLength(4); // head-block semantics: not merged...
        expect(maxInFlight()).toBeLessThanOrEqual(2); // ...but budgeted
    });

    it("routes pinned multicalls with exotic options raw (viem semantics), while batchSize still decomposes", async () => {
        const { client, seenCalls } = stubClient(() => 1n);
        const chain = coalescingChainClient(client, { windowMs: 1 });
        const contracts = [{ address: CONTRACT, abi: erc721Abi, functionName: "balanceOf" as const, args: [wallet(0)] as const }];
        // stateOverride changes what the eth_call executes against — decomposing would drop it.
        await chain.multicall({
            contracts,
            allowFailure: false,
            blockNumber: 100n,
            stateOverride: [{ address: CONTRACT, balance: 1n }]
        } as unknown as Parameters<ChainClient["multicall"]>[0]);
        expect(seenCalls).toHaveLength(1);
        expect((seenCalls[0] as MulticallSeen & { stateOverride?: unknown }).stateOverride).toBeDefined(); // passed through whole, option intact
        // batchSize is chunking config, not execution semantics: still decomposed into the pool.
        await chain.multicall({ contracts, allowFailure: false, batchSize: 0, blockNumber: 100n });
        expect(seenCalls).toHaveLength(2);
        expect(seenCalls[1]!.batchSize).toBe(0); // the POOL's chunk params, not a raw passthrough
        expect(seenCalls[1]!.allowFailure).toBe(true);
    });

    it("passes through reads it must not batch (no blockNumber / extra options) and bare clients", async () => {
        const { client, seenCalls } = stubClient(() => 1n);
        let directReads = 0;
        client.readContract = (async () => {
            directReads++;
            return 9n;
        }) as ChainClient["readContract"];
        const chain = coalescingChainClient(client, { windowMs: 1 });
        // No blockNumber → head-read semantics, stays a direct call.
        const atHead = await chain.readContract({ address: CONTRACT, abi: erc721Abi, functionName: "balanceOf", args: [wallet(0)] });
        // Extra call option (account) → semantics the multicall path would change, stays direct.
        const withAccount = await chain.readContract({
            address: CONTRACT,
            abi: erc721Abi,
            functionName: "balanceOf",
            args: [wallet(0)],
            blockNumber: 100n,
            account: wallet(1)
        } as Parameters<ChainClient["readContract"]>[0]);
        expect(atHead).toBe(9n);
        expect(withAccount).toBe(9n);
        expect(directReads).toBe(2);
        expect(seenCalls).toHaveLength(0);

        // A client with no multicall3 deployment is returned unwrapped.
        const bare = stubClient(() => 1n, { multicall3: false });
        expect(coalescingChainClient(bare.client)).toBe(bare.client);
    });
});

describe("coalescingChainFactory", () => {
    it("memoizes on the underlying client so parallel contests share ONE coalescer", async () => {
        const { client, seenCalls } = stubClient(() => 2n);
        const factory = coalescingChainFactory(() => client, { windowMs: 5 });
        const config = { chainId: 8453, rpcUrls: ["http://localhost"] as [string, ...string[]] };
        const a = factory({ chain: "base", config });
        const b = factory({ chain: "base", config });
        expect(a).toBe(b);
        // Reads from two "contests" (two factory calls) land in one aggregate3.
        await Promise.all([readBalance(a, wallet(0)), readBalance(b, wallet(1))]);
        expect(seenCalls).toHaveLength(1);
        expect(seenCalls[0]!.contracts).toHaveLength(2);
    });
});
