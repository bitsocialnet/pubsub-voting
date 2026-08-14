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

    it("caps the leaf count", () => {
        const leaves = Array.from({ length: MAX_GATE_LEAVES }, (_, i) => leaf(i + 1));
        expect(() => CriteriaSchema.parse(withGate({ all: leaves }))).not.toThrow();
        expect(() => CriteriaSchema.parse(withGate({ all: [...leaves, leaf(99)] }))).toThrow();
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
