import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { IndexedDbVoteStore } from "./indexeddb.js";
import { selectVoteStore } from "./select.js";
import type { VoteIntent } from "./types.js";

/** A valid base58btc IPNS community key — `VoteSchema` rejects non-keys on read. */
const KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

function intent(over: Partial<VoteIntent> = {}): VoteIntent {
    return { topic: "bitsocial-votes/x", address: "0xabc", votes: [{ community: { publicKey: KEY }, vote: 1 }], lastBucket: 7, ...over };
}

describe("IndexedDbVoteStore", () => {
    it("round-trips put / get / list / delete", async () => {
        const store = new IndexedDbVoteStore();
        const i = intent({ topic: "bitsocial-votes/idb-a" });
        expect(await store.get("bitsocial-votes/idb-a")).toBeUndefined();
        await store.put(i);
        expect(await store.get("bitsocial-votes/idb-a")).toEqual(i);
        expect(await store.list()).toContainEqual(i);
        // put replaces by topic.
        await store.put(intent({ topic: "bitsocial-votes/idb-a", lastBucket: 99 }));
        expect((await store.get("bitsocial-votes/idb-a"))?.lastBucket).toBe(99);
        await store.delete("bitsocial-votes/idb-a");
        expect(await store.get("bitsocial-votes/idb-a")).toBeUndefined();
        await store.destroy();
    });

    it("persists across a fresh instance (survives a page reload)", async () => {
        const first = new IndexedDbVoteStore();
        await first.put(intent({ topic: "bitsocial-votes/idb-keep", lastBucket: 5 }));
        await first.destroy();
        // Reopen: fake-indexeddb keeps the record like a real browser would.
        const second = new IndexedDbVoteStore();
        expect((await second.get("bitsocial-votes/idb-keep"))?.lastBucket).toBe(5);
        await second.destroy();
    });

    it("selectVoteStore picks IndexedDB when a global indexedDB is present", async () => {
        const store = selectVoteStore(undefined); // browser env ⇒ IndexedDB, not the memory store
        await store.put(intent({ topic: "bitsocial-votes/idb-select" }));
        // Reading it back through a direct backend proves selection wrote to IndexedDB.
        const direct = new IndexedDbVoteStore();
        expect((await direct.get("bitsocial-votes/idb-select"))?.address).toBe("0xabc");
        await direct.destroy();
        await store.destroy?.();
    });
});
