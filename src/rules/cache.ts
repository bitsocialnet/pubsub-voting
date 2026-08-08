import type { LruStorage } from "../storage/types.js";

/**
 * The cache a rule computes through.
 *
 * A rule decides *what* it reads and *when* the answer stops being true; the library decides
 * where that answer is stored, how it is bounded, and how it is shared. This seam is that split.
 * It exists because cache validity is the thing that genuinely differs between rules and cannot
 * be expressed generically:
 *
 *   - a score read at a pinned historical block is true forever, so it should never expire;
 *   - a score read at the chain head stops being true almost immediately — a wallet that failed
 *     a moment ago may hold the gate asset now — so it must expire, and how fast is a judgement
 *     only the rule can make;
 *   - some reads are not per-wallet at all (`erc5192-min-balance` probes `supportsInterface`
 *     once per contract), which no per-wallet key can express.
 *
 * The library still owns the mechanics, because they are not rule-specific and are easy to get
 * wrong: persistence under the voter's `dataPath`, the bounded in-memory front, and the
 * namespace. Every rule instance gets its own keyspace, namespaced by the rule's `type`, its
 * canonical options and the chain id — so two contests running the same gate share each other's
 * reads (a 5chan-style directory of 63 boards on one Pass is one read per wallet, not 63), while
 * two different gates, or the same gate on a different contract, can never collide.
 *
 * **Caching is not optional for a chain-reading rule.** It is what bounds the "one chain read per
 * unique bundle" amplifier: without it, an ineligible wallet can mint fresh-signed bundles and
 * make every peer on the topic pay an RPC round trip for each one (DESIGN.md "Can valid votes
 * clog the topic?"). {@link RuleCache.memoMany} exists so the correct behaviour is one call.
 *
 * Values are strings because the persistent tier is JSON-backed — a `bigint` score travels as a
 * decimal string, a boolean as `"1"`/`"0"`.
 */
export interface RuleCache {
    /** The memoized value for `key` within `epoch`, or `{ value: undefined }` on a miss. */
    get(args: { key: string; epoch: number }): Promise<{ value: string | undefined }>;
    /**
     * Memoize `value` for `key` within `epoch`. Idempotent: an existing entry is never
     * overwritten, so a score cannot be silently replaced under a key that still applies.
     * Returns immediately — any persistence settles in the background, so the verify hot path
     * never waits on a cache write.
     */
    set(args: { key: string; epoch: number; value: string }): void;
    /**
     * Look up many keys at once and read only the misses — the batched path a rule should use
     * for a cold join's wallets, where `read` becomes one multicall instead of N round trips.
     * `read` is called at most once, with the missing keys in order, and MUST return one value
     * per key it was given. Skipped entirely when everything hits.
     */
    memoMany(args: {
        keys: string[];
        epoch: number;
        read: (args: { keys: string[] }) => Promise<{ values: string[] }>;
    }): Promise<{ values: string[] }>;
    /**
     * Drop persisted entries below `epoch` — the rule's own statement that they are dead.
     *
     * This is on the rule because only the rule knows what an epoch means. A rule keying by the
     * chain head knows everything behind the current window is unreachable; a rule keying by a
     * bundle's pinned block knows nothing expires until the vote itself does. Optionally
     * restricted to keys starting with `keyPrefix`, so a rule that mixes both — as the v1 gate
     * does — can purge its head-keyed entries without touching its permanently-valid ones.
     *
     * Best-effort and fire-and-forget: the store's LRU bound is the backstop for a rule that
     * never calls it. Repeat calls at or below the last purged epoch are free.
     */
    purgeBelow(args: { epoch: number; keyPrefix?: string }): void;
}

/** `${key}:${epoch}` — the epoch trails, so a purge can parse it back off the end. */
const entryKey = (key: string, epoch: number): string => `${key}:${epoch}`;

/**
 * An in-memory {@link RuleCache}, FIFO-bounded. Used on its own by unit tests and as the hot
 * front of the persistent cache. Eviction is safe: an evicted entry costs a re-read, never a
 * wrong answer — and without a bound, a flood of fresh wallets would be a memory-exhaustion
 * vector (DESIGN.md "Can valid votes clog the topic?").
 */
export function makeMemoryRuleCache(args: { maxEntries?: number } = {}): RuleCache {
    const maxEntries = args.maxEntries ?? 4096;
    const byKey = new Map<string, string>();
    const order: string[] = [];
    const cache: RuleCache = {
        async get({ key, epoch }) {
            return { value: byKey.get(entryKey(key, epoch)) };
        },
        set({ key, epoch, value }) {
            const k = entryKey(key, epoch);
            if (byKey.has(k)) return; // idempotent: never refresh position or overwrite
            byKey.set(k, value);
            order.push(k);
            if (order.length > maxEntries) {
                const evicted = order.shift();
                if (evicted !== undefined) byKey.delete(evicted);
            }
        },
        memoMany: (memoArgs) => memoManyOver(cache, memoArgs),
        purgeBelow({ epoch, keyPrefix }) {
            for (const k of [...byKey.keys()]) {
                if (keyPrefix !== undefined && !k.startsWith(keyPrefix)) continue;
                const at = Number(k.slice(k.lastIndexOf(":") + 1));
                if (Number.isFinite(at) && at < epoch) {
                    byKey.delete(k);
                    const i = order.indexOf(k);
                    if (i >= 0) order.splice(i, 1);
                }
            }
        }
    };
    return cache;
}

/**
 * A {@link RuleCache} over the voter's persistent store: the in-memory FIFO front above, with
 * read-through on a miss and fire-and-forget write-through. A broken store read or write
 * degrades to a live chain read — never an error into the verify pipeline.
 *
 * `namespace` is the rule's keyspace (see {@link RuleCache}); the voter derives it from the
 * canonical rule reference + chain id.
 */
export function makePersistentRuleCache(args: { store: LruStorage; namespace: string; maxMemEntries?: number }): RuleCache {
    const { store, namespace } = args;
    const mem = makeMemoryRuleCache(args.maxMemEntries === undefined ? {} : { maxEntries: args.maxMemEntries });
    const storeKey = (key: string, epoch: number): string => `${namespace}:${entryKey(key, epoch)}`;
    /** The highest epoch already purged per prefix, so a steady head costs no key scan. */
    const purged = new Map<string, number>();
    const cache: RuleCache = {
        async get({ key, epoch }) {
            const hit = await mem.get({ key, epoch });
            if (hit.value !== undefined) return hit;
            let persisted: unknown;
            try {
                persisted = await store.getItem(storeKey(key, epoch));
            } catch {
                return { value: undefined };
            }
            if (typeof persisted !== "string") return { value: undefined };
            mem.set({ key, epoch, value: persisted });
            return { value: persisted };
        },
        set({ key, epoch, value }) {
            mem.set({ key, epoch, value });
            void store.setItem(storeKey(key, epoch), value).catch(() => {
                // a failed persist costs a future re-read, never a wrong answer
            });
        },
        memoMany: (memoArgs) => memoManyOver(cache, memoArgs),
        purgeBelow({ epoch, keyPrefix }) {
            const prefix = `${namespace}:${keyPrefix ?? ""}`;
            if ((purged.get(prefix) ?? 0) >= epoch) return;
            purged.set(prefix, epoch);
            mem.purgeBelow(keyPrefix === undefined ? { epoch } : { epoch, keyPrefix });
            void (async () => {
                try {
                    for (const key of await store.keys()) {
                        if (!key.startsWith(prefix)) continue;
                        const at = Number(key.slice(key.lastIndexOf(":") + 1));
                        if (Number.isFinite(at) && at < epoch) await store.removeItem(key);
                    }
                } catch {
                    // purge is best-effort; the store's LRU bound is the correctness-free backstop
                }
            })();
        }
    };
    return cache;
}

/** The shared {@link RuleCache.memoMany} body: read the misses once, in order, then memoize. */
async function memoManyOver(
    cache: RuleCache,
    args: { keys: string[]; epoch: number; read: (args: { keys: string[] }) => Promise<{ values: string[] }> }
): Promise<{ values: string[] }> {
    const { keys, epoch, read } = args;
    const values = new Array<string | undefined>(keys.length);
    const missing: string[] = [];
    const missingAt: number[][] = [];
    const seen = new Map<string, number>();
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const already = seen.get(key);
        if (already !== undefined) {
            missingAt[already]?.push(i); // a duplicate key is read once, not twice
            continue;
        }
        const { value } = await cache.get({ key, epoch });
        if (value !== undefined) {
            values[i] = value;
            continue;
        }
        seen.set(key, missing.length);
        missingAt.push([i]);
        missing.push(key);
    }
    if (missing.length > 0) {
        const read_ = await read({ keys: missing });
        if (read_.values.length !== missing.length) {
            throw new Error(`RuleCache.memoMany: read returned ${read_.values.length} values for ${missing.length} keys`);
        }
        missing.forEach((key, i) => {
            const value = read_.values[i]!;
            cache.set({ key, epoch, value });
            for (const at of missingAt[i]!) values[at] = value;
        });
    }
    return { values: values.map((value) => value!) };
}
