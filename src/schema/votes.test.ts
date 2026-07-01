import { describe, it, expect } from "vitest";
import { BoardSchema, VoteSchema } from "./votes.js";

// A real, decodable base58btc IPNS key (12D3KooW…), the identity form pkc-js's `isIpns` accepts.
const KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

describe("BoardSchema", () => {
    it("accepts a B58 IPNS publicKey with no name", () => {
        expect(BoardSchema.parse({ publicKey: KEY })).toEqual({ publicKey: KEY });
    });

    it("accepts an optional name, including a resolvable domain (dots are fine in a name)", () => {
        expect(BoardSchema.parse({ name: "business.eth", publicKey: KEY })).toEqual({
            name: "business.eth",
            publicKey: KEY
        });
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
