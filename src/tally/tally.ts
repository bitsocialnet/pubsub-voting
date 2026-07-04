import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import type { Criteria } from "../schema/criteria.js";
import type { VotesBundle } from "../schema/votes.js";
import type { RuleRegistry } from "../rules/types.js";
import type { ChainClient, BucketMath } from "../chain/types.js";
import { tickerForRef } from "../chain/ticker.js";
import { UnknownRuleError } from "../errors.js";
import type { Tally, TallyOptions, ContestTally, BoardTally } from "./types.js";

/**
 * Deterministic per-contest aggregation over the CRDT's current (already validity-gated)
 * bundles. Because the forward-gate verified signature + gate (`rule`) + name before any
 * bundle was stored, the tally never re-does that work: it only sums *weight magnitude*
 * per board and orders the rows. In v1 the weight rule is `constant`, so this does
 * ZERO chain reads (see DESIGN.md "Tally"). The reserved balance-derived weight path
 * (`erc20-balance`) is where the lazy ceiling/floor early-stop would live; v1 has a trivial
 * `1` ceiling per vote, so the common case simply sums.
 *
 * Rows are keyed by `board.publicKey`, so votes carrying different (but registry-verified)
 * names for the same key fold into one row. Ties are broken by the rolling seed
 * `sha256(bucketBlockHash ‖ publicKey)` — ungrindable because a future block hash cannot be
 * predicted — and the one block-hash read happens only when an actual tie must be broken.
 */

export interface TallyDeps {
    criteria: Criteria;
    registry: RuleRegistry;
    chainFor: (ticker: string) => ChainClient;
    bucketMath: BucketMath;
    /** The CRDT's current bundles (one per wallet, LWW-resolved); empty-votes bundles are withdrawals. */
    current: () => VotesBundle[];
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

    /** The rolling tie seed for a board: sha256(bucketBlockHash ‖ publicKey bytes). */
    const tieSeed = async (blockHash: Uint8Array, publicKey: string): Promise<Uint8Array> => {
        const pkBytes = base58btc.decode(`z${publicKey}`);
        const buf = new Uint8Array(blockHash.length + pkBytes.length);
        buf.set(blockHash, 0);
        buf.set(pkBytes, blockHash.length);
        return (await sha256.digest(buf)).digest;
    };

    return {
        async compute(_options?: TallyOptions): Promise<ContestTally> {
            // Aggregate weight per board.publicKey; fold registry-verified names into one row.
            const rows = new Map<string, { name?: string; weight: bigint }>();
            for (const bundle of current()) {
                if (bundle.votes.length === 0) continue; // withdrawal — expresses no vote
                const w = await weightFor(bundle.address, bundle.blockNumber);
                for (const v of bundle.votes) {
                    const pk = v.board.publicKey;
                    const row = rows.get(pk) ?? { weight: 0n };
                    row.weight += w;
                    if (!row.name && v.board.name) row.name = v.board.name;
                    rows.set(pk, row);
                }
            }

            const list: BoardTally[] = [...rows.entries()].map(([publicKey, row]) => ({
                board: row.name ? { name: row.name, publicKey } : { publicKey },
                weight: row.weight,
                verified: true // every contributing bundle was validity-gated before storage
            }));

            // Order by weight desc. Only if two rows tie on weight do we read the boundary
            // block hash and order those by the ungrindable rolling seed.
            const hasTie = new Set(list.map((r) => r.weight)).size !== list.length;
            if (!hasTie) {
                list.sort((a, b) => (a.weight < b.weight ? 1 : a.weight > b.weight ? -1 : 0));
                return { contest: criteria.contest, ranking: list };
            }

            const blockHash = await bucketBlockHash();
            const seeds = new Map<string, Uint8Array>();
            for (const r of list) seeds.set(r.board.publicKey, await tieSeed(blockHash, r.board.publicKey));
            list.sort((a, b) => {
                if (a.weight !== b.weight) return a.weight < b.weight ? 1 : -1;
                return compareBytes(seeds.get(a.board.publicKey)!, seeds.get(b.board.publicKey)!);
            });
            return { contest: criteria.contest, ranking: list };
        }
    };
}
