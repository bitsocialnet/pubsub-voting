import { describe, it, expect, vi } from "vitest";
import { makeMemoryRuleCache, makePersistentRuleCache } from "./cache.js";
import type { LruStorage } from "../storage/types.js";

/**
 * The cache rules compute through (rules/cache.ts). The split it encodes: a rule owns the KEYS
 * and the EPOCHS — what an entry is about and when it stops being true, which is the part that
 * genuinely differs between rules — while the library owns the store, the bound, the namespace
 * and the purge. These tests pin the library's half; what each built-in rule keys by is pinned
 * in rules.test.ts.
 */

/** A minimal in-memory {@link LruStorage}, with a hook for making reads or writes fail. */
function fakeStore(over: { failGet?: boolean; failSet?: boolean } = {}): LruStorage & { map: Map<string, unknown> } {
    const map = new Map<string, unknown>();
    return {
        map,
        async getItem(key) {
            if (over.failGet) throw new Error("store down");
            return map.get(key);
        },
        async setItem(key, value) {
            if (over.failSet) throw new Error("store down");
            map.set(key, value);
        },
        async removeItem(key) {
            map.delete(key);
        },
        async keys() {
            return [...map.keys()];
        },
        async clear() {
            map.clear();
        }
    };
}

describe("makeMemoryRuleCache", () => {
    it("round-trips a value under (key, epoch), and misses on either differing", async () => {
        const cache = makeMemoryRuleCache();
        cache.set({ key: "bal/0xaa", epoch: 100, value: "7" });
        expect(await cache.get({ key: "bal/0xaa", epoch: 100 })).toEqual({ value: "7" });
        // A moved epoch IS the expiry mechanism: the old entry is simply unreachable.
        expect(await cache.get({ key: "bal/0xaa", epoch: 130 })).toEqual({ value: undefined });
        expect(await cache.get({ key: "bal/0xbb", epoch: 100 })).toEqual({ value: undefined });
    });

    it("never overwrites an existing entry (a settled read cannot be silently replaced)", async () => {
        const cache = makeMemoryRuleCache();
        cache.set({ key: "k", epoch: 1, value: "first" });
        cache.set({ key: "k", epoch: 1, value: "second" });
        expect(await cache.get({ key: "k", epoch: 1 })).toEqual({ value: "first" });
    });

    it("bounds itself by FIFO eviction — a flood of fresh keys is not a memory-exhaustion vector", async () => {
        const cache = makeMemoryRuleCache({ maxEntries: 2 });
        cache.set({ key: "a", epoch: 1, value: "1" });
        cache.set({ key: "b", epoch: 1, value: "2" });
        cache.set({ key: "c", epoch: 1, value: "3" });
        expect(await cache.get({ key: "a", epoch: 1 })).toEqual({ value: undefined }); // evicted
        expect(await cache.get({ key: "c", epoch: 1 })).toEqual({ value: "3" });
    });

    describe("memoMany", () => {
        it("reads ONLY the misses, once, and returns every value in input order", async () => {
            const cache = makeMemoryRuleCache();
            cache.set({ key: "b", epoch: 5, value: "B" });
            const seen: string[][] = [];
            const { values } = await cache.memoMany({
                keys: ["a", "b", "c"],
                epoch: 5,
                read: async ({ keys }) => {
                    seen.push(keys);
                    return { values: keys.map((key) => key.toUpperCase()) };
                }
            });
            expect(values).toEqual(["A", "B", "C"]);
            expect(seen).toEqual([["a", "c"]]); // one call, misses only — the batching property
            expect(await cache.get({ key: "a", epoch: 5 })).toEqual({ value: "A" }); // and memoized
        });

        it("skips the read entirely when everything hits", async () => {
            const cache = makeMemoryRuleCache();
            cache.set({ key: "a", epoch: 1, value: "A" });
            let called = false;
            const { values } = await cache.memoMany({
                keys: ["a"],
                epoch: 1,
                read: async () => {
                    called = true;
                    return { values: ["X"] };
                }
            });
            expect(values).toEqual(["A"]);
            expect(called).toBe(false);
        });

        it("collapses a duplicate key into one read (a batch may name a wallet twice)", async () => {
            const cache = makeMemoryRuleCache();
            const seen: string[][] = [];
            const { values } = await cache.memoMany({
                keys: ["a", "b", "a"],
                epoch: 1,
                read: async ({ keys }) => {
                    seen.push(keys);
                    return { values: keys.map((key) => key.toUpperCase()) };
                }
            });
            expect(values).toEqual(["A", "B", "A"]);
            expect(seen).toEqual([["a", "b"]]);
        });

        it("throws when the read returns the wrong number of values (a rule bug, not a bad score)", async () => {
            const cache = makeMemoryRuleCache();
            await expect(
                cache.memoMany({ keys: ["a", "b"], epoch: 1, read: async () => ({ values: ["only-one"] }) })
            ).rejects.toThrow(/2 keys/);
        });
    });

    it("purges below an epoch, optionally scoped to a key prefix", async () => {
        // The scoping is what lets one rule mix short-lived and permanent entries: the v1 gate
        // purges its head-keyed reads as the head rolls without touching its pinned ones.
        const cache = makeMemoryRuleCache();
        cache.set({ key: "head/bal/0xaa", epoch: 100, value: "1" });
        cache.set({ key: "head/bal/0xaa", epoch: 200, value: "1" });
        cache.set({ key: "pin/bal/0xaa", epoch: 100, value: "1" });
        cache.purgeBelow({ epoch: 200, keyPrefix: "head/" });
        expect(await cache.get({ key: "head/bal/0xaa", epoch: 100 })).toEqual({ value: undefined });
        expect(await cache.get({ key: "head/bal/0xaa", epoch: 200 })).toEqual({ value: "1" });
        expect(await cache.get({ key: "pin/bal/0xaa", epoch: 100 })).toEqual({ value: "1" }); // untouched
    });
});

describe("makePersistentRuleCache", () => {
    it("writes through to the store under its namespace, and reads back through on a fresh front", async () => {
        const store = fakeStore();
        makePersistentRuleCache({ store, namespace: "gate-hash" }).set({ key: "bal/0xaa", epoch: 100, value: "7" });
        await Promise.resolve(); // the write is fire-and-forget: the hot path never waits on it
        expect([...store.map.keys()]).toEqual(["gate-hash:bal/0xaa:100"]);

        // A second cache over the same store — the restart case — serves it without a chain read.
        const restarted = makePersistentRuleCache({ store, namespace: "gate-hash" });
        expect(await restarted.get({ key: "bal/0xaa", epoch: 100 })).toEqual({ value: "7" });
    });

    it("keeps two namespaces apart (two gates on one store cannot collide)", async () => {
        const store = fakeStore();
        makePersistentRuleCache({ store, namespace: "gate-a" }).set({ key: "bal/0xaa", epoch: 1, value: "1" });
        await Promise.resolve();
        expect(await makePersistentRuleCache({ store, namespace: "gate-b" }).get({ key: "bal/0xaa", epoch: 1 })).toEqual({
            value: undefined
        });
    });

    it("degrades to a miss when the store throws — never an error into the verify pipeline", async () => {
        const cache = makePersistentRuleCache({ store: fakeStore({ failGet: true, failSet: true }), namespace: "n" });
        expect(() => cache.set({ key: "k", epoch: 1, value: "v" })).not.toThrow();
        expect(await cache.get({ key: "k", epoch: 1 })).toEqual({ value: "v" }); // the memory front still hit
        const cold = makePersistentRuleCache({ store: fakeStore({ failGet: true }), namespace: "n" });
        expect(await cold.get({ key: "k", epoch: 1 })).toEqual({ value: undefined }); // a broken read = a re-read
    });

    it("purges dead persisted entries, and re-purges only when the epoch advances", async () => {
        const store = fakeStore();
        const removed: string[] = [];
        const originalRemove = store.removeItem.bind(store);
        store.removeItem = async (key) => {
            removed.push(key);
            await originalRemove(key);
        };
        const cache = makePersistentRuleCache({ store, namespace: "n" });
        cache.set({ key: "head/a", epoch: 100, value: "1" });
        cache.set({ key: "head/a", epoch: 200, value: "1" });
        await Promise.resolve();

        cache.purgeBelow({ epoch: 200, keyPrefix: "head/" });
        await vi.waitFor(() => expect(store.map.has("n:head/a:100")).toBe(false));
        expect(store.map.has("n:head/a:200")).toBe(true);

        // A repeat at or below the last purged epoch costs no key scan at all.
        removed.length = 0;
        cache.purgeBelow({ epoch: 200, keyPrefix: "head/" });
        cache.purgeBelow({ epoch: 100, keyPrefix: "head/" });
        await Promise.resolve();
        expect(removed).toEqual([]);
    });
});
