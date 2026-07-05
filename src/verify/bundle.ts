import type { VotesBundle } from "../schema/votes.js";
import type { Criteria } from "../schema/criteria.js";
import type { RuleRegistry } from "../rules/types.js";
import type { ChainClient, BucketMath, NameResolver } from "../chain/types.js";
import { tickerForRef } from "../chain/ticker.js";
import { UnknownRuleError } from "../errors.js";
import { verifyBundleSignature } from "./signature.js";
import { checkBundleConstraints } from "./constraints.js";
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
 *   4. name        (network):   each vote's `board.name` (if any) must resolve to the
 *                               claimed `publicKey`; a squatted/absent name drops the bundle.
 *
 * Every step only ever SUBTRACTS trust (a bundle is valid or dropped), which is what lets the
 * gate reject without forwarding. Weight *magnitude* is not computed here — it is a ranking
 * concern the tally derives lazily, not a validity concern (see DESIGN.md "Tally").
 *
 * Expiry is deliberately out of scope here: it depends on the current bucket (a clock), so it
 * is enforced by the CRDT's read-time filter (`current`/`winnerCids` drop decayed votes given the
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
    /** Host-injected board-name resolvers (`PubsubVoterOptions.nameResolvers`). */
    nameResolvers: NameResolver[];
}

export function makeBundleVerifier(deps: BundleVerifierDeps): BundleVerifier {
    const { criteria, criteriaCid, chainId, registry, chainFor, bucketMath, nameResolvers } = deps;

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

            // 3. Gate (chain) — read the `rule` at the bucket's sample block.
            const sampleBlock = bucketMath.sampleBlockForBucket(bucketMath.bucketForBlock(bundle.blockNumber));
            const { score } = await rule.evaluate({
                options: ruleOptions,
                walletAddress: bundle.address,
                ctx: { chain: ruleChain, blockNumber: sampleBlock }
            });
            if (score === 0n) {
                return { valid: false, reason: `not admitted: rule score is 0n at block ${sampleBlock}` };
            }

            // 4. Board-name resolution (network) — a carried name is a claim, verified against
            //    the registry. A name that has no resolver, does not resolve, or resolves to a
            //    different publicKey than the vote claims drops the whole bundle.
            const resolvedNames: Record<string, string> = {};
            for (const v of bundle.votes) {
                const name = v.board.name;
                if (!name) continue;
                const resolver = nameResolvers.find((r) => r.canResolve({ name }));
                if (!resolver) return { valid: false, reason: `no resolver handles board name "${name}"` };
                const record = await resolver.resolve({ name });
                if (!record) return { valid: false, reason: `board name "${name}" does not resolve` };
                if (record.publicKey !== v.board.publicKey) {
                    return {
                        valid: false,
                        reason: `board name "${name}" resolves to ${record.publicKey}, not the claimed ${v.board.publicKey}`
                    };
                }
                resolvedNames[name] = record.publicKey;
            }

            return { valid: true, ruleScore: score, resolvedNames };
        }
    };
}
