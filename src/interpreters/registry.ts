import type { Criteria } from "../schema/criteria.js";
import type { InterpreterRegistry } from "./types.js";
import { UnknownInterpreterError } from "../errors.js";
import { erc721MinBalance } from "./erc721-min-balance.js";
import { constant } from "./constant.js";

/**
 * The interpreter registry: builtins, the shadowing resolver, and criteria validation.
 *
 * One flat `type -> interpreter` map (single kind; see types.ts), mirroring the pkc-js
 * challenge registry (`pkc?.settings?.challenges?.[name] ?? pkcJsChallenges[name]`): a
 * host's overrides shadow built-ins by `type`, so clients like 5chan or seedit register
 * custom interpreters by passing `{ "their-type": interpreter }` to `PubsubVoter` without
 * forking this library. A custom `type` becomes part of the criteria bytes, so it is
 * provably pinned to the topic it runs on. Both criteria slots (eligibility, weight) draw
 * from this single registry.
 */

/**
 * The library's built-in interpreters, before any host override.
 *
 * v1 ships exactly the NFT path: `erc721-min-balance` (Pass gate) + `constant` weight.
 * `erc20-balance` is intentionally NOT registered — it stays in the tree (`erc20-balance.ts`,
 * unit-tested) as the design-open weight path, but is unshipped so a criteria naming it
 * recuses via `UnknownInterpreterError` rather than silently enabling token-weighting. See
 * ROADMAP.md ("Deferred") for when it re-ships.
 */
export const builtinRegistry: InterpreterRegistry = {
    [erc721MinBalance.type]: erc721MinBalance,
    [constant.type]: constant
};

/** type ids the v1 implementation guarantees; checked against `requires.interpreters`. */
export const V1_BUILTIN_INTERPRETER_TYPES = ["erc721-min-balance", "constant"] as const;

/**
 * Merge host overrides over the built-ins. Overrides shadow built-ins by `type`. The
 * override map is a plain `InterpreterRegistry` (a flat record already allows any subset
 * of `type`s), so a host passes only the interpreters it adds or replaces.
 */
export function resolveRegistry(overrides?: InterpreterRegistry): InterpreterRegistry {
    return { ...builtinRegistry, ...overrides };
}

/**
 * Validate a criteria document against a resolved registry: the `eligibility` and
 * `weight` refs must name interpreters this registry implements, their options must
 * parse against the interpreter's own schema, and every name in `requires.interpreters`
 * must be resolvable (so an out-of-date client recuses itself instead of miscounting).
 *
 * Throws `UnknownInterpreterError` / a zod error on the first failure. This is a check,
 * not a transform: it never mutates `criteria`, so the topic-bearing bytes are untouched
 * (option defaults applied here do not leak back into the encoded criteria).
 */
export function validateCriteriaInterpreters(criteria: Criteria, registry: InterpreterRegistry): void {
    const eligibility = registry[criteria.eligibility.type];
    if (!eligibility) throw new UnknownInterpreterError("eligibility", criteria.eligibility.type);
    eligibility.optionsSchema.parse(criteria.eligibility);

    const weight = registry[criteria.weight.type];
    if (!weight) throw new UnknownInterpreterError("weight", criteria.weight.type);
    weight.optionsSchema.parse(criteria.weight);

    for (const name of criteria.requires.interpreters) {
        if (!registry[name]) throw new UnknownInterpreterError("requires", name);
    }
}
