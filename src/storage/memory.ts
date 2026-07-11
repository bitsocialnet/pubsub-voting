import type { LruStorage, VoteStorage } from "./types.js";

/**
 * The `dataPath: false` backend on both platforms (pkc-js's `noData` equivalent): a true-LRU
 * `Map` — a `get` hit re-inserts the key so insertion order IS recency order, and eviction
 * deletes the oldest key past `maxItems`. Nothing survives the process; semantics otherwise
 * match the persistent backends so tests and no-disk hosts exercise the same code paths.
 */
export function makeMemoryLruStorage(maxItems: number): LruStorage {
    const entries = new Map<string, unknown>();
    const touch = (key: string, value: unknown): void => {
        entries.delete(key);
        entries.set(key, value);
    };
    return {
        async getItem(key) {
            if (!entries.has(key)) return undefined;
            const value = entries.get(key);
            touch(key, value);
            return value;
        },
        async setItem(key, value) {
            touch(key, value);
            if (entries.size > maxItems) {
                const oldest = entries.keys().next().value;
                if (oldest !== undefined) entries.delete(oldest);
            }
        },
        async removeItem(key) {
            entries.delete(key);
        },
        async keys() {
            return [...entries.keys()];
        },
        async clear() {
            entries.clear();
        }
    };
}

/** An all-in-memory {@link VoteStorage}; `destroy()` only drops the references. */
export function makeMemoryStorage(): VoteStorage {
    const stores = new Map<string, LruStorage>();
    return {
        openLru({ cacheName, maxItems }) {
            let store = stores.get(cacheName);
            if (!store) {
                store = makeMemoryLruStorage(maxItems);
                stores.set(cacheName, store);
            }
            return store;
        },
        async destroy() {
            stores.clear();
        }
    };
}
