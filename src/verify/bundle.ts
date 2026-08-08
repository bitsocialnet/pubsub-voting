import type { VotesBundle } from "../schema/votes.js";
import type { Criteria } from "../schema/criteria.js";
import type { RuleRegistry } from "../rules/types.js";
import type { ChainClient, BucketMath, NameResolver } from "../chain/types.js";
import { tickerForRef } from "../chain/ticker.js";
import { makeMemoryRuleCache, type RuleCache } from "../rules/cache.js";
import { UnknownRuleError } from "../errors.js";
import { verifyBundleSignature } from "./signature.js";
import { checkBundleConstraints } from "./constraints.js";
import { resolveNameThroughCache, type NameResolutionCache } from "./name-resolution-cache.js";
import type { BundleVerifier, BundleVerdict } from "./types.js";

/**
 * The full validity pipeline for one bundle — the work the gossip forward-gate runs before
 * re-forwarding (see DESIGN.md "Transport"). Cheap-to-expensive with early exit so the
 * costly network/chain steps only run for genuinely-new, signature-valid bundles:
 *
 *   1. signature   (local, µs): recover the EIP-712 signer, must equal `bundle.address`.
 *   2. constraints (local, µs): `votes.length <= maxVotesPerAddress`, each vote in range.
 *   3. gate        (chain):     the `rule` scores the wallet `> 0n`, at whichever block the rule
 *                               itself reads (rules/types.ts). `0n` -> not admitted -> drop, as
 *                               a `reject` when the rule blames the sender for it and an
 *                               `ignore` when it does not.
 *   4. name        (network):   each vote's `community.name` (if any) must resolve to the
 *                               claimed `publicKey`; a squatted/absent name drops the bundle.
 *
 * Every step only ever SUBTRACTS trust (a bundle is valid or dropped), which is what lets the
 * gate reject without forwarding. Weight *magnitude* is not computed here — it is a ranking
 * concern the tally derives lazily, not a validity concern (see DESIGN.md "Tally").
 *
 * Expiry is deliberately out of scope here: it depends on the current bucket (a clock), so it
 * is enforced by the CRDT's read-time filter (`current` drops decayed votes given the
 * current bucket; `prune` bounds memory), not by this time-independent verifier.
 */

/** Everything the verifier needs, resolved once per contest. */
export interface BundleVerifierDeps {
    criteria: Criteria;
    /** The criteria document's CID bytes (`(await criteriaCid(criteria)).bytes`) — signature binding. */
    criteriaCid: Uint8Array;
    /** The rule chain's numeric chainId (bound in the ballot domain). */
    chainId: number;
    /** Resolved rule registry (built-ins + host overrides). */
    registry: RuleRegistry;
    /** Resolve a chain ticker (e.g. "base") to its viem client. */
    chainFor: (ticker: string) => ChainClient;
    /** Bucket math for `criteria.blocksPerBucket`. */
    bucketMath: BucketMath;
    /** Host-injected community-name resolvers (`PubsubVoterOptions.nameResolvers`). */
    nameResolvers: NameResolver[];
    /**
     * This verifier's current head, handed to the rule as `ctx.head`. A rule scoring pinned
     * historical state never calls it, so a pinned-only deployment does no head read at all.
     * Defaults to a direct `getBlockNumber()` on the rule's own client; the voter injects its
     * coalesced reader instead, so a directory-wide burst shares one read per chain (see
     * client/voter.ts `makeHeadReader`).
     */
    readHead?: (args: { chain: ChainClient }) => Promise<{ block: number }>;
    /**
     * The gate rule's memo (see rules/cache.ts), handed to it as `ctx.cache`. This is what keeps
     * a wallet's gate read from repeating per bundle — an ineligible wallet minting fresh-signed
     * bundles, or an eligible one cycling choices, costs one read per key per rule epoch rather
     * than one per bundle. Defaults to a private in-memory cache (unit tests); the voter injects
     * the persistent, contest-shared one.
     */
    ruleCache?: RuleCache;
    /**
     * Optional persistent cache of name resolutions (the pkc-js rule — see
     * verify/name-resolution-cache.ts). When present, a carried name is resolved live at most
     * once per {@link NAME_RESOLUTION_MAX_AGE_SECONDS} per resolver. Omitted ⇒ every verify
     * resolves live (prior behaviour; unit tests).
     */
    nameResolutionCache?: NameResolutionCache;
}

export function makeBundleVerifier(deps: BundleVerifierDeps): BundleVerifier {
    const { criteria, criteriaCid, chainId, registry, chainFor, bucketMath, nameResolvers, nameResolutionCache } = deps;

    // Resolve the gate `rule`, its options and its chain client once: they are fixed by the
    // criteria, so none of it is recomputed per bundle.
    const rule = registry[criteria.rule.type];
    if (!rule) throw new UnknownRuleError("rule", criteria.rule.type);
    const ruleOptions = rule.optionsSchema.parse(criteria.rule);
    const ruleChain = chainFor(tickerForRef(criteria, criteria.rule, ruleOptions));
    const readHead = deps.readHead ?? (async ({ chain }: { chain: ChainClient }) => ({ block: Number(await chain.getBlockNumber()) }));
    // The rule's whole world: its chain, this verifier's head (lazy — never read for a rule that
    // does not want it), and its own memo. Which block it actually reads at is its business.
    const ctx = {
        chain: ruleChain,
        head: () => readHead({ chain: ruleChain }),
        cache: deps.ruleCache ?? makeMemoryRuleCache()
    };

    // Stage 1, shared by `verify` and `verifyOffline`: signature + constraints, local and µs.
    const verifyOffline = async (bundle: VotesBundle) => {
        // 1. Signature (free) — a forged/tampered bundle drops before any chain/network read.
        const signature = await verifyBundleSignature({ bundle, criteriaCid, chainId });
        if (!signature.valid) return signature;

        // 2. Criteria constraints (free) — cap + vote range.
        return checkBundleConstraints(bundle, criteria);
    };

    return {
        verifyOffline,
        async verify(bundle: VotesBundle): Promise<BundleVerdict> {
            const offline = await verifyOffline(bundle);
            if (!offline.valid) return offline;

            // 3. Gate (chain) — the rule scores this wallet, reading and memoizing however it
            //    sees fit. The bundle's bucketized sample block is handed over as the pinned
            //    block the ballot names; a rule scoring current state ignores it for `ctx.head`.
            const sampleBlock = bucketMath.sampleBlockForBucket(bucketMath.bucketForBlock(bundle.blockNumber));
            const { score, penalize } = await rule.evaluate({
                options: ruleOptions,
                wallet: { address: bundle.address, sampleBlock },
                ctx
            });
            if (score === 0n) {
                // Disposition comes from the rule's own answer, never from the rule's identity.
                // A `0n` the rule stands behind is identical on every honest verifier, so it is a
                // `reject`: the sender is penalized and the verdict cached as terminal. A `0n` it
                // will not blame anyone for — the rule read this verifier's head, where my view
                // and yours legitimately differ — drops the bundle just the same but stays
                // `ignore`-class: no penalty for a relayer that saw a fresher chain, and
                // uncached, so it is re-judged rather than frozen (the same treatment community
                // name resolution has always had, step 4 below).
                return {
                    valid: false,
                    disposition: penalize === false ? "ignore" : "reject",
                    reason: `not admitted: rule score is 0n`
                };
            }

            // 4. Community-name resolution (network) — a carried name is a claim, verified against
            //    the registry. A name that has no resolver, does not resolve, or resolves to a
            //    different publicKey than the vote claims drops the whole bundle. These failures
            //    are `ignore`, not `reject`: v1 resolves at head, so they are view-/clock-dependent
            //    (a missing resolver differs per verifier; a re-point produces a transient window
            //    where honest peers disagree — see DESIGN.md "Tally"/"Open questions"). Penalizing
            //    the sender for that would punish honest relayers; the drop still stops propagation.
            //    (Once pinned-block resolution lands, a steady-state mismatch becomes provable
            //    `reject`.) The gossip gate therefore does NOT cache these verdicts. Successful
            //    resolutions DO go through the shared name-resolution cache (the pkc-js rule,
            //    1-hour max-age) — bounding the RPC cost, while a re-point is still honored
            //    within the hour and a failed resolution is never negatively cached.
            const resolvedNames: Record<string, string> = {};
            for (const v of bundle.votes) {
                const name = v.community.name;
                if (!name) continue;
                const resolver = nameResolvers.find((r) => r.canResolve({ name }));
                if (!resolver) return { valid: false, disposition: "ignore", reason: `no resolver handles community name "${name}"` };
                const record = await resolveNameThroughCache({ resolver, name, cache: nameResolutionCache });
                if (!record) return { valid: false, disposition: "ignore", reason: `community name "${name}" does not resolve` };
                if (record.publicKey !== v.community.publicKey) {
                    return {
                        valid: false,
                        disposition: "ignore",
                        reason: `community name "${name}" resolves to ${record.publicKey}, not the claimed ${v.community.publicKey}`
                    };
                }
                resolvedNames[name] = record.publicKey;
            }

            return { valid: true, ruleScore: score, resolvedNames };
        }
    };
}
