import { describe, it, expect } from "vitest";
import { makeGateNegativeCache } from "./negative-cache.js";

const WALLET = "0xAbC0000000000000000000000000000000000001";

describe("makeGateNegativeCache", () => {
    it("records and recalls a (wallet, sampleBlock) miss", () => {
        const cache = makeGateNegativeCache();
        expect(cache.has(WALLET, 100)).toBe(false);
        cache.add(WALLET, 100);
        expect(cache.has(WALLET, 100)).toBe(true);
        // A different sample block for the same wallet is a distinct key (re-read when the
        // wallet might have acquired the asset in a later bucket).
        expect(cache.has(WALLET, 101)).toBe(false);
    });

    it("keys case-insensitively on the wallet address", () => {
        const cache = makeGateNegativeCache();
        cache.add(WALLET.toUpperCase(), 7);
        expect(cache.has(WALLET.toLowerCase(), 7)).toBe(true);
    });

    it("evicts the oldest entry past the cap (FIFO), and add is idempotent", () => {
        const cache = makeGateNegativeCache(2);
        cache.add("0xa", 1);
        cache.add("0xb", 1);
        // Re-adding an existing key must NOT refresh its position (idempotent, no reorder),
        // so the oldest is still 0xa when the third distinct key evicts one.
        cache.add("0xb", 1);
        cache.add("0xc", 1);
        expect(cache.has("0xa", 1)).toBe(false); // evicted as the oldest
        expect(cache.has("0xb", 1)).toBe(true);
        expect(cache.has("0xc", 1)).toBe(true);
    });
});
