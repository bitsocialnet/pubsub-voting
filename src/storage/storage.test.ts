import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMemoryLruStorage } from "./memory.js";
import { makeStorage } from "./node.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 2)); // beat Date.now()'s ms granularity

describe("makeMemoryLruStorage", () => {
    it("round-trips values and lists keys", async () => {
        const store = makeMemoryLruStorage(10);
        await store.setItem("a", { x: 1 });
        expect(await store.getItem("a")).toEqual({ x: 1 });
        expect(await store.getItem("missing")).toBeUndefined();
        await store.setItem("b", "two");
        expect((await store.keys()).sort()).toEqual(["a", "b"]);
        await store.removeItem("a");
        expect(await store.getItem("a")).toBeUndefined();
    });

    it("evicts least-recently-USED past maxItems (a get refreshes recency)", async () => {
        const store = makeMemoryLruStorage(2);
        await store.setItem("a", 1);
        await store.setItem("b", 2);
        await store.getItem("a"); // refresh: b is now the least recently used
        await store.setItem("c", 3);
        expect(await store.getItem("b")).toBeUndefined();
        expect(await store.getItem("a")).toBe(1);
        expect(await store.getItem("c")).toBe(3);
    });
});

describe("makeStorage (node/sqlite)", () => {
    it("persists across close and reopen under the same dataPath", async () => {
        const dataPath = mkdtempSync(join(tmpdir(), "pubsub-votes-test-"));
        const storage = makeStorage({ dataPath });
        const store = storage.openLru({ cacheName: "gate-results", maxItems: 10 });
        await store.setItem("k", "42");
        await storage.destroy();

        const reopened = makeStorage({ dataPath });
        const reopenedStore = reopened.openLru({ cacheName: "gate-results", maxItems: 10 });
        expect(await reopenedStore.getItem("k")).toBe("42");
        expect(await reopenedStore.keys()).toEqual(["k"]);
        await reopened.destroy();
    });

    it("evicts by lastAccess past maxItems, refreshed on read (LRU, not FIFO)", async () => {
        const dataPath = mkdtempSync(join(tmpdir(), "pubsub-votes-test-"));
        const storage = makeStorage({ dataPath });
        const store = storage.openLru({ cacheName: "gate-results", maxItems: 2 });
        await store.setItem("a", 1);
        await tick();
        await store.setItem("b", 2);
        await tick();
        await store.getItem("a"); // refresh: b is now the oldest access
        await tick();
        await store.setItem("c", 3);
        expect(await store.getItem("b")).toBeUndefined();
        expect(await store.getItem("a")).toBe(1);
        expect(await store.getItem("c")).toBe(3);
        await storage.destroy();
    });

    it("keeps named caches separate and rejects use after destroy (no silent file re-create)", async () => {
        const dataPath = mkdtempSync(join(tmpdir(), "pubsub-votes-test-"));
        const storage = makeStorage({ dataPath });
        const gate = storage.openLru({ cacheName: "gate-results", maxItems: 10 });
        const names = storage.openLru({ cacheName: "name-resolutions", maxItems: 10 });
        await gate.setItem("k", "gate");
        await names.setItem("k", "name");
        expect(await gate.getItem("k")).toBe("gate");
        expect(await names.getItem("k")).toBe("name");
        await storage.destroy();
        await expect(gate.setItem("k2", "late")).rejects.toThrow("storage is closed");
    });

    it("touches no disk for `dataPath: false` (in-memory backend)", async () => {
        const dataPath = mkdtempSync(join(tmpdir(), "pubsub-votes-test-"));
        const storage = makeStorage({ dataPath: false });
        const store = storage.openLru({ cacheName: "gate-results", maxItems: 10 });
        await store.setItem("k", 1);
        expect(await store.getItem("k")).toBe(1);
        expect(existsSync(join(dataPath, "lru-storage"))).toBe(false);
        await storage.destroy();
    });
});
