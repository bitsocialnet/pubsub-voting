import { describe, it, expect } from "vitest";
import { topicFor, criteriaCid, TOPIC_PREFIX } from "./topic.js";
import type { Criteria } from "./schema/criteria.js";
import { bizCriteria } from "./test-fixtures.js";

describe("topicFor", () => {
    it("is namespaced and a valid CIDv1 dag-cbor", async () => {
        const topic = await topicFor(bizCriteria());
        expect(topic.startsWith(TOPIC_PREFIX)).toBe(true);
        const cid = await criteriaCid(bizCriteria());
        expect(cid.version).toBe(1);
        expect(cid.code).toBe(0x71); // dag-cbor
        expect(topic).toBe(TOPIC_PREFIX + cid.toString());
    });

    it("is deterministic", async () => {
        expect(await topicFor(bizCriteria())).toBe(await topicFor(bizCriteria()));
    });

    it("does not fork on reordered keys (dag-cbor sorts)", async () => {
        const base = bizCriteria();
        // Rebuild with top-level keys inserted in a different order.
        const reordered: Criteria = {
            requires: base.requires,
            weight: base.weight,
            eligibility: base.eligibility,
            voteExpiryBuckets: base.voteExpiryBuckets,
            blocksPerBucket: base.blocksPerBucket,
            maxVotesPerAddress: base.maxVotesPerAddress,
            voteSchema: base.voteSchema,
            contest: base.contest,
            name: base.name
        };
        expect(await topicFor(reordered)).toBe(await topicFor(base));
    });

    it("forks when a consensus field changes", async () => {
        const a = bizCriteria();
        const b: Criteria = { ...bizCriteria(), contest: "g" };
        expect(await topicFor(a)).not.toBe(await topicFor(b));
    });

    it("forks when the gate changes (e.g. /q/ raises min to 2)", async () => {
        const a = bizCriteria();
        const b: Criteria = {
            ...bizCriteria(),
            eligibility: { ...bizCriteria().eligibility, min: 2 }
        };
        expect(await topicFor(a)).not.toBe(await topicFor(b));
    });
});
