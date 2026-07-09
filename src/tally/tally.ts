import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import type { Criteria } from "../schema/criteria.js";
import type { VotesBundle } from "../schema/votes.js";
import type { RuleRegistry } from "../rules/types.js";
import type { ChainClient, BucketMath } from "../chain/types.js";
import type { BundleChecks } from "../verify/types.js";
import { tickerForRef } from "../chain/ticker.js";
import { UnknownRuleError } from "../errors.js";
import type { Tally, ContestTally, CommunityTally } from "./types.js";

/**
 * Deterministic per-contest aggregation over the CRDT's current bundles. Every aggregated
 * bundle passed the synchronous offline checks (signature, constraints) at admission; each
 * entry's {@link BundleChecks} says where its two deferred NETWORK checks stand (the on-chain
 * gate read and name resolution — run inline by the forward-gate for live gossip, in the
 * background chain verifier for cold-join admits). The tally never re-does verification: it
 * sums *weight magnitude* per community, folds each entry's check state into the row's
 * `chainVerified` / `nameResolved` flags, and orders the rows. In v1 the weight rule is
 * `constant`, so this does ZERO chain reads (see DESIGN.md "Tally"). The reserved
 * balance-derived weight path (`erc20-balance`) is where the lazy ceiling/floor early-stop
 * would live; v1 has a trivial `1` ceiling per vote, so the common case simply sums.
 *
 * Rows are keyed by `community.publicKey`, so votes carrying different names for the same key
 * fold into one row. Ties are broken by the rolling seed `sha256(bucketBlockHash ‖ publicKey)`
 * — ungrindable because a future block hash cannot be predicted — and the one block-hash read
 * happens only when an actual tie must be broken.
 */

export interface TallyDeps {
    criteria: Criteria;
    registry: RuleRegistry;
    chainFor: (ticker: string) => ChainClient;
    bucketMath: BucketMath;
    /**
     * The CRDT's current bundles (one per wallet, LWW-resolved; empty-votes bundles are
     * withdrawals), each with its deferred-check state (see verify/types.ts `BundleChecks`).
     */
    current: () => Array<{ bundle: VotesBundle; checks: BundleChecks }>;
    /**
     * Hash of the current bucket boundary block on the criteria's chain, for the rolling tie
     * seed. Invoked at most once per `compute`, and only when a tie must actually be broken —
     * so a tie-free tally still does no extra read.
     */
    bucketBlockHash: () => Promise<Uint8Array>;
}

/** Byte-lexicographic compare of two byte arrays (returns <0, 0, >0). */
function compareBytes(x: Uint8Array, y: Uint8Array): number {
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
        const xi = x[i]!;
        const yi = y[i]!;
        if (xi !== yi) return xi - yi;
    }
    return x.length - y.length;
}

export function makeTally(deps: TallyDeps): Tally {
    const { criteria, registry, chainFor, bucketMath, current, bucketBlockHash } = deps;

    // Resolve the weight rule, its options, and its chain once (see verify/bundle.ts).
    const weight = registry[criteria.weight.type];
    if (!weight) throw new UnknownRuleError("weight", criteria.weight.type);
    const weightOptions = weight.optionsSchema.parse(criteria.weight);
    const weightChain = chainFor(tickerForRef(criteria, criteria.weight, weightOptions));

    const weightFor = async (wallet: string, blockNumber: number): Promise<bigint> => {
        const sampleBlock = bucketMath.sampleBlockForBucket(bucketMath.bucketForBlock(blockNumber));
        const { score } = await weight.evaluate({
            options: weightOptions,
            walletAddress: wallet,
            ctx: { chain: weightChain, blockNumber: sampleBlock }
        });
        return score;
    };

    /** The rolling tie seed for a community: sha256(bucketBlockHash ‖ publicKey bytes). */
    const tieSeed = async (blockHash: Uint8Array, publicKey: string): Promise<Uint8Array> => {
        const pkBytes = base58btc.decode(`z${publicKey}`);
        const buf = new Uint8Array(blockHash.length + pkBytes.length);
        buf.set(blockHash, 0);
        buf.set(pkBytes, blockHash.length);
        return (await sha256.digest(buf)).digest;
    };

    return {
        async compute(): Promise<ContestTally> {
            // Aggregate weight per community.publicKey, folding each contribution's deferred-check
            // state into the row: `chainVerified` only once EVERY contributing bundle's gate read
            // confirmed, and the shown name prefers (and reports) a registry-resolved one.
            const rows = new Map<string, { name?: string; nameResolved?: boolean; weight: bigint; chainVerified: boolean }>();
            for (const { bundle, checks } of current()) {
                if (bundle.votes.length === 0) continue; // withdrawal — expresses no vote
                const w = await weightFor(bundle.address, bundle.blockNumber);
                for (const v of bundle.votes) {
                    const pk = v.community.publicKey;
                    const row = rows.get(pk) ?? { weight: 0n, chainVerified: true };
                    row.weight += w;
                    row.chainVerified &&= checks.chainVerified;
                    // Prefer a resolved name over a still-pending one; never downgrade to pending.
                    if (v.community.name && row.nameResolved !== true) {
                        row.name = v.community.name;
                        row.nameResolved = checks.nameResolved === true;
                    }
                    rows.set(pk, row);
                }
            }

            const list: CommunityTally[] = [...rows.entries()].map(([publicKey, row]) => ({
                community: row.name ? { name: row.name, publicKey } : { publicKey },
                weight: row.weight,
                chainVerified: row.chainVerified,
                ...(row.name ? { nameResolved: row.nameResolved } : {})
            }));

            // Order by weight desc. Only if two rows tie on weight do we read the boundary
            // block hash and order those by the ungrindable rolling seed.
            const hasTie = new Set(list.map((r) => r.weight)).size !== list.length;
            if (!hasTie) {
                list.sort((a, b) => (a.weight < b.weight ? 1 : a.weight > b.weight ? -1 : 0));
                return { contestId: criteria.contestId, ranking: list };
            }

            const blockHash = await bucketBlockHash();
            const seeds = new Map<string, Uint8Array>();
            for (const r of list) seeds.set(r.community.publicKey, await tieSeed(blockHash, r.community.publicKey));
            list.sort((a, b) => {
                if (a.weight !== b.weight) return a.weight < b.weight ? 1 : -1;
                return compareBytes(seeds.get(a.community.publicKey)!, seeds.get(b.community.publicKey)!);
            });
            return { contestId: criteria.contestId, ranking: list };
        }
    };
}
