import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectVoteStore } from "./select.js";
import { MemoryVoteStore } from "./memory.js";

// No `fake-indexeddb` here: this file runs in the plain Node env (no global `indexedDB`),
// so it exercises the Node branches — memory without a dataPath, lazy SQLite with one.
describe("selectVoteStore (Node)", () => {
    let dir: string | undefined;

    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it("uses the in-memory store when there is no dataPath (and no indexedDB)", () => {
        expect(selectVoteStore(undefined)).toBeInstanceOf(MemoryVoteStore);
    });

    it("lazily loads the SQLite backend for a dataPath and round-trips through it", async () => {
        dir = mkdtempSync(join(tmpdir(), "pv-select-"));
        const store = selectVoteStore(dir);
        expect(store).not.toBeInstanceOf(MemoryVoteStore); // the lazy durable wrapper
        await store.put({ topic: "bitsocial-votes/s", address: "0xabc", votes: [], lastBucket: 2 });
        expect((await store.get("bitsocial-votes/s"))?.lastBucket).toBe(2);
        await store.destroy?.();
    });
});
