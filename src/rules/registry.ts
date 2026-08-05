import type { Criteria } from "../schema/criteria.js";
import type { RuleRegistry } from "./types.js";
import { UnknownRuleError } from "../errors.js";
import { erc5192MinBalance } from "./erc5192-min-balance.js";
import { constant } from "./constant.js";

/**
 * The rule registry: builtins, the shadowing resolver, and criteria validation.
 *
 * One flat `type -> rule` map (single kind; see types.ts), mirroring the pkc-js
 * challenge registry (`pkc?.settings?.challenges?.[name] ?? pkcJsChallenges[name]`): a
 * host's overrides shadow built-ins by `type`, so clients like 5chan or seedit register
 * custom rules by passing `{ "their-type": rule }` to `PubsubVoter` without
 * forking this library. A custom `type` becomes part of the criteria bytes, so it is
 * provably pinned to the topic it runs on. Both criteria slots (rule, weight) draw
 * from this single registry.
 */

/**
 * The library's built-in rules, before any host override.
 *
 * v1 ships exactly the soulbound-NFT path: `erc5192-min-balance` (Pass gate) + `constant`
 * weight. TWO chain-reading rules stay in the tree and unit-tested (only `erc721-min-balance` is
 * re-exported from `src/index.ts`) but deliberately OUT of this map, so a criteria naming either
 * recuses via `UnknownRuleError` instead of silently gating on an asset that does not bound
 * Sybils. A host that wants one anyway can still register it through the override map below —
 * the library declines to bless the configuration, it does not forbid it.
 *
 * **`erc721-min-balance`** — a bare `balanceOf` on a *transferable* token. The gate bounds
 * Sybils only because the asset cannot move (DESIGN.md "Does one Pass mean one vote?"): every
 * bundle is verified at its OWN pinned block, stays live for `voteExpiryBuckets`, and the
 * winner set is LWW-keyed per wallet, so one token walked A → B → C inside a single expiry
 * window backs three concurrent live votes — each read true at its own block, none collapsed by
 * LWW, and not one of them individually invalid. `erc5192-min-balance` is the same rule plus an
 * on-chain assertion that the contract declares its tokens locked (issue #27).
 *
 * **`erc20-balance`** — the same amplification, reopened by fungibility, plus a second blocker.
 * Both must resolve before it re-ships:
 *
 *   1. the weight path is design-open — a balance-derived weight derives its magnitude from
 *      the chain read, so it carries no free wire-side ceiling for the lazy tally (see
 *      `RuleResult` in types.ts, ROADMAP.md "Deferred");
 *   2. the ERC-5192 fix does not transfer to fungibles: a balance can be neither soulbound nor
 *      LWW-keyed by token id. Closing it needs a hold-duration guard instead — require `min` at
 *      the pinned block AND at `pinned - expiryWindow`, which forces two wallets to have held
 *      the balance simultaneously. Tracked in issue #28.
 *
 * Both exclusions are pinned by tests: the amplification each one permits in
 * `src/crdt/amplification.test.ts`, the absence from this map in `rules.test.ts`.
 */
export const builtinRegistry: RuleRegistry = {
    [erc5192MinBalance.type]: erc5192MinBalance,
    [constant.type]: constant
};

/** type ids the v1 implementation guarantees; checked against `requires.rules`. */
export const V1_BUILTIN_RULE_TYPES = ["erc5192-min-balance", "constant"] as const;

/**
 * Merge host overrides over the built-ins. Overrides shadow built-ins by `type`. The
 * override map is a plain `RuleRegistry` (a flat record already allows any subset
 * of `type`s), so a host passes only the rules it adds or replaces.
 */
export function resolveRegistry(overrides?: RuleRegistry): RuleRegistry {
    return { ...builtinRegistry, ...overrides };
}

/**
 * Validate a criteria document against a resolved registry: the `rule` and
 * `weight` refs must name rules this registry implements, their options must
 * parse against the rule's own schema, and every name in `requires.rules`
 * must be resolvable (so an out-of-date client recuses itself instead of miscounting).
 *
 * Throws `UnknownRuleError` / a zod error on the first failure. This is a check,
 * not a transform: it never mutates `criteria`, so the topic-bearing bytes are untouched
 * (option defaults applied here do not leak back into the encoded criteria).
 */
export function validateCriteriaRules(criteria: Criteria, registry: RuleRegistry): void {
    const rule = registry[criteria.rule.type];
    if (!rule) throw new UnknownRuleError("rule", criteria.rule.type);
    rule.optionsSchema.parse(criteria.rule);

    const weight = registry[criteria.weight.type];
    if (!weight) throw new UnknownRuleError("weight", criteria.weight.type);
    weight.optionsSchema.parse(criteria.weight);

    for (const name of criteria.requires.rules) {
        if (!registry[name]) throw new UnknownRuleError("requires", name);
    }
}
