import { describe, it, expect } from "vitest";
import { BoardSchema, VoteSchema, VotesBundleSchema } from "./votes.js";

// Two real, decodable base58btc IPNS keys (12D3KooW…), the identity form pkc-js's `isIpns` accepts.
const KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

describe("BoardSchema", () => {
    it("accepts a B58 IPNS publicKey with no name", () => {
        expect(BoardSchema.parse({ publicKey: KEY })).toEqual({ publicKey: KEY });
    });

    it("accepts an optional name when it is a resolvable domain with a TLD", () => {
        expect(BoardSchema.parse({ name: "memes.bso", publicKey: KEY })).toEqual({
            name: "memes.bso",
            publicKey: KEY
        });
        // The TLD is not pinned to .bso — a future naming system may add others.
        expect(BoardSchema.safeParse({ name: "business.eth", publicKey: KEY }).success).toBe(true);
    });

    it("rejects a name without a TLD — names must be resolvable domains, not free labels", () => {
        expect(BoardSchema.safeParse({ name: "memes", publicKey: KEY }).success).toBe(false);
        expect(BoardSchema.safeParse({ name: "memes.", publicKey: KEY }).success).toBe(false);
        expect(BoardSchema.safeParse({ name: ".bso", publicKey: KEY }).success).toBe(false);
        expect(BoardSchema.safeParse({ name: "me mes.bso", publicKey: KEY }).success).toBe(false);
    });

    it("rejects a domain in the publicKey slot — identity must be the B58 key, not a re-pointable domain", () => {
        expect(BoardSchema.safeParse({ publicKey: "business.eth" }).success).toBe(false);
    });

    it("rejects a non-decodable publicKey", () => {
        expect(BoardSchema.safeParse({ publicKey: "not-a-key" }).success).toBe(false);
        expect(BoardSchema.safeParse({ publicKey: "" }).success).toBe(false);
    });

    it("rejects a bare EVM address in the publicKey slot", () => {
        expect(BoardSchema.safeParse({ publicKey: "0x000000000000000000000000000000000000b0a4" }).success).toBe(false);
    });

    it("gates VoteSchema through the same board validation", () => {
        expect(VoteSchema.safeParse({ board: { publicKey: "business.eth" }, vote: 1 }).success).toBe(false);
        expect(VoteSchema.parse({ board: { publicKey: KEY }, vote: 1 })).toEqual({ board: { publicKey: KEY }, vote: 1 });
    });
});

describe("VotesBundleSchema pairwise-distinct boards", () => {
    const bundle = (votes: Array<{ board: { name?: string; publicKey: string }; vote: number }>) => ({
        address: "0x0000000000000000000000000000000000000001",
        votes,
        blockNumber: 43200,
        signature: { signature: "0xsig", type: "eip712" }
    });

    it("accepts distinct boards (and the empty withdrawal bundle)", () => {
        expect(
            VotesBundleSchema.safeParse(
                bundle([
                    { board: { publicKey: KEY }, vote: 1 },
                    { board: { publicKey: KEY_B }, vote: 1 }
                ])
            ).success
        ).toBe(true);
        expect(VotesBundleSchema.safeParse(bundle([])).success).toBe(true);
    });

    it("rejects the same board.publicKey twice — a wallet cannot stack its approval cap on one board", () => {
        expect(
            VotesBundleSchema.safeParse(
                bundle([
                    { board: { publicKey: KEY }, vote: 1 },
                    { board: { publicKey: KEY }, vote: 1 }
                ])
            ).success
        ).toBe(false);
    });

    it("rejects duplicates even when the name differs — identity is publicKey, so a name cannot split a board apart", () => {
        // Named vs unnamed…
        expect(
            VotesBundleSchema.safeParse(
                bundle([
                    { board: { name: "memes.bso", publicKey: KEY }, vote: 1 },
                    { board: { publicKey: KEY }, vote: 1 }
                ])
            ).success
        ).toBe(false);
        // …and two different names on the same key (legal in the registry — one community
        // may hold several names — but still one board, so still a duplicate here).
        expect(
            VotesBundleSchema.safeParse(
                bundle([
                    { board: { name: "memes.bso", publicKey: KEY }, vote: 1 },
                    { board: { name: "funny.bso", publicKey: KEY }, vote: 1 }
                ])
            ).success
        ).toBe(false);
    });

    it("allows the same name on distinct keys at the wire layer — which pair is real is decided by name resolution at tally time", () => {
        expect(
            VotesBundleSchema.safeParse(
                bundle([
                    { board: { name: "memes.bso", publicKey: KEY }, vote: 1 },
                    { board: { name: "memes.bso", publicKey: KEY_B }, vote: 1 }
                ])
            ).success
        ).toBe(true);
    });
});
