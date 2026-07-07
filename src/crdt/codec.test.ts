import { describe, it, expect } from "vitest";
import * as dagCbor from "@ipld/dag-cbor";
import { encodeBundle, decodeBundle, bundleCid, toWireBundle } from "./codec.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const SIG_65 = `0x${"11".repeat(65)}`;

/** A fixed, schema-valid bundle — the frozen-vector input. */
const VECTOR: VotesBundle = {
    address: "0x1111111111111111111111111111111111111111",
    votes: [{ community: { name: "memes.bso", publicKey: KEY_A }, vote: 1 }],
    blockNumber: 43200,
    signature: { signature: SIG_65, type: "eip712" }
};

describe("bundle codec (binary block layout)", () => {
    // Cross-client spec: an independent implementation must reproduce this CID byte-for-byte.
    // Any layout change (field set, binary mapping, canonical encoding) is a breaking wire
    // change that re-freezes this vector AND the checkpoint vector (which inlines these bytes).
    it("pins the bundle CID for a known bundle (fixed vector)", async () => {
        const cid = await bundleCid(VECTOR);
        expect(cid.toString()).toBe("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4");
    });

    it("carries crypto material as raw bytes (~30% smaller than the string form)", () => {
        const binary = encodeBundle(VECTOR).length; // 235 B vs 339 B string-form at pin time
        const strings = dagCbor.encode(VECTOR).length;
        expect(binary).toBeLessThan(strings * 0.75);
        const wire = toWireBundle(VECTOR);
        expect(wire.address.length).toBe(20);
        expect(wire.signature.signature.length).toBe(65);
        expect(wire.votes[0].community.publicKey).toBeInstanceOf(Uint8Array);
    });

    it("round-trips, including an omitted name", () => {
        expect(decodeBundle(encodeBundle(VECTOR))).toEqual(VECTOR);
        const nameless: VotesBundle = {
            ...VECTOR,
            votes: [{ community: { publicKey: KEY_A }, vote: 1 }]
        };
        const decoded = decodeBundle(encodeBundle(nameless));
        expect(decoded).toEqual(nameless);
        expect("name" in decoded.votes[0].community).toBe(false);
    });

    it("normalizes a checksummed address to lowercase (casing is presentation, not identity)", () => {
        const checksummed: VotesBundle = { ...VECTOR, address: "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x") };
        const a = decodeBundle(encodeBundle(checksummed));
        const b = decodeBundle(encodeBundle(VECTOR));
        expect(a).toEqual(b); // same bytes, same identity — signature checks compare case-insensitively
    });

    it("rejects a signature that is not exactly 65 bytes", () => {
        const bad: VotesBundle = { ...VECTOR, signature: { signature: "0x1122", type: "eip712" } };
        expect(() => encodeBundle(bad)).toThrow(/65 bytes/);
    });

    it("rejects an address that is not exactly 20 bytes", () => {
        const bad: VotesBundle = { ...VECTOR, address: "0x1111" };
        expect(() => encodeBundle(bad)).toThrow(/20 bytes/);
    });

    it("rejects a name over the 253-byte DNS bound at the schema", () => {
        const bad: VotesBundle = {
            ...VECTOR,
            votes: [{ community: { name: `${"a".repeat(252)}.bso`, publicKey: KEY_A }, vote: 1 }]
        };
        expect(() => encodeBundle(bad)).toThrow();
    });

    it("rejects malformed block bytes on decode", () => {
        expect(() => decodeBundle(dagCbor.encode({ nonsense: true }))).toThrow();
        // publicKey bytes that do not decode to a multihash fail the schema's B58 IPNS check
        const wire = toWireBundle(VECTOR);
        wire.votes[0].community.publicKey = new Uint8Array([1, 2, 3]);
        expect(() => decodeBundle(dagCbor.encode(wire))).toThrow();
    });
});
