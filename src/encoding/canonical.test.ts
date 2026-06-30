import { describe, it, expect } from "vitest";
import { encodeCanonical } from "./canonical.js";

describe("encodeCanonical", () => {
    it("is deterministic for identical input", () => {
        const a = encodeCanonical({ x: 1, y: "two", z: [3, 4] });
        const b = encodeCanonical({ x: 1, y: "two", z: [3, 4] });
        expect(a).toEqual(b);
    });

    it("is independent of authoring key order (dag-cbor sorts keys)", () => {
        const a = encodeCanonical({ alpha: 1, beta: 2, gamma: 3 });
        const b = encodeCanonical({ gamma: 3, alpha: 1, beta: 2 });
        expect(a).toEqual(b);
    });

    it("distinguishes different values", () => {
        const a = encodeCanonical({ contest: "biz" });
        const b = encodeCanonical({ contest: "g" });
        expect(a).not.toEqual(b);
    });

    it("rejects undefined (non-canonical)", () => {
        expect(() => encodeCanonical({ a: undefined })).toThrow();
    });
});
