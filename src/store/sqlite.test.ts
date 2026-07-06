import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVoteStore } from "./sqlite.js";
import type { VoteIntent } from "./types.js";

/** A valid base58btc IPNS board key — `VoteSchema` rejects non-keys on read, so intents need a real one. */
const KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

function intent(over: Partial<VoteIntent> = {}): VoteIntent {
    return { topic: "bitsocial-votes/x", address: "0xabc", votes: [{ board: { publicKey: KEY }, vote: 1 }], lastBucket: 7, ...over };
}

describe("SqliteVoteStore", () => {
    let dir: string | undefined;
    let store: SqliteVoteStore | undefined;

    afterEach(async () => {
        await store?.destroy();
        store = undefined;
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    function freshStore(): SqliteVoteStore {
        dir = mkdtempSync(join(tmpdir(), "pv-sqlite-"));
        store = new SqliteVoteStore(dir);
        return store;
    }

    it("round-trips put / get / list / delete", async () => {
        const s = freshStore();
        expect(await s.list()).toEqual([]);
        await s.put(intent());
        expect(await s.get("bitsocial-votes/x")).toEqual(intent());
        expect(await s.list()).toEqual([intent()]);
        // put replaces by topic (last write wins, mirroring the CRDT).
        await s.put(intent({ lastBucket: 9 }));
        expect((await s.get("bitsocial-votes/x"))?.lastBucket).toBe(9);
        await s.delete("bitsocial-votes/x");
        expect(await s.get("bitsocial-votes/x")).toBeUndefined();
        expect(await s.list()).toEqual([]);
    });

    it("stores an empty-votes withdrawal intent", async () => {
        const s = freshStore();
        await s.put(intent({ topic: "bitsocial-votes/w", votes: [] }));
        expect((await s.get("bitsocial-votes/w"))?.votes).toEqual([]);
    });

    it("persists across a fresh instance on the same file (survives a restart)", async () => {
        const first = freshStore();
        await first.put(intent({ topic: "bitsocial-votes/keep", lastBucket: 3 }));
        await first.destroy();
        // Reopen the same directory: the intent is still there.
        store = new SqliteVoteStore(dir!);
        const got = await store.get("bitsocial-votes/keep");
        expect(got?.lastBucket).toBe(3);
        expect(got?.votes).toEqual([{ board: { publicKey: KEY }, vote: 1 }]);
    });
});
