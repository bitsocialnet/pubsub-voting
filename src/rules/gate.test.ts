import { describe, it, expect } from "vitest";
import type { GateNode } from "../schema/criteria.js";
import type { RuleResult } from "./types.js";
import {
    dedupeLeaves,
    evaluateGate,
    gateBlame,
    gateLeaves,
    gatePenalize,
    gateReason,
    gateScore,
    indexGate,
    type ResolvedGateLeaf
} from "./gate.js";

/**
 * The gate fold, offline: how N per-rule answers become one admission decision, one reason, one
 * blame set and one penalize verdict. Pure — no chain, no registry, no network — because the whole
 * point of keeping composition out of the rules is that it can be pinned exactly like this.
 */

const ref = (type: string): GateNode => ({ rule: { type } });
const pass = (score: bigint): RuleResult => ({ success: true, score });
const fail = (error: string, penalize?: boolean): RuleResult =>
    penalize === undefined ? { success: false, error } : { success: false, error, penalize };

/** Evaluate `node` against a fixed list of per-leaf answers, recording which leaves were asked. */
async function run(node: GateNode, answers: RuleResult[], collectAll = false) {
    const asked: number[] = [];
    const result = await evaluateGate({
        node,
        collectAll,
        evaluate: async (leaf) => {
            asked.push(leaf);
            return answers[leaf]!;
        }
    });
    return { result, asked };
}

/**
 * A leaf whose chain read THREW rather than answering. The tree may still be decidable without
 * it, which is the whole reason `tolerateLeafErrors` exists — see the fold's three-valued logic.
 */
const boom = (leaf: number): Error => new Error(`rpc failed for leaf ${leaf}`);
async function runTolerant(node: GateNode, answers: (RuleResult | "throws")[]) {
    const errors: unknown[] = [];
    const result = await evaluateGate({
        node,
        collectAll: true,
        tolerateLeafErrors: true,
        onLeafError: (leaf, error) => errors.push({ leaf, error }),
        evaluate: async (leaf) => {
            const answer = answers[leaf]!;
            if (answer === "throws") throw boom(leaf);
            return answer;
        }
    });
    return { result, errors };
}

describe("gate tree structure", () => {
    it("numbers leaves depth-first, left to right — the index every per-leaf array is keyed by", () => {
        const node: GateNode = { all: [ref("a"), { any: [ref("b"), ref("c")] }, ref("d")] };
        expect(gateLeaves(node).map((leaf) => leaf.type)).toEqual(["a", "b", "c", "d"]);
        expect(indexGate(node)).toEqual({
            kind: "all",
            children: [
                { kind: "leaf", leaf: 0 },
                { kind: "any", children: [{ kind: "leaf", leaf: 1 }, { kind: "leaf", leaf: 2 }] },
                { kind: "leaf", leaf: 3 }
            ]
        });
    });
});

describe("evaluateGate", () => {
    it("folds a single rule exactly as the rule answered", async () => {
        const { result } = await run(ref("a"), [pass(5n)]);
        expect(result.satisfied).toBe(true);
        expect(gateScore(result)).toBe(5n);

        const { result: refused } = await run(ref("a"), [fail("holds none")]);
        expect(refused.satisfied).toBe(false);
        expect(gateReason(refused)).toBe("holds none");
    });

    it("`all` admits only when every leaf does; `any` when at least one does", async () => {
        const all: GateNode = { all: [ref("a"), ref("b")] };
        expect((await run(all, [pass(1n), pass(2n)], true)).result.satisfied).toBe(true);
        expect((await run(all, [pass(1n), fail("no")], true)).result.satisfied).toBe(false);

        const any: GateNode = { any: [ref("a"), ref("b")] };
        expect((await run(any, [fail("no"), pass(2n)], true)).result.satisfied).toBe(true);
        expect((await run(any, [fail("no"), fail("also no")], true)).result.satisfied).toBe(false);
    });

    it("stops at the deciding leaf, and reports the rest as unknown rather than as failed", async () => {
        // `all`: the first failure decides. The untouched leaf must not read as a failure — it was
        // never asked, and showing it as one would tell a voter to fix something unmeasured.
        const { result, asked } = await run({ all: [ref("a"), ref("b")] }, [fail("no"), pass(9n)]);
        expect(asked).toEqual([0]);
        expect(result.satisfied).toBe(false);
        expect(gateBlame(result).map((leaf) => leaf.error)).toEqual(["no"]);
        if (result.kind === "leaf") throw new Error("expected a branch");
        expect(result.children[1]).toMatchObject({ kind: "leaf", leaf: 1, satisfied: undefined });

        // `any`: the first success decides.
        const { asked: askedAny } = await run({ any: [ref("a"), ref("b")] }, [pass(1n), pass(2n)]);
        expect(askedAny).toEqual([0]);
    });

    it("collectAll asks every leaf even once the outcome is settled", async () => {
        const { asked } = await run({ all: [ref("a"), ref("b"), ref("c")] }, [fail("no"), pass(1n), fail("nope")], true);
        expect(asked.sort()).toEqual([0, 1, 2]);
    });

    it("asks each leaf at most once — callers memoize on that contract", async () => {
        const node: GateNode = { all: [ref("a"), { any: [ref("b"), ref("c")] }] };
        const { asked } = await run(node, [pass(1n), fail("no"), pass(2n)], true);
        expect(asked.slice().sort()).toEqual([0, 1, 2]);
        expect(new Set(asked).size).toBe(asked.length);
    });

    it("treats a rule that reports success with no score as a failure, not a zero-weight admit", async () => {
        const { result } = await run(ref("a"), [{ success: true, score: 0n }]);
        expect(result.satisfied).toBe(false);
    });
});

describe("gateScore", () => {
    it("takes the binding constraint across `all` and the best qualification across `any`", async () => {
        const { result: all } = await run({ all: [ref("a"), ref("b")] }, [pass(7n), pass(3n)], true);
        expect(gateScore(all)).toBe(3n);
        const { result: any } = await run({ any: [ref("a"), ref("b")] }, [pass(7n), pass(3n)], true);
        expect(gateScore(any)).toBe(7n);
    });

    it("ignores a failed alternative inside a satisfied `any`", async () => {
        const { result } = await run({ any: [ref("a"), ref("b")] }, [fail("no"), pass(4n)], true);
        expect(gateScore(result)).toBe(4n);
    });
});

describe("gateBlame — which rules explain a refusal", () => {
    it("names every failing child of a failing `all`", async () => {
        const { result } = await run({ all: [ref("a"), ref("b"), ref("c")] }, [fail("A"), pass(1n), fail("C")], true);
        expect(gateBlame(result).map((leaf) => leaf.error)).toEqual(["A", "C"]);
        expect(gateReason(result)).toBe("A; C");
    });

    it("names every child of a failing `any` — each is a road the wallet could have taken", async () => {
        const { result } = await run({ any: [ref("a"), ref("b")] }, [fail("A"), fail("B")], true);
        expect(gateBlame(result).map((leaf) => leaf.error)).toEqual(["A", "B"]);
    });

    it("blames NOTHING for a failure inside a satisfied `any` — the wallet never needed it", async () => {
        // The reason a flat "which rules failed" list is the wrong answer under `any`: rule `a`
        // failed, the wallet is eligible anyway, and telling it to go acquire `a` is noise.
        const node: GateNode = { all: [{ any: [ref("a"), ref("b")] }, ref("c")] };
        const { result } = await run(node, [fail("A"), pass(1n), fail("C")], true);
        expect(result.satisfied).toBe(false);
        expect(gateBlame(result).map((leaf) => leaf.error)).toEqual(["C"]);
    });

    it("is empty when the gate admits", async () => {
        const { result } = await run({ any: [ref("a"), ref("b")] }, [fail("A"), pass(1n)], true);
        expect(gateBlame(result)).toEqual([]);
    });
});

describe("gatePenalize — may a refusal be blamed on the sender", () => {
    it("defaults to the single rule's own answer", async () => {
        expect(gatePenalize((await run(ref("a"), [fail("no")])).result)).toBe(true);
        expect(gatePenalize((await run(ref("a"), [fail("no", false)])).result)).toBe(false);
    });

    it("`all`: ONE attributable failure is enough — that rule alone closes the gate everywhere", async () => {
        const node: GateNode = { all: [ref("a"), ref("b")] };
        expect(gatePenalize((await run(node, [fail("A", false), fail("B", true)], true)).result)).toBe(true);
        expect(gatePenalize((await run(node, [fail("A", false), fail("B", false)], true)).result)).toBe(false);
    });

    it("`any`: attributable only if EVERY alternative failed attributably", async () => {
        // One unprovable failure means a peer looking at a fresher chain may see a wallet this
        // gate would admit — penalizing it for relaying that vote punishes it for being current.
        const node: GateNode = { any: [ref("a"), ref("b")] };
        expect(gatePenalize((await run(node, [fail("A", true), fail("B", false)], true)).result)).toBe(false);
        expect(gatePenalize((await run(node, [fail("A", true), fail("B", true)], true)).result)).toBe(true);
    });

    it("a satisfied `any` inside a failing `all` contributes no blame and no penalty", async () => {
        const node: GateNode = { all: [{ any: [ref("a"), ref("b")] }, ref("c")] };
        const { result } = await run(node, [fail("A", true), pass(1n), fail("C", false)], true);
        expect(gatePenalize(result)).toBe(false); // only C explains it, and C blames nobody
    });

    it("a short-circuited `all` can only UNDER-report, never over-report", async () => {
        // Lazy evaluation stops at the first failure and never learns whether a later child was
        // attributable. The cost is a spammer we merely `ignore`; the alternative — guessing
        // `true` — would reject-score honest relayers on evidence never gathered.
        const node: GateNode = { all: [ref("a"), ref("b")] };
        const lazy = (await run(node, [fail("A", false), fail("B", true)])).result;
        const complete = (await run(node, [fail("A", false), fail("B", true)], true)).result;
        expect(gatePenalize(lazy)).toBe(false);
        expect(gatePenalize(complete)).toBe(true);
    });

    it("never penalizes a gate that admitted", async () => {
        expect(gatePenalize((await run(ref("a"), [pass(1n)])).result)).toBe(false);
    });
});

/**
 * A leaf that cannot answer at all. A chain read is infrastructure: it fails for reasons that say
 * nothing about the wallet, so "unknown" must never be folded as "no" — that would refuse a voter
 * over someone else's RPC outage, and (on a path that penalizes) blame the peer that relayed them.
 */
describe("a leaf whose read failed", () => {
    it("propagates by default — an unanswered gate is not a refusal", async () => {
        await expect(
            evaluateGate({
                node: { any: [ref("a"), ref("b")] },
                collectAll: true,
                evaluate: async (leaf) => {
                    if (leaf === 0) throw boom(0);
                    return pass(1n);
                }
            })
        ).rejects.toThrow("rpc failed for leaf 0");
    });

    it("still admits when another branch of an `any` already decided it", async () => {
        // The wallet qualifies through `b`. Failing the whole check because `a`'s read timed out
        // would tell an eligible voter they are ineligible — over an outage they cannot act on.
        const { result, errors } = await runTolerant({ any: [ref("a"), ref("b")] }, ["throws", pass(4n)]);
        expect(result.satisfied).toBe(true);
        expect(gateScore(result)).toBe(4n);
        expect(errors).toHaveLength(1);
        if (result.kind === "leaf") throw new Error("expected a branch");
        // The unreadable leaf reports UNKNOWN, never `false`: nothing was learned about it.
        expect(result.children[0]).toMatchObject({ leaf: 0, satisfied: undefined });
    });

    it("still refuses when a known failure decides an `all`, and never blames the unknown leaf", async () => {
        const { result } = await runTolerant({ all: [ref("a"), ref("b")] }, ["throws", fail("this wallet is banned")]);
        expect(result.satisfied).toBe(false);
        // Only the rule that actually answered explains the refusal — a voter cannot act on "we
        // could not reach the chain", and `a` may well have admitted them.
        expect(gateBlame(result).map((leaf) => leaf.error)).toEqual(["this wallet is banned"]);
        expect(gateReason(result)).toBe("this wallet is banned");
    });

    it("reports UNKNOWN, not a verdict, when the failed read is the one that decides", async () => {
        // `all` needs both; one is unknown and the other passed, so the gate has no answer. The
        // caller turns this back into the underlying infra error rather than inventing one.
        const { result, errors } = await runTolerant({ all: [ref("a"), ref("b")] }, ["throws", pass(1n)]);
        expect(result.satisfied).toBeUndefined();
        expect(errors).toHaveLength(1);
        // Same for an `any` where every alternative is unknown-or-failed but none passed.
        const either = await runTolerant({ any: [ref("a"), ref("b")] }, ["throws", fail("holds none")]);
        expect(either.result.satisfied).toBeUndefined();
    });

    it("never penalizes on an incomplete tree", async () => {
        // `any` is attributable only if EVERY alternative failed attributably; one that never
        // answered is not one of them, so nobody is reject-scored on a read that did not happen.
        const { result } = await runTolerant({ any: [ref("a"), ref("b")] }, ["throws", fail("holds none")]);
        expect(gatePenalize(result)).toBe(false);
        // An `all` that a known attributable failure already closed is still attributable: that
        // one rule shuts the gate identically on every verifier, whatever the unknown leaf says.
        const closed = await runTolerant({ all: [ref("a"), ref("b")] }, ["throws", fail("holds none")]);
        expect(gatePenalize(closed.result)).toBe(true);
    });
});

/**
 * Two positions, one question. A gate may name the same rule in more than one branch — that is
 * how "any two of these three" is written (schema/criteria.ts) — and the pipeline must ask it
 * once. Not merely to save work: the fold evaluates leaves concurrently, so two positions would
 * both miss the rule's own memo before either wrote to it, and the coalescer can only dedupe
 * reads that are actually identical calls.
 */
describe("dedupeLeaves", () => {
    const leafFor = (key: string): ResolvedGateLeaf => ({ key }) as ResolvedGateLeaf;

    it("maps every position to its question, keeping first-seen order", () => {
        const { representatives, ofLeaf } = dedupeLeaves(["a", "b", "a", "c", "b"].map(leafFor));
        expect(representatives).toEqual([0, 1, 3]); // first position of a, b, c
        expect(ofLeaf).toEqual([0, 1, 0, 2, 1]);
    });

    it("is the identity when every leaf is distinct", () => {
        const { representatives, ofLeaf } = dedupeLeaves(["a", "b", "c"].map(leafFor));
        expect(representatives).toEqual([0, 1, 2]);
        expect(ofLeaf).toEqual([0, 1, 2]);
    });

    it("collapses a 'two of three' gate to its three distinct questions", () => {
        // { any: [{all:[A,B]}, {all:[A,C]}, {all:[B,C]}] } — six positions, three questions.
        const { representatives } = dedupeLeaves(["a", "b", "a", "c", "b", "c"].map(leafFor));
        expect(representatives).toHaveLength(3);
    });
});
