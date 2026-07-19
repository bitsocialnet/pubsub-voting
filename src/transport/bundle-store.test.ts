import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { makeBlockstoreBundleStore } from "./bundle-store.js";
import { bundleCid, encodeBundle } from "../crdt/codec.js";
import type { VotesBundle } from "../schema/votes.js";
import type { BlockstoreLike } from "./types.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

const BUNDLE: VotesBundle = {
    address: "0x1111111111111111111111111111111111111111",
    votes: [{ community: { publicKey: KEY_A }, vote: 1 }],
    blockNumber: 43200,
    signature: { signature: `0x${"11".repeat(65)}`, type: "eip712" }
};

/** An in-memory raw blockstore over the real codec bytes. */
function memoryBlockstore(): BlockstoreLike & { blocks: Map<string, Uint8Array> } {
    const blocks = new Map<string, Uint8Array>();
    return {
        blocks,
        get: async (cid) => {
            const bytes = blocks.get(cid.toString());
            if (bytes === undefined) throw new Error("not found"); // as a failed bitswap want surfaces
            return bytes;
        },
        put: async (cid, bytes) => {
            blocks.set(cid.toString(), bytes);
            return cid;
        },
        has: async (cid) => blocks.has(cid.toString())
    };
}

describe("makeBlockstoreBundleStore", () => {
    it("put stores the bundle's canonical block under its own CID and get round-trips it", async () => {
        const raw = memoryBlockstore();
        const store = makeBlockstoreBundleStore(raw);
        const cid = await store.put(BUNDLE);
        expect(cid.toString()).toBe((await bundleCid(BUNDLE)).toString());
        expect(raw.blocks.get(cid.toString())).toEqual(encodeBundle(BUNDLE));
        expect(await store.get(cid)).toEqual(BUNDLE);
        expect(await store.has(cid)).toBe(true);
    });

    it("get surfaces an unfetchable block as undefined, never a throw (the gate reads it as ignore)", async () => {
        const store = makeBlockstoreBundleStore(memoryBlockstore());
        const missing = await bundleCid(BUNDLE); // never put — the blockstore get throws
        await expect(store.get(missing)).resolves.toBeUndefined();
    });

    it("get surfaces undecodable block bytes as undefined (a corrupt block is not a crash)", async () => {
        const raw = memoryBlockstore();
        const store = makeBlockstoreBundleStore(raw);
        const cid = await bundleCid(BUNDLE);
        raw.blocks.set(cid.toString(), new Uint8Array([0xff, 0x00, 0x01])); // garbage, decodeBundle throws
        await expect(store.get(cid)).resolves.toBeUndefined();
    });

    it("has maps a throwing blockstore to false rather than propagating", async () => {
        const store = makeBlockstoreBundleStore({
            get: async () => new Uint8Array(),
            put: async (cid: CID) => cid,
            has: async () => {
                throw new Error("store offline");
            }
        });
        await expect(store.has(await bundleCid(BUNDLE))).resolves.toBe(false);
    });
});
