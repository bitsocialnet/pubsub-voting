import { describe, it, expect } from "vitest";
import { createPublicClient, http } from "viem";
import type { ChainClient } from "../chain/types.js";
import type { ChainReadContext, Rule } from "./types.js";
import { erc721MinBalance } from "./erc721-min-balance.js";
import { constant } from "./constant.js";
import { erc20Balance } from "./erc20-balance.js";
import { resolveRegistry, validateCriteriaRules, builtinRegistry } from "./registry.js";
import { UnknownRuleError } from "../errors.js";
import { bizCriteria } from "../test-fixtures.js";

/**
 * A ChainReadContext whose viem client returns a fixed `balanceOf`, for offline
 * rule tests. Each rule under test does exactly one `readContract`
 * (ERC-20 or ERC-721 `balanceOf`), so a single stubbed return covers both.
 */
function ctxWith(balances: { erc20?: bigint; erc721?: bigint }): ChainReadContext {
    const balance = balances.erc20 ?? balances.erc721 ?? 0n;
    const chain: ChainClient = createPublicClient({ transport: http("http://localhost") });
    chain.readContract = (async () => balance) as ChainClient["readContract"];
    return { chain, blockNumber: 100 };
}

describe("erc721-min-balance (gate via score > 0)", () => {
    const options = { type: "erc721-min-balance" as const, chain: "base", contract: "0x00000000000000000000000000000000000000fa", min: 2 };

    it("scores the holding when at or above min (admitted, and usable as weight)", async () => {
        const { score } = await erc721MinBalance.evaluate({ options, walletAddress: "0x000000000000000000000000000000000000aaaa", ctx: ctxWith({ erc721: 3n }) });
        expect(score).toBe(3n);
    });

    it("scores 0 below min (rejected)", async () => {
        const { score } = await erc721MinBalance.evaluate({ options, walletAddress: "0x000000000000000000000000000000000000aaaa", ctx: ctxWith({ erc721: 1n }) });
        expect(score).toBe(0n);
    });

    it("evaluateMany batches every wallet into ONE multicall when the client supports it", async () => {
        const wallets = ["0x000000000000000000000000000000000000aaaa", "0x000000000000000000000000000000000000bbbb", "0x000000000000000000000000000000000000cccc"];
        const balances = [3n, 1n, 2n]; // above min, below min, at min
        let multicalls = 0;
        let reads = 0;
        const chain: ChainClient = createPublicClient({ transport: http("http://localhost") });
        // A client whose `chain` knows its multicall3 deployment takes the batched path.
        (chain as { chain?: unknown }).chain = { contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } } };
        chain.multicall = (async ({ contracts }: { contracts: unknown[] }) => {
            multicalls++;
            expect(contracts).toHaveLength(wallets.length);
            return balances;
        }) as unknown as ChainClient["multicall"];
        chain.readContract = (async () => {
            reads++;
            return 0n;
        }) as ChainClient["readContract"];

        const results = await erc721MinBalance.evaluateMany!({ options, walletAddresses: wallets, ctx: { chain, blockNumber: 100 } });
        expect(results.map((r) => r.score)).toEqual([3n, 0n, 2n]); // same semantics as mapped evaluate
        expect(multicalls).toBe(1);
        expect(reads).toBe(0);
    });

    it("evaluateMany chunks a big batch (200/aggregate3, viem re-chunking disabled), ≤2 in flight, order preserved", async () => {
        // 450 wallets → 3 chunks (200, 200, 50). Wallet i's balance is i+2n, so an order slip
        // in results is visible. min=2 ⇒ every wallet qualifies with score i+2n.
        const wallets = Array.from({ length: 450 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
        const chunkSizes: number[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const chain: ChainClient = createPublicClient({ transport: http("http://localhost") });
        (chain as { chain?: unknown }).chain = { contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } } };
        chain.multicall = (async ({ contracts, batchSize }: { contracts: Array<{ args: readonly [string] }>; batchSize?: number }) => {
            expect(batchSize).toBe(0); // one aggregate3 per chunk — viem must not re-chunk at 1KB
            chunkSizes.push(contracts.length);
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 5)); // overlap window so concurrency is observable
            inFlight--;
            return contracts.map(({ args }) => BigInt(parseInt(args[0].slice(2), 16)) + 1n);
        }) as unknown as ChainClient["multicall"];

        const results = await erc721MinBalance.evaluateMany!({ options, walletAddresses: wallets, ctx: { chain, blockNumber: 100 } });
        expect(chunkSizes).toEqual([200, 200, 50]);
        expect(maxInFlight).toBeLessThanOrEqual(2);
        expect(results.map((r) => r.score)).toEqual(wallets.map((_, i) => BigInt(i) + 2n));
    });

    it("evaluateMany retries ONLY the failed chunk, keeping completed chunks' reads", async () => {
        const wallets = Array.from({ length: 400 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
        const calls: number[] = []; // first wallet index of each multicall, in call order
        let failedOnce = false;
        const chain: ChainClient = createPublicClient({ transport: http("http://localhost") });
        (chain as { chain?: unknown }).chain = { contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } } };
        chain.multicall = (async ({ contracts }: { contracts: Array<{ args: readonly [string] }> }) => {
            const first = parseInt(contracts[0]!.args[0].slice(2), 16) - 1;
            calls.push(first);
            if (first === 200 && !failedOnce) {
                failedOnce = true;
                throw new Error("429 too many requests");
            }
            return contracts.map(() => 5n);
        }) as unknown as ChainClient["multicall"];

        const results = await erc721MinBalance.evaluateMany!({ options, walletAddresses: wallets, ctx: { chain, blockNumber: 100 } });
        expect(results).toHaveLength(400);
        expect(results.every((r) => r.score === 5n)).toBe(true);
        // Chunk 0 read once; chunk 1 (wallet 200) failed once then retried — never chunk 0 again.
        expect(calls.filter((first) => first === 0)).toHaveLength(1);
        expect(calls.filter((first) => first === 200)).toHaveLength(2);
    });

    it("evaluateMany falls back to per-wallet reads on a client without multicall3", async () => {
        const wallets = ["0x000000000000000000000000000000000000aaaa", "0x000000000000000000000000000000000000bbbb"];
        let reads = 0;
        const chain: ChainClient = createPublicClient({ transport: http("http://localhost") });
        chain.readContract = (async () => {
            reads++;
            return 5n;
        }) as ChainClient["readContract"];

        const results = await erc721MinBalance.evaluateMany!({ options, walletAddresses: wallets, ctx: { chain, blockNumber: 100 } });
        expect(results.map((r) => r.score)).toEqual([5n, 5n]);
        expect(reads).toBe(2);
    });
});

describe("constant", () => {
    it("returns its fixed value with no chain read", async () => {
        const { score } = await constant.evaluate({ options: { type: "constant", value: 3 }, walletAddress: "0x000000000000000000000000000000000000aaaa", ctx: ctxWith({}) });
        expect(score).toBe(3n);
    });
});

describe("erc20-balance (weight, and gate when min is set)", () => {
    it("returns raw base units as the magnitude (ordering-preserving; min default 0)", async () => {
        const options = { type: "erc20-balance" as const, chain: "base", contract: "0x0000000000000000000000000000000000000b50", decimals: 6, min: 0 };
        const { score } = await erc20Balance.evaluate({ options, walletAddress: "0x000000000000000000000000000000000000aaaa", ctx: ctxWith({ erc20: 1_500_000n }) });
        expect(score).toBe(1_500_000n);
    });

    it("scores 0 below min (gate role)", async () => {
        const options = { type: "erc20-balance" as const, chain: "base", contract: "0x0000000000000000000000000000000000000b50", decimals: 6, min: 100 };
        const { score } = await erc20Balance.evaluate({ options, walletAddress: "0x000000000000000000000000000000000000aaaa", ctx: ctxWith({ erc20: 1_500_000n }) }); // 1.5 tokens < 100
        expect(score).toBe(0n);
    });
});

describe("registry: shadowing resolver (one flat map)", () => {
    it("returns the built-ins with no overrides", () => {
        const registry = resolveRegistry();
        expect(registry["erc721-min-balance"]).toBe(erc721MinBalance);
        expect(registry["constant"]).toBe(constant);
    });

    it("lets a host override shadow a built-in by type", () => {
        const custom: Rule = { ...erc721MinBalance, evaluate: async () => ({ score: 1n }) };
        const registry = resolveRegistry({ "erc721-min-balance": custom });
        expect(registry["erc721-min-balance"]).toBe(custom);
        expect(registry["constant"]).toBe(constant); // unrelated built-ins untouched
    });

    it("lets a host add a brand-new rule type", () => {
        const seeditGate: Rule = { ...erc721MinBalance, type: "seedit-mod-allowlist" };
        const registry = resolveRegistry({ "seedit-mod-allowlist": seeditGate });
        expect(registry["seedit-mod-allowlist"]).toBe(seeditGate);
    });
});

describe("registry: validateCriteriaRules", () => {
    it("accepts a valid v1 criteria", () => {
        expect(() => validateCriteriaRules(bizCriteria(), builtinRegistry)).not.toThrow();
    });

    it("rejects an unknown rule type", () => {
        const criteria = { ...bizCriteria(), rule: { type: "nope" } };
        expect(() => validateCriteriaRules(criteria, builtinRegistry)).toThrow(UnknownRuleError);
    });

    it("rejects an unknown name in requires.rules", () => {
        const base = bizCriteria();
        const criteria = { ...base, requires: { ...base.requires, rules: ["erc721-min-balance", "from-the-future"] as [string, ...string[]] } };
        expect(() => validateCriteriaRules(criteria, builtinRegistry)).toThrow(UnknownRuleError);
    });

    it("rejects malformed rule options", () => {
        const criteria = { ...bizCriteria(), weight: { type: "constant", value: -1 } };
        expect(() => validateCriteriaRules(criteria, builtinRegistry)).toThrow();
    });
});
