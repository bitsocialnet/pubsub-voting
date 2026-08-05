import { describe, it, expect } from "vitest";
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
                    // The chain stays "base": `requires.chains` is inherited from the defaults,
                    // and a rule naming a chain that is not in it derives a document no client
                    // could create (Contest resolves its gating chain client out of
                    // `requires.chains` and throws when the ticker is missing).
                    rule: { type: "erc5192-min-balance", chain: "base", contract: `0x${"ab".repeat(20)}`, min: 2 }
                }
            ])
        );
        expect(criteria.rule).toEqual({ type: "erc5192-min-balance", chain: "base", contract: `0x${"ab".repeat(20)}`, min: 2 });
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

// Directory-scale derivation. This used to read the 5chan manifest that shipped in this
// repo; that file now lives in bitsocialnet/lists, where the clients and seeders actually
// fetch it, so the case is covered with a synthetic directory of the same shape instead of
// a network read. The properties are what matter: one valid standalone document per slot,
// one topic per slot, and per-contest overrides that leave every sibling untouched.
describe("deriveDirectoryCriteria over a whole directory", () => {
    const SLOT_COUNT = 63;
    const OVERRIDDEN_SLOT = "q";
    const slots = Array.from({ length: SLOT_COUNT - 1 }, (_unused, i) => ({
        contestId: `slot-${i}`,
        name: `/slot-${i}/ - Directory ${i}`
    }));
    // One slot gates harder than its siblings, proving the gate is per-contest, not global.
    // Same chain as the inherited `requires.chains` — only the contract and threshold differ.
    const strictGate = { type: "erc5192-min-balance", chain: "base", contract: `0x${"ab".repeat(20)}`, min: 2 };
    const source = manifest([
        ...slots,
        { contestId: OVERRIDDEN_SLOT, name: "/q/ - Feedback", rule: strictGate }
    ]) as { contests: unknown[] };

    it("derives every slot: one valid document per entry, all contestIds distinct", async () => {
        const allCriteria = deriveDirectoryCriteria(source);
        expect(allCriteria).toHaveLength(source.contests.length);
        expect(new Set(allCriteria.map((c) => c.contestId)).size).toBe(allCriteria.length);
        // Every document is standalone (defaults flattened away) and derives a distinct topic.
        const topics = await Promise.all(allCriteria.map((c) => topicFor(c)));
        expect(new Set(topics).size).toBe(allCriteria.length);
    });

    it("inherits the shared gate, except the one slot that overrides it", () => {
        const allCriteria = deriveDirectoryCriteria(source);
        const overridden = allCriteria.find((c) => c.contestId === OVERRIDDEN_SLOT);
        expect(overridden?.rule).toEqual(strictGate);
        for (const criteria of allCriteria) {
            if (criteria.contestId === OVERRIDDEN_SLOT) continue;
            expect(criteria.rule).toEqual(bizCriteria().rule);
        }
    });
});
