import { describe, it, expect } from "vitest";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError, createPublicClient, http } from "viem";
import type { ChainClient } from "../chain/types.js";
import type { ChainReadContext, Rule } from "./types.js";
import { erc721MinBalance } from "./erc721-min-balance.js";
import { ERC5192_INTERFACE_ID, erc5192MinBalance } from "./erc5192-min-balance.js";
import { constant } from "./constant.js";
import { erc20Balance } from "./erc20-balance.js";
import { resolveRegistry, validateCriteriaRules, builtinRegistry, V1_BUILTIN_RULE_TYPES } from "./registry.js";
import { UnknownRuleError } from "../errors.js";
import { bizCriteria } from "../test-fixtures.js";

/**
 * A ChainReadContext whose viem client returns a fixed `balanceOf`, for offline rule tests.
 * `erc5192-min-balance` additionally probes `supportsInterface`, so the stub dispatches on
 * `functionName`: `declares` (default true) answers the ERC-5192 assertion, the balance answers
 * everything else.
 */
function ctxWith(balances: { erc20?: bigint; erc721?: bigint; declares?: boolean }): ChainReadContext {
    const balance = balances.erc20 ?? balances.erc721 ?? 0n;
    const chain: ChainClient = createPublicClient({ transport: http("http://localhost") });
    chain.readContract = (async ({ functionName }: { functionName?: string } = {}) =>
        functionName === "supportsInterface" ? (balances.declares ?? true) : balance) as ChainClient["readContract"];
    return { chain, blockNumber: 100 };
}

describe("erc5192-min-balance (the v1 gate: soulbound Pass via score > 0)", () => {
    const options = { type: "erc5192-min-balance" as const, chain: "base", contract: "0x00000000000000000000000000000000000000fa", min: 2 };
    const wallet = "0x000000000000000000000000000000000000aaaa";

    /** A client answering `supportsInterface` from `declares` and `balanceOf` from `balance`, recording every read. */
    function probeChain(over: { declares?: boolean | (() => boolean | never); balance?: bigint; multicall?: boolean } = {}): {
        chain: ChainClient;
        reads: Array<{ functionName: string; args: readonly unknown[]; block?: bigint }>;
    } {
        const reads: Array<{ functionName: string; args: readonly unknown[]; block?: bigint }> = [];
        const chain: ChainClient = createPublicClient({ transport: http("http://localhost") });
        if (over.multicall) {
            (chain as { chain?: unknown }).chain = { contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } } };
            chain.multicall = (async ({ contracts, blockNumber }: { contracts: Array<{ functionName: string; args: readonly unknown[] }>; blockNumber?: bigint }) => {
                for (const c of contracts) reads.push({ functionName: c.functionName, args: c.args, block: blockNumber });
                return contracts.map(() => over.balance ?? 5n);
            }) as unknown as ChainClient["multicall"];
        }
        chain.readContract = (async ({ functionName, args, blockNumber }: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
            reads.push({ functionName, args, block: blockNumber });
            if (functionName !== "supportsInterface") return over.balance ?? 5n;
            const declares = over.declares ?? true;
            return typeof declares === "function" ? declares() : declares;
        }) as unknown as ChainClient["readContract"];
        return { chain, reads };
    }

    it("scores the holding when the contract declares ERC-5192 and the wallet is at or above min", async () => {
        const { score } = await erc5192MinBalance.evaluate({ options, walletAddress: wallet, ctx: ctxWith({ erc721: 3n }) });
        expect(score).toBe(3n);
    });

    it("scores 0 below min (rejected)", async () => {
        const { score } = await erc5192MinBalance.evaluate({ options, walletAddress: wallet, ctx: ctxWith({ erc721: 1n }) });
        expect(score).toBe(0n);
    });

    it("probes supportsInterface(0xb45a3c0e) at the SAME pinned block as the balance", async () => {
        const { chain, reads } = probeChain({ balance: 5n });
        await erc5192MinBalance.evaluate({ options, walletAddress: wallet, ctx: { chain, blockNumber: 100 } });
        const probe = reads.find((r) => r.functionName === "supportsInterface");
        expect(probe).toBeDefined();
        expect(probe!.args).toEqual([ERC5192_INTERFACE_ID]);
        expect(reads.every((r) => r.block === 100n)).toBe(true);
    });

    // The regression guard for issue #27: if the gate ever points at a contract that does not even
    // CLAIM its tokens are locked, it must admit nobody rather than silently gate on a transferable
    // asset (see crdt/amplification.test.ts for what that would allow).
    it("scores 0n when the contract does not declare ERC-5192, however large the balance", async () => {
        const { score } = await erc5192MinBalance.evaluate({ options, walletAddress: wallet, ctx: ctxWith({ erc721: 1000n, declares: false }) });
        expect(score).toBe(0n);
    });

    it("scores 0n for EVERY wallet in a batch when the contract does not declare ERC-5192", async () => {
        const wallets = [wallet, "0x000000000000000000000000000000000000bbbb"];
        const { chain } = probeChain({ declares: false, balance: 9n, multicall: true });
        const results = await erc5192MinBalance.evaluateMany!({ options, walletAddresses: wallets, ctx: { chain, blockNumber: 100 } });
        expect(results.map((r) => r.score)).toEqual([0n, 0n]);
    });

    it("evaluateMany hoists ONE supportsInterface probe for the whole batch", async () => {
        const wallets = Array.from({ length: 5 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
        const { chain, reads } = probeChain({ balance: 5n, multicall: true });
        const results = await erc5192MinBalance.evaluateMany!({ options, walletAddresses: wallets, ctx: { chain, blockNumber: 100 } });
        expect(results.map((r) => r.score)).toEqual(wallets.map(() => 5n));
        expect(reads.filter((r) => r.functionName === "supportsInterface")).toHaveLength(1);
        expect(reads.filter((r) => r.functionName === "balanceOf")).toHaveLength(wallets.length);
    });

    it("evaluateMany falls back to per-wallet balances on a client without multicall3, still probing once", async () => {
        const wallets = [wallet, "0x000000000000000000000000000000000000bbbb"];
        const { chain, reads } = probeChain({ balance: 5n });
        const results = await erc5192MinBalance.evaluateMany!({ options, walletAddresses: wallets, ctx: { chain, blockNumber: 100 } });
        expect(results.map((r) => r.score)).toEqual([5n, 5n]);
        expect(reads.filter((r) => r.functionName === "supportsInterface")).toHaveLength(1);
        expect(reads.filter((r) => r.functionName === "balanceOf")).toHaveLength(2);
    });

    // A contract with no ERC-165 at all reverts instead of returning false. That is a chain FACT
    // (every verifier sees it), so it must read as "does not declare" — not as an infra error.
    it("treats a REVERTING supportsInterface (no ERC-165) as 'does not declare', not an error", async () => {
        const reverted = new ContractFunctionExecutionError(
            new ContractFunctionRevertedError({ abi: [], functionName: "supportsInterface", message: "execution reverted" }),
            { abi: [], args: [], contractAddress: "0x00000000000000000000000000000000000000fa", functionName: "supportsInterface" }
        );
        const { chain } = probeChain({
            declares: () => {
                throw reverted;
            }
        });
        const { score } = await erc5192MinBalance.evaluate({ options, walletAddress: wallet, ctx: { chain, blockNumber: 100 } });
        expect(score).toBe(0n);
    });

    // ...but a gateway failure is NOT a fact about the chain. It stays infra-class (gossip `ignore`,
    // background retry) so a flaky RPC never turns into a consensus `reject`.
    it("rethrows a TRANSPORT failure on the probe (stays infra-class, never a silent 0n)", async () => {
        const offline = new ContractFunctionExecutionError(new HttpRequestError({ url: "http://localhost", status: 429 }), {
            abi: [],
            args: [],
            contractAddress: "0x00000000000000000000000000000000000000fa",
            functionName: "supportsInterface"
        });
        const { chain } = probeChain({
            declares: () => {
                throw offline;
            }
        });
        await expect(erc5192MinBalance.evaluate({ options, walletAddress: wallet, ctx: { chain, blockNumber: 100 } })).rejects.toBeInstanceOf(BaseError);
    });
});

describe("erc721-min-balance (unregistered: a bare, transferable gate)", () => {
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
        expect(registry["erc5192-min-balance"]).toBe(erc5192MinBalance);
        expect(registry["constant"]).toBe(constant);
    });

    it("lets a host override shadow a built-in by type", () => {
        const custom: Rule = { ...erc5192MinBalance, evaluate: async () => ({ score: 1n }) };
        const registry = resolveRegistry({ "erc5192-min-balance": custom });
        expect(registry["erc5192-min-balance"]).toBe(custom);
        expect(registry["constant"]).toBe(constant); // unrelated built-ins untouched
    });

    it("lets a host add a brand-new rule type", () => {
        const seeditGate: Rule = { ...erc5192MinBalance, type: "seedit-mod-allowlist" };
        const registry = resolveRegistry({ "seedit-mod-allowlist": seeditGate });
        expect(registry["seedit-mod-allowlist"]).toBe(seeditGate);
    });
});

/**
 * The exclusions are load-bearing, not an oversight: each unregistered rule gates on an asset
 * that can move, which the CRDT turns into concurrent live votes per asset (pinned in
 * `crdt/amplification.test.ts`). Registering either without its structural fix — the ERC-5192
 * lock assertion for the NFT path (#27), a hold-duration guard for the fungible one (#28) —
 * silently reopens that, so these assertions are the guard against it happening by accident.
 */
describe("registry: what v1 deliberately does NOT ship", () => {
    it("registers exactly the soulbound gate + constant weight", () => {
        expect(Object.keys(builtinRegistry).sort()).toEqual(["constant", "erc5192-min-balance"]);
        expect([...V1_BUILTIN_RULE_TYPES].sort()).toEqual(["constant", "erc5192-min-balance"]);
    });

    it("does not register the transferable ERC-721 gate (#27)", () => {
        expect(builtinRegistry["erc721-min-balance"]).toBeUndefined();
        const criteria = { ...bizCriteria(), rule: { ...bizCriteria().rule, type: "erc721-min-balance" } };
        expect(() => validateCriteriaRules(criteria, builtinRegistry)).toThrow(UnknownRuleError);
    });

    it("does not register erc20-balance (#28: no hold-duration guard yet)", () => {
        expect(builtinRegistry["erc20-balance"]).toBeUndefined();
        const criteria = { ...bizCriteria(), weight: { type: "erc20-balance", chain: "base", contract: `0x${"b5".repeat(20)}` } };
        expect(() => validateCriteriaRules(criteria, builtinRegistry)).toThrow(UnknownRuleError);
    });

    it("still lets a host opt in explicitly through the override map", () => {
        const registry = resolveRegistry({ "erc721-min-balance": erc721MinBalance, "erc20-balance": erc20Balance });
        const criteria = { ...bizCriteria(), rule: { ...bizCriteria().rule, type: "erc721-min-balance" } };
        expect(() => validateCriteriaRules(criteria, registry)).not.toThrow();
    });

    // The rollout hazard from #27: a client that has not upgraded recuses instead of miscounting.
    it("makes an out-of-date client recuse from an erc5192 criteria via requires.rules", () => {
        const stale = { constant };
        expect(() => validateCriteriaRules(bizCriteria(), stale)).toThrow(UnknownRuleError);
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
