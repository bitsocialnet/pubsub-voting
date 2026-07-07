import type { VotesBundle } from "../schema/votes.js";
import type { Criteria } from "../schema/criteria.js";
import type { RuleRegistry } from "../rules/types.js";
import type { ChainClient, BucketMath, NameResolver } from "../chain/types.js";
import { tickerForRef } from "../chain/ticker.js";
import { UnknownRuleError } from "../errors.js";
import { verifyBundleSignature } from "./signature.js";
import { checkBundleConstraints } from "./constraints.js";
import type { GateResultCache } from "./gate-result-cache.js";
import type { BundleVerifier, BundleVerdict } from "./types.js";

/**
 * The full validity pipeline for one bundle — the work the gossip forward-gate runs before
 * re-forwarding (see DESIGN.md "Transport"). Cheap-to-expensive with early exit so the
 * costly network/chain steps only run for genuinely-new, signature-valid bundles:
 *
 *   1. signature   (local, µs): recover the EIP-712 signer, must equal `bundle.address`.
 *   2. constraints (local, µs): `votes.length <= maxVotesPerAddress`, each vote in range.
 *   3. gate        (chain):     the `rule` scores the wallet `> 0n` at the bucket block.
 *                               `0n` -> not admitted -> drop.
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
     * Optional cache of gate results, keyed by `(wallet, sampleBlock)`. When present, a wallet's
     * score at a bucket's sample block is read from chain at most once — a `0n` miss short-circuits
     * a flood of fresh-signed bundles from an ineligible wallet, and a `> 0n` hit short-circuits an
     * *eligible* wallet re-signing or cycling choices within a bucket. Both are deterministic,
     * historical reads. Omitted ⇒ every novel bundle pays its own gate read (prior behaviour).
     */
    gateResultCache?: GateResultCache;
}

export function makeBundleVerifier(deps: BundleVerifierDeps): BundleVerifier {
    const { criteria, criteriaCid, chainId, registry, chainFor, bucketMath, nameResolvers, gateResultCache } = deps;

    // Resolve the gate `rule`, its options, and its chain client once. The rule reads at the
    // bundle's bucket block, but which rule/chain to use is fixed by the criteria, so it need
    // not be recomputed per bundle.
    const rule = registry[criteria.rule.type];
    if (!rule) throw new UnknownRuleError("rule", criteria.rule.type);
    const ruleOptions = rule.optionsSchema.parse(criteria.rule);
    const ruleChain = chainFor(tickerForRef(criteria, criteria.rule, ruleOptions));

    return {
        async verify(bundle: VotesBundle): Promise<BundleVerdict> {
            // 1. Signature (free) — a forged/tampered bundle drops before any chain/network read.
            const signature = await verifyBundleSignature({ bundle, criteriaCid, chainId });
            if (!signature.valid) return signature;

            // 2. Criteria constraints (free) — cap + vote range.
            const constraints = checkBundleConstraints(bundle, criteria);
            if (!constraints.valid) return constraints;

            // 3. Gate (chain) — read the `rule` at the bucket's sample block. The score is a pure
            //    function of a pinned historical block, so it is memoized per `(wallet, sampleBlock)`:
            //    a cache hit short-circuits the chain read for a flood of fresh-signed bundles from
            //    the same wallet, whether it is ineligible (`0n`, a `reject`) or eligible (`> 0n`,
            //    re-signing / cycling choices within one bucket).
            const sampleBlock = bucketMath.sampleBlockForBucket(bucketMath.bucketForBlock(bundle.blockNumber));
            let score = gateResultCache?.get(bundle.address, sampleBlock);
            if (score === undefined) {
                ({ score } = await rule.evaluate({
                    options: ruleOptions,
                    walletAddress: bundle.address,
                    ctx: { chain: ruleChain, blockNumber: sampleBlock }
                }));
                gateResultCache?.set(bundle.address, sampleBlock, score);
            }
            if (score === 0n) {
                return { valid: false, disposition: "reject", reason: `not admitted: rule score is 0n at block ${sampleBlock}` };
            }

            // 4. Community-name resolution (network) — a carried name is a claim, verified against
            //    the registry. A name that has no resolver, does not resolve, or resolves to a
            //    different publicKey than the vote claims drops the whole bundle. These failures
            //    are `ignore`, not `reject`: v1 resolves at head, so they are view-/clock-dependent
            //    (a missing resolver differs per verifier; a re-point produces a transient window
            //    where honest peers disagree — see DESIGN.md "Tally"/"Open questions"). Penalizing
            //    the sender for that would punish honest relayers; the drop still stops propagation.
            //    (Once pinned-block resolution lands, a steady-state mismatch becomes provable
            //    `reject`.) The gossip gate therefore does NOT cache these verdicts.
            const resolvedNames: Record<string, string> = {};
            for (const v of bundle.votes) {
                const name = v.community.name;
                if (!name) continue;
                const resolver = nameResolvers.find((r) => r.canResolve({ name }));
                if (!resolver) return { valid: false, disposition: "ignore", reason: `no resolver handles community name "${name}"` };
                const record = await resolver.resolve({ name });
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
