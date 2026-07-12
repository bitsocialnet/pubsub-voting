import { describe, it, expect } from "vitest";
import { makeGateResultCache, makePersistentGateResultCache, purgeExpiredGateResults } from "./gate-result-cache.js";
import { makeMemoryLruStorage } from "../storage/memory.js";
import type { LruStorage } from "../storage/types.js";

const WALLET = "0xAbC0000000000000000000000000000000000001";
const RULE_HASH = "0xrulehash";

describe("makeGateResultCache", () => {
    it("memoizes and recalls a `(wallet, sampleBlock)` score (miss and hit)", async () => {
        const cache = makeGateResultCache();
        expect(await cache.get(WALLET, 100)).toBeUndefined();
        cache.set(WALLET, 100, 0n); // an ineligible miss
        expect(await cache.get(WALLET, 100)).toBe(0n);
        cache.set(WALLET, 200, 3n); // an eligible hit at a different block
        expect(await cache.get(WALLET, 200)).toBe(3n);
        // A different sample block for the same wallet is a distinct key (re-read when the
        // wallet's holding might have changed in a later bucket).
        expect(await cache.get(WALLET, 101)).toBeUndefined();
    });

    it("keys case-insensitively on the wallet address", async () => {
        const cache = makeGateResultCache();
        cache.set(WALLET.toUpperCase(), 7, 1n);
        expect(await cache.get(WALLET.toLowerCase(), 7)).toBe(1n);
    });

    it("evicts the oldest entry past the cap (FIFO), and set is idempotent", async () => {
        const cache = makeGateResultCache(2);
        cache.set("0xa", 1, 1n);
        cache.set("0xb", 1, 1n);
        // Re-setting an existing key must NOT refresh its position or overwrite (idempotent, no
        // reorder), so the oldest is still 0xa when the third distinct key evicts one.
        cache.set("0xb", 1, 9n);
        expect(await cache.get("0xb", 1)).toBe(1n); // original score kept, not overwritten
        cache.set("0xc", 1, 1n);
        expect(await cache.get("0xa", 1)).toBeUndefined(); // evicted as the oldest
        expect(await cache.get("0xb", 1)).toBe(1n);
        expect(await cache.get("0xc", 1)).toBe(1n);
    });
});

describe("makePersistentGateResultCache", () => {
    it("writes through to the store under the rule hash (score as a decimal string)", async () => {
        const store = makeMemoryLruStorage(100);
        const cache = makePersistentGateResultCache({ store, ruleHash: RULE_HASH });
        cache.set(WALLET, 100, 3n);
        await Promise.resolve(); // let the fire-and-forget persist settle
        expect(await store.getItem(`${RULE_HASH}:${WALLET.toLowerCase()}:100`)).toBe("3");
    });

    it("reads through to the store on a memory miss (a fresh cache sees a prior session's score)", async () => {
        const store = makeMemoryLruStorage(100);
        await store.setItem(`${RULE_HASH}:${WALLET.toLowerCase()}:100`, "7");
        const cache = makePersistentGateResultCache({ store, ruleHash: RULE_HASH });
        expect(await cache.get(WALLET, 100)).toBe(7n);
    });

    it("isolates rules: the same (wallet, sampleBlock) under another rule hash is a miss", async () => {
        const store = makeMemoryLruStorage(100);
        makePersistentGateResultCache({ store, ruleHash: "0xother" }).set(WALLET, 100, 9n);
        await Promise.resolve();
        const cache = makePersistentGateResultCache({ store, ruleHash: RULE_HASH });
        expect(await cache.get(WALLET, 100)).toBeUndefined();
    });

    it("degrades to a miss (a live chain read), never an error, when the store breaks", async () => {
        const broken: LruStorage = {
            getItem: async () => {
                throw new Error("boom");
            },
            setItem: async () => {
                throw new Error("boom");
            },
            removeItem: async () => {},
            keys: async () => [],
            clear: async () => {}
        };
        const cache = makePersistentGateResultCache({ store: broken, ruleHash: RULE_HASH });
        cache.set(WALLET, 100, 3n); // swallowed persist failure...
        await Promise.resolve();
        expect(await cache.get(WALLET, 100)).toBe(3n); // ...but the memory front still serves it
        expect(await cache.get(WALLET, 200)).toBeUndefined(); // store read failure -> plain miss
    });

    it("ignores a corrupt persisted value (non-decimal) rather than yielding a wrong score", async () => {
        const store = makeMemoryLruStorage(100);
        await store.setItem(`${RULE_HASH}:${WALLET.toLowerCase()}:100`, { not: "a score" });
        const cache = makePersistentGateResultCache({ store, ruleHash: RULE_HASH });
        expect(await cache.get(WALLET, 100)).toBeUndefined();
    });
});

describe("purgeExpiredGateResults", () => {
    it("removes only this rule's entries strictly older than the oldest admissible sample block", async () => {
        const store = makeMemoryLruStorage(100);
        await store.setItem(`${RULE_HASH}:0xa:100`, "1"); // dead: 100 < 200
        await store.setItem(`${RULE_HASH}:0xa:200`, "1"); // boundary: kept (still admissible)
        await store.setItem(`${RULE_HASH}:0xa:300`, "1"); // live
        await store.setItem(`0xother:0xa:100`, "1"); // other rule: untouched
        await purgeExpiredGateResults({ store, ruleHash: RULE_HASH, oldestSampleBlock: 200 });
        expect(await store.getItem(`${RULE_HASH}:0xa:100`)).toBeUndefined();
        expect(await store.getItem(`${RULE_HASH}:0xa:200`)).toBe("1");
        expect(await store.getItem(`${RULE_HASH}:0xa:300`)).toBe("1");
        expect(await store.getItem(`0xother:0xa:100`)).toBe("1");
    });
});
