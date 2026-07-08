import { describe, it, expect } from "vitest";
import type { CID } from "multiformats/cid";
import { encodeCheckpoint, decodeCheckpoint } from "./codec.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";
// The binary codec requires a well-formed 65-byte signature (validity is checked elsewhere).
const sig = { signature: `0x${"11".repeat(65)}`, type: "eip712" } as const;

// Deliberately NOT in address order — the codec must sort.
const WINNERS: VotesBundle[] = [
    { address: "0x0000000000000000000000000000000000000002", votes: [{ community: { publicKey: KEY_B }, vote: 1 }], blockNumber: 20, signature: sig },
    { address: "0x0000000000000000000000000000000000000001", votes: [{ community: { publicKey: KEY_A }, vote: 1 }], blockNumber: 10, signature: sig }
];

const storeOf = (blocks: { cid: CID; bytes: Uint8Array }[]) => {
    const m = new Map(blocks.map((b) => [b.cid.toString(), b.bytes]));
    return async (cid: CID) => m.get(cid.toString());
};

describe("checkpoint codec", () => {
    // Cross-client spec: an independent seeder with the same winner set must reproduce these bytes,
    // so any change to the layout (codec options, sort, chunk rule) is a breaking re-freeze.
    it("pins the root CID for a known winner set (fixed vector)", async () => {
        const { root, blocks } = await encodeCheckpoint(WINNERS);
        expect(root.toString()).toBe("bafyreigz22r5ujmwkzdopj5b4yl55plabqbrq3hf3gvv4b6ekfbf2xxfd4");
        expect(blocks.length).toBe(2); // one chunk + the root manifest
    });

    it("round-trips through decode, sorted ascending by address", async () => {
        const { root, blocks } = await encodeCheckpoint(WINNERS);
        const decoded = await decodeCheckpoint(root, storeOf(blocks));
        expect(decoded.map((b) => b.address)).toEqual([
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002"
        ]);
        expect(decoded[0].votes[0].community.publicKey).toBe(KEY_A);
    });

    it("is order-independent: shuffled input yields the same root CID", async () => {
        const a = await encodeCheckpoint(WINNERS);
        const b = await encodeCheckpoint([...WINNERS].reverse());
        expect(b.root.toString()).toBe(a.root.toString());
    });

    it("splits into multiple chunks under a small size cap (fixed vector)", async () => {
        const { root, blocks } = await encodeCheckpoint(WINNERS, 1); // cap forces one bundle per chunk
        expect(root.toString()).toBe("bafyreicqqw4tj3zgvvwllr6xjnopk47cefmnulm6ge6f7wmhm6mgmpckom");
        expect(blocks.length).toBe(3); // two chunks + the root manifest
        // Chunking must not change the decoded winners.
        expect((await decodeCheckpoint(root, storeOf(blocks))).length).toBe(2);
    });

    it("encodes an empty winner set to a lone root block (fixed vector)", async () => {
        const { root, blocks } = await encodeCheckpoint([]);
        expect(root.toString()).toBe("bafyreie3lvfqun6g4c6hs7yimoklt4hpawpxc7dr6rrduneuidifcrxhum");
        expect(blocks.length).toBe(1);
        expect(await decodeCheckpoint(root, storeOf(blocks))).toEqual([]);
    });

    it("throws when a referenced block is unavailable", async () => {
        const { root } = await encodeCheckpoint(WINNERS);
        await expect(decodeCheckpoint(root, async () => undefined)).rejects.toThrow(/unavailable/);
    });

    it("skips the root-manifest fetch when handed a verified chunk index (piggyback fast-path)", async () => {
        const { root, chunks, blocks } = await encodeCheckpoint(WINNERS);
        const getBlock = storeOf(blocks);
        const fetched: string[] = [];
        const spy = async (cid: CID): Promise<Uint8Array | undefined> => {
            fetched.push(cid.toString());
            return getBlock(cid);
        };
        // The chunk index re-derives to `root`, so decode pulls the chunks directly and never
        // asks for the manifest block — one fewer round-trip.
        const decoded = await decodeCheckpoint(root, spy, chunks);
        expect(decoded.map((b) => b.address)).toEqual([
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002"
        ]);
        expect(fetched).not.toContain(root.toString());
        expect(fetched).toEqual(chunks.map((c) => c.toString()));
    });

    it("falls back to the manifest fetch when the piggybacked chunk index does not match the root", async () => {
        const { root, blocks } = await encodeCheckpoint(WINNERS);
        const getBlock = storeOf(blocks);
        const fetched: string[] = [];
        const spy = async (cid: CID): Promise<Uint8Array | undefined> => {
            fetched.push(cid.toString());
            return getBlock(cid);
        };
        // A lie (chunk index that does not re-derive to `root`) fails the local check, so decode
        // fetches the real manifest and still returns the correct winners — never a trust vector.
        const bogus = await encodeCheckpoint([WINNERS[0]!]);
        const decoded = await decodeCheckpoint(root, spy, bogus.chunks);
        expect(decoded.length).toBe(2);
        expect(fetched).toContain(root.toString());
    });
});
