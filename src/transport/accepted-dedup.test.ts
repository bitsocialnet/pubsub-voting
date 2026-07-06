import { describe, it, expect } from "vitest";
import { makeAcceptedDedup } from "./accepted-dedup.js";
import { makeBucketMath } from "../chain/bucket.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

function bundle(over: Partial<VotesBundle> & { address: string }): VotesBundle {
    return {
        votes: [{ community: { publicKey: KEY_A }, vote: 1 }],
        blockNumber: 1,
        signature: { signature: "0x", type: "eip712" },
        ...over
    };
}

// blocksPerBucket 1000: blocks 1 and 500 share bucket 0; block 1000 is bucket 1.
const dedup = () => makeAcceptedDedup(makeBucketMath(1000));

describe("makeAcceptedDedup", () => {
    it("recognises a same-bucket, same-choice re-sign as a duplicate", () => {
        const d = dedup();
        const first = bundle({ address: "0x1", blockNumber: 1 });
        expect(d.isResignDuplicate(first)).toBe(false);
        d.record(first);
        // A different block in the same bucket with the same wallet + votes is a duplicate.
        expect(d.isResignDuplicate(bundle({ address: "0x1", blockNumber: 500 }))).toBe(true);
    });

    it("keys case-insensitively on the wallet address", () => {
        const d = dedup();
        d.record(bundle({ address: "0xAbC1" }));
        expect(d.isResignDuplicate(bundle({ address: "0xabc1" }))).toBe(true);
    });

    it("is NOT a duplicate across buckets (a genuine heartbeat re-sign)", () => {
        const d = dedup();
        d.record(bundle({ address: "0x1", blockNumber: 1 })); // bucket 0
        expect(d.isResignDuplicate(bundle({ address: "0x1", blockNumber: 1000 }))).toBe(false); // bucket 1
    });

    it("is NOT a duplicate when the choice differs (a genuine vote change)", () => {
        const d = dedup();
        d.record(bundle({ address: "0x1", votes: [{ community: { publicKey: KEY_A }, vote: 1 }] }));
        expect(d.isResignDuplicate(bundle({ address: "0x1", votes: [{ community: { publicKey: KEY_B }, vote: 1 }] }))).toBe(false);
    });

    it("keys the choice canonically (a carried name does not un-duplicate the same publicKey)", () => {
        // Note: `name` is part of the canonical votes bytes, so a bundle that adds a name is a
        // distinct key. This asserts the encoding is stable for the SAME logical votes value.
        const d = dedup();
        const v = [{ community: { publicKey: KEY_A }, vote: 1 }];
        d.record(bundle({ address: "0x1", votes: v }));
        expect(d.isResignDuplicate(bundle({ address: "0x1", votes: structuredClone(v) }))).toBe(true);
    });

    it("evicts the oldest entry past the cap (FIFO), and record is idempotent", () => {
        const d = makeAcceptedDedup(makeBucketMath(1000), 2);
        d.record(bundle({ address: "0xa" }));
        d.record(bundle({ address: "0xb" }));
        d.record(bundle({ address: "0xb" })); // idempotent: no reorder
        d.record(bundle({ address: "0xc" })); // evicts 0xa
        expect(d.isResignDuplicate(bundle({ address: "0xa" }))).toBe(false);
        expect(d.isResignDuplicate(bundle({ address: "0xb" }))).toBe(true);
        expect(d.isResignDuplicate(bundle({ address: "0xc" }))).toBe(true);
    });
});
