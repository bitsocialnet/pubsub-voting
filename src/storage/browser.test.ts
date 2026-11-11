import { describe, it, expect, vi } from "vitest";
import { makeStorage } from "./browser.js";

/**
 * localforage needs IndexedDB, so the browser backend is unit-tested against an in-memory
 * stand-in: `createInstance({ name })` returns a Map-backed instance, keyed by name so the
 * two round-robin databases stay distinct (and persist across createInstance calls, like
 * IndexedDB does).
 */
const databases = vi.hoisted(() => new Map<string, Map<string, unknown>>());
/** Databases whose clear() never commits (the tab is closed before it lands). */
const stalledClears = vi.hoisted(() => new Set<string>());
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
                    if (stalledClears.has(name)) return new Promise<void>(() => {});
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

    it("rotates once when concurrent writes fill the active half (never clears both halves)", async () => {
        // RuleCache.memoMany persists a batch of fresh keys without awaiting each write, so
        // several grow() calls can reach the threshold together. Each used to reconcile against
        // the half it saw before its await and swap on its own: the second swap flipped the roles
        // back and cleared the half the first swap had just retired.
        const store = openLru(3);
        await store.setItem("a", 1);
        await store.setItem("b", 2);
        await Promise.all([store.setItem("c", 3), store.setItem("d", 4)]);
        expect((await store.keys()).sort()).toEqual(["a", "b", "c", "d"]);
    });

    it("keeps the half the last rotation made active across a reload, even after a purge shrank the retired one", async () => {
        // Sizes alone cannot tell the halves apart: right after a rotation the retired half sits
        // at maxItems, but the expiry purge removes keys from both halves, so on reload it can be
        // below maxItems and still the larger one. The size rule then picked it as active, and its
        // next fill swapped and cleared the NEWER half. Two rotations cover both halves.
        const cacheName = `test-${++cacheCounter}`;
        const reload = () => makeStorage({ dataPath: undefined }).openLru({ cacheName, maxItems: 3 });

        const first = reload();
        for (const [key, value] of [["a", 1], ["b", 2], ["c", 3], ["d", 4]] as const) await first.setItem(key, value);
        await first.removeItem("a"); // purge: retired {b, c} is now 2, still >= active {d}
        const second = reload();
        await second.setItem("e", 5);
        await second.setItem("f", 6); // the active half fills and rotates
        expect(await second.getItem("d")).toBe(4); // the newest entry outlived the rotation

        // The same from the other half (`d` was promoted into the half that just became active).
        await second.setItem("g", 7);
        await second.removeItem("d"); // purge: retired {e, f} is 2, still >= active {g}
        const third = reload();
        await third.setItem("h", 8);
        await third.setItem("i", 9);
        expect(await third.getItem("g")).toBe(7);
    });

    it("records the new active half only after its clear lands (an interrupted clear never wipes the newer half)", async () => {
        // The clear and the role record hit separate databases, which commit independently. A
        // record naming the new half while its clear never landed made the next load treat that
        // half (still holding the OLDEST entries, at maxItems) as active, so its next fill
        // rotated and cleared the newer half.
        const cacheName = `test-${++cacheCounter}`;
        const reload = () => makeStorage({ dataPath: undefined }).openLru({ cacheName, maxItems: 2 });

        const first = reload();
        await first.setItem("a", 1);
        await first.setItem("b", 2); // rotates: {a, b} retired, the second half is active
        await first.setItem("c", 3);
        stalledClears.add(`pubsub-voting-${cacheName}`);
        void first.setItem("d", 4); // fills {c, d} and rotates back, but the clear of {a, b} never lands
        await new Promise((resolve) => setTimeout(resolve, 0));
        stalledClears.clear();

        const second = reload(); // the tab is reopened
        await second.setItem("e", 5); // the active half is full: this rotates
        expect(await second.getItem("d")).toBe(4); // the newest entries outlived the rotation
        expect(await second.getItem("c")).toBe(3);
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
