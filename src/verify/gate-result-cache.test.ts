import { describe, it, expect } from "vitest";
import { makeGateResultCache } from "./gate-result-cache.js";

const WALLET = "0xAbC0000000000000000000000000000000000001";

describe("makeGateResultCache", () => {
    it("memoizes and recalls a `(wallet, sampleBlock)` score (miss and hit)", () => {
        const cache = makeGateResultCache();
        expect(cache.get(WALLET, 100)).toBeUndefined();
        cache.set(WALLET, 100, 0n); // an ineligible miss
        expect(cache.get(WALLET, 100)).toBe(0n);
        cache.set(WALLET, 200, 3n); // an eligible hit at a different block
        expect(cache.get(WALLET, 200)).toBe(3n);
        // A different sample block for the same wallet is a distinct key (re-read when the
        // wallet's holding might have changed in a later bucket).
        expect(cache.get(WALLET, 101)).toBeUndefined();
    });

    it("keys case-insensitively on the wallet address", () => {
        const cache = makeGateResultCache();
        cache.set(WALLET.toUpperCase(), 7, 1n);
        expect(cache.get(WALLET.toLowerCase(), 7)).toBe(1n);
    });

    it("evicts the oldest entry past the cap (FIFO), and set is idempotent", () => {
        const cache = makeGateResultCache(2);
        cache.set("0xa", 1, 1n);
        cache.set("0xb", 1, 1n);
        // Re-setting an existing key must NOT refresh its position or overwrite (idempotent, no
        // reorder), so the oldest is still 0xa when the third distinct key evicts one.
        cache.set("0xb", 1, 9n);
        expect(cache.get("0xb", 1)).toBe(1n); // original score kept, not overwritten
        cache.set("0xc", 1, 1n);
        expect(cache.get("0xa", 1)).toBeUndefined(); // evicted as the oldest
        expect(cache.get("0xb", 1)).toBe(1n);
        expect(cache.get("0xc", 1)).toBe(1n);
    });
});
