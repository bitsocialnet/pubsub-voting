import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import stripJsonComments from "strip-json-comments";
import { deriveCriteria, mergeCriteria, DirectoryManifestSchema } from "./manifest.js";
import { topicFor } from "../topic.js";

/** The real 5chan example manifest (illustration JSONC file at the repo root). */
function fiveChanManifest(): unknown {
    return JSON.parse(stripJsonComments(readFileSync(new URL("../../5chan-directory-criteria.jsonc", import.meta.url), "utf8")));
}

const defaults = {
    voteSchema: { min: 1, max: 1 },
    maxVotesPerAddress: 1,
    blocksPerBucket: 43200,
    voteExpiryBuckets: 30,
    rule: { type: "erc721-min-balance", chain: "base", contract: "0xabc", min: 1 },
    weight: { type: "constant", value: 1 },
    requires: {
        rules: ["erc721-min-balance", "constant"],
        chains: { base: { chainId: 8453, rpcUrls: ["https://mainnet.base.org"] } }
    }
};

describe("mergeCriteria", () => {
    it("flattens defaults and entry into one valid criteria document", () => {
        const c = mergeCriteria(defaults, { contest: "biz", name: "/biz/" });
        expect(c.contest).toBe("biz");
        expect(c.name).toBe("/biz/");
        expect(c.maxVotesPerAddress).toBe(1);
    });

    it("lets an entry override a whole top-level field (no deep merge)", () => {
        const c = mergeCriteria(defaults, {
            contest: "q",
            name: "/q/",
            rule: { type: "erc721-min-balance", chain: "base", contract: "0xabc", min: 2 }
        });
        expect(c.rule).toEqual({ type: "erc721-min-balance", chain: "base", contract: "0xabc", min: 2 });
    });

    it("rejects a merged document that is not valid criteria", () => {
        expect(() => mergeCriteria({}, { contest: "x", name: "/x/" })).toThrow();
    });
});

describe("DirectoryManifestSchema", () => {
    it("requires a non-empty contests list", () => {
        expect(() => DirectoryManifestSchema.parse({ name: "m", defaults: {}, contests: [] })).toThrow();
    });
});

describe("deriveCriteria on the real 5chan manifest", () => {
    it("derives one valid criteria per directory slot", () => {
        const criteria = deriveCriteria(fiveChanManifest());
        expect(criteria.length).toBe(63);
        expect(criteria.every((c) => c.contest.length > 0)).toBe(true);
        const q = criteria.find((c) => c.contest === "q");
        expect(q?.rule).toMatchObject({ min: 2 });
    });

    it("gives every slot a distinct topic", async () => {
        const criteria = deriveCriteria(fiveChanManifest());
        const topics = await Promise.all(criteria.map((c) => topicFor(c)));
        expect(new Set(topics).size).toBe(criteria.length);
    });
});
