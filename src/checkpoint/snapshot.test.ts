import { describe, it, expect } from "vitest";
import { encodeCanonical } from "../encoding/canonical.js";
import { decodeSnapshot, encodeSnapshot, SNAPSHOT_VERSION } from "./snapshot.js";

describe("checkpoint snapshot container", () => {
    it("round-trips record bytes and block bytes", () => {
        const record = new Uint8Array([1, 2, 3]);
        const blocks = [new Uint8Array([4, 5]), new Uint8Array(0), new Uint8Array([6])];
        const decoded = decodeSnapshot(encodeSnapshot({ record, blocks }));
        expect(decoded.record).toEqual(record);
        expect(decoded.blocks).toEqual(blocks);
    });

    it("throws on garbage bytes (a corrupt blob must be discarded, not trusted)", () => {
        expect(() => decodeSnapshot(new Uint8Array([1, 2, 3]))).toThrow();
    });

    it("throws on a version mismatch (no migration: an old blob is discarded at load)", () => {
        const blob = encodeCanonical({ v: SNAPSHOT_VERSION + 1, record: new Uint8Array([1]), blocks: [] });
        expect(() => decodeSnapshot(blob)).toThrow(/version/);
    });

    it("throws on a shape mismatch (record or blocks not bytes)", () => {
        expect(() => decodeSnapshot(encodeCanonical({ v: SNAPSHOT_VERSION, record: "nope", blocks: [] }))).toThrow();
        expect(() => decodeSnapshot(encodeCanonical({ v: SNAPSHOT_VERSION, record: new Uint8Array([1]), blocks: [7] }))).toThrow();
    });
});
