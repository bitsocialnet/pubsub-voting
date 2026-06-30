import { describe, it, expect } from "vitest";
import type { ChainClient } from "../chain/types.js";
import type { ChainReadContext, Interpreter } from "./types.js";
import { erc721MinBalance } from "./erc721-min-balance.js";
import { constant } from "./constant.js";
import { erc20Balance } from "./erc20-balance.js";
import { sum } from "./sum.js";
import { resolveRegistry, validateCriteriaInterpreters, builtinRegistry } from "./registry.js";
import { NotImplementedError, UnknownInterpreterError } from "../errors.js";
import { bizCriteria } from "../test-fixtures.js";

/** A ChainReadContext whose client returns fixed balances, for offline interpreter tests. */
function ctxWith(balances: { erc20?: bigint; erc721?: bigint }): ChainReadContext {
    const chain: ChainClient = {
        chainId: 8453,
        getBlockNumber: async () => 100,
        balanceOfErc20: async () => balances.erc20 ?? 0n,
        balanceOfErc721: async () => balances.erc721 ?? 0n
    };
    return { chain, blockNumber: 100 };
}

describe("erc721-min-balance (gate via score > 0)", () => {
    const options = { type: "erc721-min-balance" as const, chain: "base", contract: "0xpass", min: 2 };

    it("scores the holding when at or above min (admitted, and usable as weight)", async () => {
        const score = await erc721MinBalance.evaluate({ options, walletAddress: "0xw", ctx: ctxWith({ erc721: 3n }) });
        expect(score).toBe(3);
    });

    it("scores 0 below min (rejected)", async () => {
        const score = await erc721MinBalance.evaluate({ options, walletAddress: "0xw", ctx: ctxWith({ erc721: 1n }) });
        expect(score).toBe(0);
    });
});

describe("constant", () => {
    it("returns its fixed value with no chain read", async () => {
        const score = await constant.evaluate({ options: { type: "constant", value: 3 }, walletAddress: "0xw", ctx: ctxWith({}) });
        expect(score).toBe(3);
    });
});

describe("erc20-balance (weight, and gate when min is set)", () => {
    it("scales raw units by decimals as a magnitude (min default 0)", async () => {
        const options = { type: "erc20-balance" as const, chain: "base", contract: "0xbso", decimals: 6, min: 0 };
        const score = await erc20Balance.evaluate({ options, walletAddress: "0xw", ctx: ctxWith({ erc20: 1_500_000n }) });
        expect(score).toBe(1.5);
    });

    it("scores 0 below min (gate role)", async () => {
        const options = { type: "erc20-balance" as const, chain: "base", contract: "0xbso", decimals: 6, min: 100 };
        const score = await erc20Balance.evaluate({ options, walletAddress: "0xw", ctx: ctxWith({ erc20: 1_500_000n }) }); // 1.5 < 100
        expect(score).toBe(0);
    });
});

describe("sum (reserved combinator)", () => {
    it("throws until its term-resolution protocol lands", async () => {
        await expect(
            sum.evaluate({ options: { type: "sum", terms: [{ type: "constant" }] }, walletAddress: "0xw", ctx: ctxWith({}) })
        ).rejects.toBeInstanceOf(NotImplementedError);
    });
});

describe("registry: shadowing resolver (one flat map)", () => {
    it("returns the built-ins with no overrides", () => {
        const registry = resolveRegistry();
        expect(registry["erc721-min-balance"]).toBe(erc721MinBalance);
        expect(registry["constant"]).toBe(constant);
    });

    it("lets a host override shadow a built-in by type", () => {
        const custom: Interpreter = { ...erc721MinBalance, evaluate: async () => 1 };
        const registry = resolveRegistry({ "erc721-min-balance": custom });
        expect(registry["erc721-min-balance"]).toBe(custom);
        expect(registry["constant"]).toBe(constant); // unrelated built-ins untouched
    });

    it("lets a host add a brand-new interpreter type", () => {
        const seeditGate: Interpreter = { ...erc721MinBalance, type: "seedit-mod-allowlist" };
        const registry = resolveRegistry({ "seedit-mod-allowlist": seeditGate });
        expect(registry["seedit-mod-allowlist"]).toBe(seeditGate);
    });
});

describe("registry: validateCriteriaInterpreters", () => {
    it("accepts a valid v1 criteria", () => {
        expect(() => validateCriteriaInterpreters(bizCriteria(), builtinRegistry)).not.toThrow();
    });

    it("rejects an unknown eligibility type", () => {
        const criteria = { ...bizCriteria(), eligibility: { type: "nope" } };
        expect(() => validateCriteriaInterpreters(criteria, builtinRegistry)).toThrow(UnknownInterpreterError);
    });

    it("rejects an unknown name in requires.interpreters", () => {
        const base = bizCriteria();
        const criteria = { ...base, requires: { ...base.requires, interpreters: ["erc721-min-balance", "from-the-future"] as [string, ...string[]] } };
        expect(() => validateCriteriaInterpreters(criteria, builtinRegistry)).toThrow(UnknownInterpreterError);
    });

    it("rejects malformed interpreter options", () => {
        const criteria = { ...bizCriteria(), weight: { type: "constant", value: -1 } };
        expect(() => validateCriteriaInterpreters(criteria, builtinRegistry)).toThrow();
    });
});
