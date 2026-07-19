import { describe, it, expect, vi } from "vitest";
import { makeStorage } from "./browser.js";

/**
 * localforage needs IndexedDB, so the browser backend is unit-tested against an in-memory
 * stand-in: `createInstance({ name })` returns a Map-backed instance, keyed by name so the
 * two round-robin databases stay distinct (and persist across createInstance calls, like
 * IndexedDB does).
 */
const databases = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock("localforage", () => ({
    default: {
        createInstance: ({ name }: { name: string }) => {
            let store = databases.get(name);
            if (!store) {
                store = new Map();
                databases.set(name, store);
            }
            return {
                getItem: async (key: string) => (store.has(key) ? store.get(key) : null),
                setItem: async (key: string, value: unknown) => {
                    store.set(key, value);
                    return value;
                },
                removeItem: async (key: string) => {
                    store.delete(key);
                },
                keys: async () => [...store.keys()],
                clear: async () => {
                    store.clear();
                },
                length: async () => store.size
            };
        }
    }
}));

/** A fresh LRU per test (unique cacheName keeps the mocked databases isolated). */
let cacheCounter = 0;
function openLru(maxItems: number) {
    const storage = makeStorage({ dataPath: undefined });
    return storage.openLru({ cacheName: `test-${++cacheCounter}`, maxItems });
}

describe("LocalForageLruStorage (browser round-robin LRU)", () => {
    it("round-trips values, lists keys across both halves, and removes from both", async () => {
        const store = openLru(10);
        await store.setItem("a", { x: 1 });
        expect(await store.getItem("a")).toEqual({ x: 1 });
        expect(await store.getItem("missing")).toBeUndefined();
        await store.setItem("b", "two");
        expect((await store.keys()).sort()).toEqual(["a", "b"]);
        await store.removeItem("a");
        expect(await store.getItem("a")).toBeUndefined();
    });

    it("swaps at maxItems and keeps the older half readable (promote on hit)", async () => {
        const store = openLru(2);
        await store.setItem("a", 1);
        await store.setItem("b", 2); // reaches maxItems: swap — a,b are now the inactive half
        await store.setItem("c", 3);
        expect(await store.getItem("a")).toBe(1); // hit in the inactive half promotes
        expect(await store.getItem("c")).toBe(3);
    });

    it("clear() empties both halves", async () => {
        const store = openLru(2);
        await store.setItem("a", 1);
        await store.setItem("b", 2); // swap: a,b become the inactive half
        await store.setItem("c", 3);
        await store.clear();
        expect(await store.getItem("a")).toBeUndefined();
        expect(await store.getItem("c")).toBeUndefined();
        expect(await store.keys()).toEqual([]);
    });

    it("does not swap early after removeItem frees active slots (counter drift)", async () => {
        // Regression: `activeSize` was only ever incremented, so removals (the gate-result
        // expiry purge calls removeItem in bulk) left it inflated and grow() swapped before
        // the active half was actually full — a second premature swap then cleared live
        // entries. The live key count here never exceeds maxItems (3), so an honest counter
        // must retain every key; only the drifted one loses `c` to its second swap.
        const store = openLru(3);
        await store.setItem("a", 1);
        await store.setItem("b", 2);
        await store.removeItem("a");
        await store.removeItem("b"); // two removals: the drifted counter now over-counts by 2
        await store.setItem("c", 3);
        await store.setItem("d", 4);
        await store.removeItem("d");
        await store.setItem("e", 5);
        await store.setItem("f", 6);
        expect(await store.getItem("c")).toBe(3);
        expect(await store.getItem("e")).toBe(5);
        expect(await store.getItem("f")).toBe(6);
    });
});

describe("LocalForageSnapshotStorage (browser checkpoint snapshots)", () => {
    const CHECKPOINTS_DB = "pubsub-voting-checkpoints";
    const snapshots = () => makeStorage({ dataPath: undefined }).openSnapshots();

    it("round-trips snapshot bytes and removes them", async () => {
        const store = snapshots();
        const bytes = new Uint8Array([1, 2, 3, 4]);
        await store.set("topic-a", bytes);
        expect(await store.get("topic-a")).toEqual(bytes);
        await store.remove("topic-a");
        expect(await store.get("topic-a")).toBeUndefined();
    });

    it("re-wraps an ArrayBuffer coming back from an older driver, and refuses non-binary values", async () => {
        const store = snapshots();
        await store.set("seed", new Uint8Array([9])); // materialize the mocked database
        const db = databases.get(CHECKPOINTS_DB)!;
        db.set("legacy", new Uint8Array([5, 6]).buffer); // an older driver stored the raw ArrayBuffer
        db.set("garbage", "not a snapshot"); // a foreign write must read as absent, not crash decode
        expect(await store.get("legacy")).toEqual(new Uint8Array([5, 6]));
        expect(await store.get("garbage")).toBeUndefined();
    });
});

describe("makeStorage (browser backend wiring)", () => {
    it("returns the same LRU per cacheName and the same snapshot store per storage (stable handles)", () => {
        const storage = makeStorage({ dataPath: undefined });
        expect(storage.openLru({ cacheName: "same", maxItems: 5 })).toBe(storage.openLru({ cacheName: "same", maxItems: 5 }));
        expect(storage.openSnapshots()).toBe(storage.openSnapshots());
    });

    it("dataPath: false selects the in-memory backend (no IndexedDB touched), and destroy() resolves", async () => {
        const before = databases.size;
        const storage = makeStorage({ dataPath: false });
        const lru = storage.openLru({ cacheName: "mem", maxItems: 5 });
        await lru.setItem("k", 1);
        expect(await lru.getItem("k")).toBe(1);
        await storage.openSnapshots().set("t", new Uint8Array([1]));
        expect(await storage.openSnapshots().get("t")).toEqual(new Uint8Array([1]));
        expect(databases.size).toBe(before); // nothing hit the (mocked) localforage layer
        await storage.destroy();
    });

    it("destroy() drops the handles (a later open builds fresh ones)", async () => {
        const storage = makeStorage({ dataPath: undefined });
        const first = storage.openSnapshots();
        await storage.destroy();
        expect(storage.openSnapshots()).not.toBe(first);
    });
});
