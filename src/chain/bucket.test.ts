import { describe, it, expect } from "vitest";
import { makeBucketMath } from "./bucket.js";

describe("makeBucketMath", () => {
    const bm = makeBucketMath(43200); // one day of Base blocks, the 5chan example bucket

    it("floors a block to its bucket", () => {
        expect(bm.bucketForBlock(0)).toBe(0);
        expect(bm.bucketForBlock(43199)).toBe(0);
        expect(bm.bucketForBlock(43200)).toBe(1);
        expect(bm.bucketForBlock(43200 * 2 + 5)).toBe(2);
    });

    it("maps a bucket to its boundary sample block", () => {
        expect(bm.sampleBlockForBucket(0)).toBe(0);
        expect(bm.sampleBlockForBucket(1)).toBe(43200);
        expect(bm.sampleBlockForBucket(2)).toBe(86400);
    });

    it("round-trips: the sample block lands back in the same bucket", () => {
        for (const bucket of [0, 1, 5, 100]) {
            expect(bm.bucketForBlock(bm.sampleBlockForBucket(bucket))).toBe(bucket);
        }
    });

    it("rejects a non-positive or non-integer bucket size", () => {
        expect(() => makeBucketMath(0)).toThrow();
        expect(() => makeBucketMath(-1)).toThrow();
        expect(() => makeBucketMath(1.5)).toThrow();
    });
});
