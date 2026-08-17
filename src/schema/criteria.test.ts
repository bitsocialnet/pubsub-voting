import { describe, it, expect } from "vitest";
import { CriteriaSchema, MAX_GATE_DEPTH, MAX_GATE_LEAVES, type GateNode } from "./criteria.js";
import { bizCriteria, bizGateRef } from "../test-fixtures.js";
import { topicFor } from "../topic.js";

/**
 * The gate tree's SHAPE rules. Every one of them exists because the topic is the CID of these
 * bytes: a document that differs in bytes but not in meaning is a silent topic fork — two peers
 * running identical rules on two topics, neither able to see the other's votes.
 */

const withGate = (gate: unknown): unknown => ({ ...bizCriteria(), gate });
const leaf = (min: number): GateNode => ({ rule: { ...bizGateRef(), min } });

describe("CriteriaSchema gate", () => {
    it("accepts a single rule, and an all/any of two", () => {
        expect(() => CriteriaSchema.parse(withGate({ rule: bizGateRef() }))).not.toThrow();
        expect(() => CriteriaSchema.parse(withGate({ all: [leaf(1), leaf(2)] }))).not.toThrow();
        expect(() => CriteriaSchema.parse(withGate({ any: [leaf(1), leaf(2)] }))).not.toThrow();
    });

    it("rejects a bare rule ref: the leaf is wrapped, so a rule option named `all` stays unambiguous", () => {
        expect(() => CriteriaSchema.parse(withGate(bizGateRef()))).toThrow();
    });

    it("rejects a one-child branch — `{ all: [X] }` must not be a second spelling of `X`", () => {
        expect(() => CriteriaSchema.parse(withGate({ all: [leaf(1)] }))).toThrow();
        expect(() => CriteriaSchema.parse(withGate({ any: [leaf(1)] }))).toThrow();
        expect(() => CriteriaSchema.parse(withGate({ all: [] }))).toThrow();
    });

    it("rejects a node mixing `all` and `any`, or carrying an unknown key", () => {
        expect(() => CriteriaSchema.parse(withGate({ all: [leaf(1), leaf(2)], any: [leaf(1), leaf(2)] }))).toThrow();
        expect(() => CriteriaSchema.parse(withGate({ rule: bizGateRef(), extra: 1 }))).toThrow();
    });

    it("caps depth: a criteria document is attacker-supplied input every peer parses", () => {
        // Alternating kinds, because an `all` directly inside an `all` is itself rejected below.
        let deep: GateNode = { all: [leaf(1), leaf(2)] };
        for (let level = 3; level <= MAX_GATE_DEPTH; level += 1) {
            deep = level % 2 === 1 ? { any: [deep, leaf(level)] } : { all: [deep, leaf(level)] };
        }
        expect(() => CriteriaSchema.parse(withGate(deep))).not.toThrow(); // exactly at the cap
        expect(() => CriteriaSchema.parse(withGate({ any: [deep, leaf(9)] }))).toThrow();
    });

    it("rejects the redundant spellings that would fork a topic without changing the meaning", () => {
        // Each of these means exactly what a shorter tree means, and encodes to different bytes —
        // so two authors expressing one contest would land on two topics. The single-child case
        // above is the same family; these are the ones a plain arity check misses.
        expect(() => CriteriaSchema.parse(withGate({ all: [leaf(1), leaf(1)] }))).toThrow(/repeats one of its children/);
        expect(() => CriteriaSchema.parse(withGate({ any: [leaf(1), leaf(2), leaf(1)] }))).toThrow(/repeats one of its children/);
        // `{ all: [{ all: [A, B] }, C] }` admits, scores, blames and penalizes identically to
        // `{ all: [A, B, C] }` — min and `some` are associative, so the nesting carries nothing.
        expect(() => CriteriaSchema.parse(withGate({ all: [{ all: [leaf(1), leaf(2)] }, leaf(3)] }))).toThrow(/nested directly inside/);
        expect(() => CriteriaSchema.parse(withGate({ any: [{ any: [leaf(1), leaf(2)] }, leaf(3)] }))).toThrow(/nested directly inside/);
        // A DIFFERENT kind nested inside is the whole point of a tree, and stays legal.
        expect(() => CriteriaSchema.parse(withGate({ all: [{ any: [leaf(1), leaf(2)] }, leaf(3)] }))).not.toThrow();
        // Duplication is by canonical bytes, so two leaves of one type on different options are
        // distinct requirements, not a repeat.
        expect(() => CriteriaSchema.parse(withGate({ all: [leaf(1), leaf(2)] }))).not.toThrow();
    });

    it("allows a rule to repeat in a DIFFERENT branch — the only way to write some gates", () => {
        // The repeat rule is siblings-only ON PURPOSE. "Any two of these three" has no
        // repetition-free spelling in `all`/`any`, so refusing cross-branch repeats would put a
        // whole class of gates out of reach to buy a canonicity the ordering rule does not deliver
        // anyway (DESIGN.md, "What canonicity here does NOT claim").
        const twoOfThree = {
            any: [
                { all: [leaf(1), leaf(2)] },
                { all: [leaf(1), leaf(3)] },
                { all: [leaf(2), leaf(3)] }
            ]
        };
        expect(() => CriteriaSchema.parse(withGate(twoOfThree))).not.toThrow();
        // The known cost, recorded rather than hidden: absorption survives, so this document means
        // exactly what `{ rule: A }` means and derives a different topic.
        expect(() => CriteriaSchema.parse(withGate({ all: [{ any: [leaf(1), leaf(2)] }, leaf(1)] }))).not.toThrow();
    });

    it("refuses a pathological document as a validation error, not a stack overflow", () => {
        // The bounds are checked on the RAW value before the recursive schema walks it. Without
        // that, a deep document blows the stack inside `z.lazy` — and a `RangeError` escaping
        // `safeParse` breaks the one guarantee that call makes.
        let deep: GateNode = { all: [leaf(1), leaf(2)] };
        for (let level = 0; level < 5000; level += 1) {
            deep = level % 2 === 0 ? { any: [deep, leaf(level + 3)] } : { all: [deep, leaf(level + 3)] };
        }
        const parsed = CriteriaSchema.safeParse(withGate(deep));
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.some((issue) => /gate tree/.test(issue.message))).toBe(true);
    });

    it("caps the leaf count", () => {
        const leaves = Array.from({ length: MAX_GATE_LEAVES }, (_, i) => leaf(i + 1));
        expect(() => CriteriaSchema.parse(withGate({ all: leaves }))).not.toThrow();
        expect(() => CriteriaSchema.parse(withGate({ all: [...leaves, leaf(99)] }))).toThrow();
    });

    it("refuses a pre-`gate` document instead of quietly deriving a different topic", () => {
        // The cutover's safety net. `CriteriaSchema` is strict, so a document still spelling the
        // slot `rule` fails outright rather than parsing with a defaulted or ignored gate — an
        // ignored key would carry the OLD bytes into the CID and put an upgraded client on a
        // topic no one else derives.
        const { gate: _gate, ...withoutGate } = bizCriteria();
        expect(() => CriteriaSchema.parse({ ...withoutGate, rule: bizGateRef() })).toThrow();
        // ...and carrying BOTH spellings is refused too, rather than silently preferring one.
        expect(() => CriteriaSchema.parse({ ...bizCriteria(), rule: bizGateRef() })).toThrow();
    });

    it("forks the topic on gate structure alone: same rules, `all` vs `any`, distinct contests", async () => {
        const children = [leaf(1), leaf(2)];
        const all = CriteriaSchema.parse(withGate({ all: children }));
        const any = CriteriaSchema.parse(withGate({ any: children }));
        expect(await topicFor(all)).not.toBe(await topicFor(any));
        // ...and child order is structure too, so authors cannot shuffle it and stay on-topic.
        const reversed = CriteriaSchema.parse(withGate({ all: [...children].reverse() }));
        expect(await topicFor(reversed)).not.toBe(await topicFor(all));
    });
});
