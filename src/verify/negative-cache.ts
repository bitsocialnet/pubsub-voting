/**
 * A bounded negative cache for gate `rule` misses, keyed by `(wallet, sampleBlock)`.
 *
 * When the gate scores a wallet `0n` at a bucket's sample block, that verdict is a pure
 * function of *historical* chain state — a past, pinned block that never changes — so a novel
 * bundle CID from the same wallet at the same sample block can be rejected without repeating
 * the chain read. This bounds the "one gate read per unique bundle" RPC amplifier (see
 * DESIGN.md "Transport", resource-exhaustion residual): an attacker minting fresh-signed
 * bundles from one ineligible wallet pays a single chain read per bucket, not one per bundle.
 *
 * Keyed on `(wallet, sampleBlock)` — NOT wallet alone — so a wallet that *acquires* the gated
 * asset in a later bucket is re-read at that bucket's sample block rather than being
 * permanently blackholed by a stale miss. Bounded by a max entry count with FIFO eviction;
 * entries for old buckets fall out naturally as newer ones are recorded.
 *
 * This is a per-CID verdict cache's complement: the verdict cache dedupes *re-announcements of
 * the same bundle*; this dedupes *distinct bundles that share an ineligible (wallet, bucket)*.
 */
export interface GateNegativeCache {
    /** Has `(wallet, sampleBlock)` already been recorded as a gate miss? */
    has(wallet: string, sampleBlock: number): boolean;
    /** Record `(wallet, sampleBlock)` as a gate miss (idempotent; evicts oldest past the cap). */
    add(wallet: string, sampleBlock: number): void;
}

/** An in-memory {@link GateNegativeCache} bounded to `maxEntries` with FIFO eviction. */
export function makeGateNegativeCache(maxEntries = 4096): GateNegativeCache {
    const keys = new Set<string>();
    const order: string[] = [];
    const keyFor = (wallet: string, sampleBlock: number) => `${wallet.toLowerCase()}:${sampleBlock}`;
    return {
        has: (wallet, sampleBlock) => keys.has(keyFor(wallet, sampleBlock)),
        add: (wallet, sampleBlock) => {
            const k = keyFor(wallet, sampleBlock);
            if (keys.has(k)) return;
            keys.add(k);
            order.push(k);
            if (order.length > maxEntries) {
                const evicted = order.shift();
                if (evicted !== undefined) keys.delete(evicted);
            }
        }
    };
}
