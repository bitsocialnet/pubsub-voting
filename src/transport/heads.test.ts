import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import * as dagCbor from "@ipld/dag-cbor";
import { encodeHeads, decodeHeads } from "./heads.js";

async function cidOf(seed: string): Promise<CID> {
    const digest = await sha256.digest(new TextEncoder().encode(seed));
    return CID.createV1(raw.code, digest);
}

describe("heads codec", () => {
    it("round-trips head CIDs", async () => {
        const heads = [await cidOf("a"), await cidOf("b")];
        const decoded = decodeHeads(encodeHeads(heads));
        expect(decoded.map((c) => c.toString())).toEqual(heads.map((c) => c.toString()));
    });

    it("round-trips an empty head list", () => {
        expect(decodeHeads(encodeHeads([]))).toEqual([]);
    });

    it("throws on a non-array payload", () => {
        expect(() => decodeHeads(dagCbor.encode("not an array"))).toThrow();
    });

    it("throws when an element is not a CID", () => {
        expect(() => decodeHeads(dagCbor.encode([1, 2, 3]))).toThrow();
    });

    it("throws on malformed bytes", () => {
        expect(() => decodeHeads(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
    });
});
