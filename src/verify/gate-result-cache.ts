/**
 * A bounded cache of gate `rule` results, keyed by `(wallet, sampleBlock)`.
 *
 * The gate score is a pure function of *historical* chain state — a past, pinned block that never
 * changes — so a novel bundle CID from the same wallet at the same sample block scores identically
 * and need not repeat the chain read. Memoizing the score (a `bigint`, where `0n` is the "not
 * admitted" case) bounds the "one gate read per unique bundle" RPC amplifier (see DESIGN.md
 * "Transport", resource-exhaustion residual) for BOTH directions:
 *
 *   - an ineligible wallet minting fresh-signed bundles pays a single chain read per bucket, not
 *     one per bundle (the `0n` case — the former negative cache); and
 *   - an *eligible* wallet re-signing / cycling vote choices within a bucket likewise pays one read
 *     per bucket, not one per fresh CID (the `> 0n` case).
 *
 * Keyed on `(wallet, sampleBlock)` — NOT wallet alone — so a wallet whose holding *changes* in a
 * later bucket is re-read at that bucket's sample block rather than being pinned to a stale score.
 * Bounded by a max entry count with FIFO eviction; entries for old buckets fall out naturally as
 * newer ones are recorded.
 *
 * This is the per-CID verdict cache's complement: the verdict cache dedupes *re-announcements of the
 * same bundle*; this dedupes *distinct bundles that share a `(wallet, bucket)` gate result*.
 */
export interface GateResultCache {
    /** The memoized gate score for `(wallet, sampleBlock)`, or `undefined` if not yet read. */
    get(wallet: string, sampleBlock: number): bigint | undefined;
    /** Memoize `(wallet, sampleBlock) -> score` (idempotent; evicts oldest past the cap). */
    set(wallet: string, sampleBlock: number, score: bigint): void;
}

/** An in-memory {@link GateResultCache} bounded to `maxEntries` with FIFO eviction. */
export function makeGateResultCache(maxEntries = 4096): GateResultCache {
    const byKey = new Map<string, bigint>();
    const order: string[] = [];
    const keyFor = (wallet: string, sampleBlock: number) => `${wallet.toLowerCase()}:${sampleBlock}`;
    return {
        get: (wallet, sampleBlock) => byKey.get(keyFor(wallet, sampleBlock)),
        set: (wallet, sampleBlock, score) => {
            const k = keyFor(wallet, sampleBlock);
            if (byKey.has(k)) return; // idempotent: never refresh position or overwrite a pinned score
            byKey.set(k, score);
            order.push(k);
            if (order.length > maxEntries) {
                const evicted = order.shift();
                if (evicted !== undefined) byKey.delete(evicted);
            }
        }
    };
}
