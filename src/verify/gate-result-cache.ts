import type { LruStorage } from "../storage/types.js";

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
 *
 * `get` is async because the cache may be backed by the voter's persistent store (sqlite /
 * IndexedDB — see {@link makePersistentGateResultCache}); `set` returns immediately and lets any
 * persistence settle in the background, so the verify hot path never waits on a cache write.
 *
 * This is the per-CID verdict cache's complement: the verdict cache dedupes *re-announcements of the
 * same bundle*; this dedupes *distinct bundles that share a `(wallet, bucket)` gate result*.
 */
export interface GateResultCache {
    /** The memoized gate score for `(wallet, sampleBlock)`, or `undefined` if not yet read. */
    get(wallet: string, sampleBlock: number): Promise<bigint | undefined>;
    /** Memoize `(wallet, sampleBlock) -> score` (idempotent; evicts oldest past the cap). */
    set(wallet: string, sampleBlock: number, score: bigint): void;
}

const memKeyFor = (wallet: string, sampleBlock: number) => `${wallet.toLowerCase()}:${sampleBlock}`;

/**
 * An in-memory {@link GateResultCache} bounded to `maxEntries` with FIFO eviction. Eviction is
 * safe because a score is deterministic — an evicted entry only ever costs a re-read, never a
 * wrong answer; without a bound, a flood of fresh wallets is a memory-exhaustion vector (see
 * DESIGN.md "Can valid votes clog the topic?").
 */
export function makeGateResultCache(maxEntries = 4096): GateResultCache {
    const byKey = new Map<string, bigint>();
    const order: string[] = [];
    return {
        get: async (wallet, sampleBlock) => byKey.get(memKeyFor(wallet, sampleBlock)),
        set: (wallet, sampleBlock, score) => {
            const k = memKeyFor(wallet, sampleBlock);
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

/** The persistent gate store's key. `ruleHash` disambiguates: the shared store spans every
 * contest on the voter, and one wallet can hold different scores under different gate rules
 * (or the same rule at different chainIds). Same score under the same rule is what lets two
 * contests over one gate (a 5chan-style directory) share each other's reads. */
const storeKeyFor = (ruleHash: string, wallet: string, sampleBlock: number) =>
    `${ruleHash}:${wallet.toLowerCase()}:${sampleBlock}`;

/**
 * A {@link GateResultCache} layered over the voter's persistent store: an in-memory FIFO front
 * (the hot path — steady-state gossip hits it synchronously) with read-through to the store on
 * a miss and fire-and-forget write-through on `set`. Scores travel as decimal strings (JSON has
 * no bigint). A broken store read or write degrades to a live chain read — never an error into
 * the verify pipeline — because everything here is a pure function of pinned historical state.
 */
export function makePersistentGateResultCache(opts: {
    store: LruStorage;
    /** Identifies the gate rule (hash of the canonical criteria `rule` + chainId — see voter.ts). */
    ruleHash: string;
    maxMemEntries?: number;
}): GateResultCache {
    const { store, ruleHash } = opts;
    const mem = makeGateResultCache(opts.maxMemEntries);
    return {
        async get(wallet, sampleBlock) {
            const cached = await mem.get(wallet, sampleBlock);
            if (cached !== undefined) return cached;
            let persisted: unknown;
            try {
                persisted = await store.getItem(storeKeyFor(ruleHash, wallet, sampleBlock));
            } catch {
                return undefined;
            }
            if (typeof persisted !== "string" || !/^\d+$/.test(persisted)) return undefined;
            const score = BigInt(persisted);
            mem.set(wallet, sampleBlock, score);
            return score;
        },
        set(wallet, sampleBlock, score) {
            mem.set(wallet, sampleBlock, score);
            void store.setItem(storeKeyFor(ruleHash, wallet, sampleBlock), score.toString()).catch(() => {
                // a failed persist costs a future re-read, never a wrong answer
            });
        }
    };
}

/**
 * Deterministic expiry purge for one rule's persisted gate results — better than LRU here
 * because staleness is *provable*: a score at bucket B's sample block is only ever consulted
 * while bundles from B are admissible (within `voteExpiryBuckets` of head), so anything older
 * than the oldest admissible sample block can never be read again. Run per contest join, after
 * the first head read; the store's LRU bound stays as the backstop for rules never purged.
 */
export async function purgeExpiredGateResults(opts: {
    store: LruStorage;
    ruleHash: string;
    /** The oldest admissible bucket's sample block; strictly older entries are dead. */
    oldestSampleBlock: number;
}): Promise<void> {
    const prefix = `${opts.ruleHash}:`;
    try {
        for (const key of await opts.store.keys()) {
            if (!key.startsWith(prefix)) continue;
            const sampleBlock = Number(key.slice(key.lastIndexOf(":") + 1));
            if (Number.isFinite(sampleBlock) && sampleBlock < opts.oldestSampleBlock) {
                await opts.store.removeItem(key);
            }
        }
    } catch {
        // purge is best-effort; the store's LRU bound is the correctness-free backstop
    }
}
