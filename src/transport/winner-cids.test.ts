import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import * as dagCbor from "@ipld/dag-cbor";
import { encodeWinnerCids, decodeWinnerCids } from "./winner-cids.js";

async function cidOf(seed: string): Promise<CID> {
    const digest = await sha256.digest(new TextEncoder().encode(seed));
    return CID.createV1(raw.code, digest);
}

describe("winner-CID codec", () => {
    it("round-trips winner CIDs", async () => {
        const cids = [await cidOf("a"), await cidOf("b")];
        const decoded = decodeWinnerCids(encodeWinnerCids(cids));
        expect(decoded.map((c) => c.toString())).toEqual(cids.map((c) => c.toString()));
    });

    it("round-trips an empty CID list", () => {
        expect(decodeWinnerCids(encodeWinnerCids([]))).toEqual([]);
    });

    it("throws on a non-array payload", () => {
        expect(() => decodeWinnerCids(dagCbor.encode("not an array"))).toThrow();
    });

    it("throws when an element is not a CID", () => {
        expect(() => decodeWinnerCids(dagCbor.encode([1, 2, 3]))).toThrow();
    });

    it("throws on malformed bytes", () => {
        expect(() => decodeWinnerCids(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
    });
});
