import type { Criteria, GateNode, RuleRef } from "../schema/criteria.js";
import type { ChainReadContext, Rule, RuleRegistry, RuleResult } from "./types.js";
import type { ChainClient } from "../chain/types.js";
import { tickerForRef } from "../chain/ticker.js";
import { makeMemoryRuleCache, type RuleCache } from "./cache.js";
import { UnknownRuleError } from "../errors.js";
import { gateFailure, scoreOrZero } from "./result.js";

/**
 * The gate tree: how one wallet's per-rule answers fold into one admission decision.
 *
 * The criteria document composes rule references with `all` / `any` (schema/criteria.ts). A rule
 * still answers exactly one question about one wallet and knows nothing about the others — the
 * composition lives here, and like {@link gateFailure} / {@link scoreOrZero} in result.ts it reads
 * the tree's structure and the results' discriminants, NEVER which rule produced them (AGENTS.md,
 * "What a rule owns, and what the pipeline owns").
 *
 * One evaluator serves both callers, which is the whole point of it living in one file: the inline
 * forward gate evaluates lazily and stops as soon as the root is determined (one wallet, and every
 * leaf costs a chain read), while the background verifier and `checkEligibility` evaluate every
 * leaf — the first because its reads are batched per rule across a whole round (collecting all is
 * CHEAPER there than short-circuiting), the second because listing every failure is the feature.
 */

/** Leaf refs in depth-first order — the index every per-leaf array in the pipeline is keyed by. */
export function gateLeaves(node: GateNode): RuleRef[] {
    if ("rule" in node) return [node.rule];
    const children = "all" in node ? node.all : node.any;
    return children.flatMap(gateLeaves);
}

/** One gate leaf, resolved against a registry and ready to score wallets. */
export interface ResolvedGateLeaf {
    /** The criteria's reference, verbatim — the bytes a `ruleId` is derived from. */
    ref: RuleRef;
    rule: Rule;
    /** `ref` parsed through the rule's own schema (defaults applied; never written back). */
    options: unknown;
    /** The rule's whole world: its chain, this verifier's head, its own memo. */
    ctx: ChainReadContext;
}

/**
 * Resolve every gate leaf once per contest: its rule, its parsed options, the chain it reads and
 * the memo it computes through. Shared by the inline verifier and the background verifier so the
 * two cannot resolve a gate differently — the same reason the fold above lives in one file.
 *
 * `caches` is per leaf in {@link gateLeaves} order (the voter's persistent, per-rule namespaces);
 * omitted, each leaf gets a private in-memory memo, which is what unit tests want.
 */
export function resolveGate(args: {
    criteria: Criteria;
    registry: RuleRegistry;
    chainFor: (ticker: string) => ChainClient;
    readHead: (args: { chain: ChainClient }) => Promise<{ block: number }>;
    caches?: readonly RuleCache[] | undefined;
}): ResolvedGateLeaf[] {
    const { criteria, registry, chainFor, readHead, caches } = args;
    return gateLeaves(criteria.gate).map((ref, index) => {
        const rule = registry[ref.type];
        if (!rule) throw new UnknownRuleError("gate", ref.type);
        const options = rule.optionsSchema.parse(ref);
        const chain = chainFor(tickerForRef(criteria, ref, options));
        return {
            ref,
            rule,
            options,
            ctx: { chain, head: () => readHead({ chain }), cache: caches?.[index] ?? makeMemoryRuleCache() }
        };
    });
}

/** The tree with its leaves numbered, so evaluation order cannot shift what a leaf index means. */
export type IndexedGate = { kind: "leaf"; leaf: number } | { kind: "all" | "any"; children: IndexedGate[] };

export function indexGate(node: GateNode, next = { leaf: 0 }): IndexedGate {
    if ("rule" in node) return { kind: "leaf", leaf: next.leaf++ };
    const kind = "all" in node ? "all" : "any";
    const children = "all" in node ? node.all : node.any;
    return { kind, children: children.map((child) => indexGate(child, next)) };
}

/** One leaf's verdict. `satisfied: undefined` means the evaluation short-circuited past it. */
export interface GateLeafResult {
    kind: "leaf";
    leaf: number;
    satisfied: boolean | undefined;
    /** `0n` unless the leaf passed. */
    score: bigint;
    /** The rule's own voter-facing sentence; present only on a failure. */
    error?: string;
    /** Whether THIS leaf's failure may be blamed on the sender (rules/types.ts). */
    penalize: boolean;
}

/**
 * The evaluated tree. `satisfied: undefined` marks a node the evaluation never reached — an `all`
 * short-circuits only on a failing child and an `any` only on a passing one, so everything after
 * the deciding child is skipped and reported as unknown rather than as failed.
 */
export type GateResult = GateLeafResult | { kind: "all" | "any"; satisfied: boolean | undefined; children: GateResult[] };

const UNEVALUATED = (leaf: number): GateLeafResult => ({ kind: "leaf", leaf, satisfied: undefined, score: 0n, penalize: false });

/** Number every leaf of `node`, then score them through `evaluate` and fold the answers. */
export async function evaluateGate(args: {
    node: GateNode;
    /** Score one leaf by its index. Callers memoize; this never calls the same index twice. */
    evaluate: (leaf: number) => Promise<RuleResult>;
    /**
     * Evaluate every leaf even once the outcome is determined. Required whenever the per-leaf
     * results are the output (`checkEligibility`) or already in hand (the batched background
     * verifier); the inline gate leaves it off and pays for only what it needs.
     */
    collectAll?: boolean;
}): Promise<GateResult> {
    const { node, evaluate, collectAll = false } = args;

    const run = async (indexed: IndexedGate): Promise<GateResult> => {
        if (indexed.kind === "leaf") {
            const result = await evaluate(indexed.leaf);
            const failed = gateFailure(result);
            return failed
                ? { kind: "leaf", leaf: indexed.leaf, satisfied: false, score: 0n, error: failed.error, penalize: failed.penalize }
                : { kind: "leaf", leaf: indexed.leaf, satisfied: true, score: scoreOrZero(result), penalize: false };
        }
        // An `all` is determined by its first failing child, an `any` by its first passing one.
        const decidesAt = indexed.kind === "all" ? false : true;
        if (collectAll) {
            const children = await Promise.all(indexed.children.map(run));
            const satisfied = indexed.kind === "all" ? children.every(isSatisfied) : children.some(isSatisfied);
            return { kind: indexed.kind, satisfied, children };
        }
        const children: GateResult[] = [];
        for (const [position, child] of indexed.children.entries()) {
            const result = await run(child);
            children.push(result);
            if (isSatisfied(result) === decidesAt) {
                // Everything after this point cannot change the answer: record the skipped leaves
                // as unevaluated so the tree still mirrors the document's shape.
                for (const rest of indexed.children.slice(position + 1)) children.push(...skipped(rest));
                return { kind: indexed.kind, satisfied: decidesAt, children };
            }
        }
        return { kind: indexed.kind, satisfied: !decidesAt, children };
    };

    return run(indexGate(node));
}

/** A node the evaluation never reached, shaped like the result it would have produced. */
function skipped(indexed: IndexedGate): GateResult[] {
    if (indexed.kind === "leaf") return [UNEVALUATED(indexed.leaf)];
    return [{ kind: indexed.kind, satisfied: undefined, children: indexed.children.flatMap(skipped) }];
}

const isSatisfied = (result: GateResult): boolean => result.satisfied === true;

/**
 * The gate's score for a wallet it admitted: a leaf's own score, the MINIMUM across an `all` (the
 * binding constraint), the MAXIMUM across the satisfied children of an `any` (the wallet's best
 * qualification). Degenerates to the rule's own score for a single-rule gate. Informational only —
 * a vote's magnitude comes from `criteria.weight`, never from here.
 */
export function gateScore(result: GateResult): bigint {
    if (result.kind === "leaf") return result.score;
    const scores = result.children.filter(isSatisfied).map(gateScore);
    if (scores.length === 0) return 0n;
    return result.kind === "all"
        ? scores.reduce((min, score) => (score < min ? score : min))
        : scores.reduce((max, score) => (score > max ? score : max));
}

/**
 * The failing leaves that EXPLAIN a refusal — what a client shows the voter, and the only honest
 * answer to "which rules failed". It is not every failed leaf: a leaf that failed inside a
 * satisfied `any` cost the wallet nothing, and telling someone to go acquire an asset they do not
 * need is worse than saying nothing.
 */
export function gateBlame(result: GateResult): GateLeafResult[] {
    if (result.satisfied !== false) return [];
    if (result.kind === "leaf") return [result];
    // A failing `all` is explained by whichever children failed; a failing `any` by all of them,
    // since every one of its alternatives is a road the wallet could have taken and did not.
    return result.children.flatMap(gateBlame);
}

/**
 * May a refusal be blamed on the peer that sent the vote? The recursive generalization of
 * `RuleResult.penalize` (rules/types.ts) — and the reason it cannot be a simple OR:
 *
 *   - an `all` fails as soon as ONE child does, so a single attributable failure is enough: that
 *     child alone closes the gate identically on every honest verifier.
 *   - an `any` fails only when EVERY child does, so it is attributable only if every one of them
 *     is. One child whose failure another peer could legitimately disagree about means that peer
 *     may be looking at a wallet this gate would admit.
 *
 * A short-circuited `all` can only UNDER-report (it stops at the first failure and never learns
 * whether a later child was attributable), which is the fail-safe direction: the cost is a
 * spammer we merely `ignore`, against wrongly reject-scoring an honest relayer.
 */
export function gatePenalize(result: GateResult): boolean {
    if (result.satisfied !== false) return false;
    if (result.kind === "leaf") return result.penalize;
    const failing = result.children.filter((child) => child.satisfied === false);
    if (failing.length === 0) return false;
    return result.kind === "all" ? failing.some(gatePenalize) : failing.every(gatePenalize);
}

/** The blame set's reasons, as the one sentence `VerifyFail.reason` and `VoteEvictedError` carry. */
export function gateReason(result: GateResult): string {
    const reasons = gateBlame(result).map((leaf) => leaf.error ?? "this wallet does not qualify");
    return [...new Set(reasons)].join("; ");
}
