import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import stripJsonComments from "strip-json-comments";
import { deriveDirectoryCriteria, DirectoryManifestSchema } from "./directory.js";
import { DuplicateContestIdError } from "../errors.js";
import { encodeCriteria } from "../encoding/canonical.js";
import { topicFor } from "../topic.js";
import { bizCriteria } from "../test-fixtures.js";

/** A minimal valid manifest: the shared fixture's fields as defaults, entries add contestId/name. */
function manifest(contests: Record<string, unknown>[]): unknown {
    const { name: _name, contestId: _contestId, ...defaults } = bizCriteria();
    return { defaults, contests };
}

describe("deriveDirectoryCriteria", () => {
    it("derives { ...defaults, ...entry } and validates each document", () => {
        const [a, b] = deriveDirectoryCriteria(
            manifest([
                { contestId: "a", name: "/a/ - Anime" },
                { contestId: "b", name: "/b/ - Random" }
            ])
        );
        expect(a).toEqual({ ...bizCriteria(), contestId: "a", name: "/a/ - Anime" });
        expect(b.contestId).toBe("b");
    });

    it("replaces a whole top-level field on override — shallow merge, no deep merge", () => {
        const [criteria] = deriveDirectoryCriteria(
            manifest([
                {
                    contestId: "q",
                    name: "/q/ - Feedback",
                    // A rule override must be COMPLETE: nothing of defaults.rule survives.
                    rule: { type: "erc721-min-balance", chain: "eth", contract: `0x${"ab".repeat(20)}`, min: 2 }
                }
            ])
        );
        expect(criteria.rule).toEqual({ type: "erc721-min-balance", chain: "eth", contract: `0x${"ab".repeat(20)}`, min: 2 });
        // Untouched fields still inherit.
        expect(criteria.weight).toEqual(bizCriteria().weight);
    });

    it("works without defaults when entries are self-contained documents", () => {
        const [criteria] = deriveDirectoryCriteria({ contests: [bizCriteria()] });
        expect(criteria).toEqual(bizCriteria());
    });

    it("rejects a derived document that fails CriteriaSchema", () => {
        // The entry drops `rule` from a manifest whose defaults never had one.
        const { rule: _rule, ...defaultsWithoutRule } = bizCriteria();
        expect(() =>
            deriveDirectoryCriteria({ defaults: defaultsWithoutRule, contests: [{ contestId: "x" }] })
        ).toThrow();
    });

    it("rejects a duplicate contestId — one slot must be one topic", () => {
        expect(() =>
            deriveDirectoryCriteria(manifest([{ contestId: "a", name: "/a/ - A" }, { contestId: "a", name: "/a/ - Again" }]))
        ).toThrow(DuplicateContestIdError);
    });

    it("rejects a manifest without contests", () => {
        expect(() => deriveDirectoryCriteria({ defaults: {} })).toThrow();
        expect(() => deriveDirectoryCriteria({ contests: [] })).toThrow();
        expect(DirectoryManifestSchema.safeParse({ contests: [] }).success).toBe(false);
    });

    it("derives deterministically — same manifest, byte-identical documents (same topics)", () => {
        const source = manifest([{ contestId: "a", name: "/a/ - Anime" }]);
        const [first] = deriveDirectoryCriteria(source);
        const [second] = deriveDirectoryCriteria(source);
        expect(encodeCriteria(second)).toEqual(encodeCriteria(first));
    });
});

describe("deriveDirectoryCriteria on the real 5chan manifest", () => {
    const source = JSON.parse(
        stripJsonComments(readFileSync(new URL("../../5chan-directory-criteria.jsonc", import.meta.url), "utf8"))
    ) as { contests: unknown[] };

    it("derives every slot: one valid document per entry, all contestIds distinct", async () => {
        const allCriteria = deriveDirectoryCriteria(source);
        expect(allCriteria).toHaveLength(source.contests.length);
        expect(new Set(allCriteria.map((c) => c.contestId)).size).toBe(allCriteria.length);
        // Every document is standalone (defaults flattened away) and derives a distinct topic.
        const topics = await Promise.all(allCriteria.map((c) => topicFor(c)));
        expect(new Set(topics).size).toBe(allCriteria.length);
    });

    it("inherits the shared 5chan Pass gate, except the illustrative /q/ override", () => {
        const allCriteria = deriveDirectoryCriteria(source);
        const q = allCriteria.find((c) => c.contestId === "q");
        expect(q?.rule.min).toBe(2);
        for (const criteria of allCriteria) {
            if (criteria.contestId === "q") continue;
            expect(criteria.rule).toEqual(allCriteria[0]!.rule);
        }
    });
});
