import type { LruStorage, SnapshotStorage, VoteStorage } from "./types.js";

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

/** The `dataPath: false` snapshot store: a plain `Map`, no eviction (see types.ts). */
export function makeMemorySnapshotStorage(): SnapshotStorage {
    const blobs = new Map<string, Uint8Array>();
    return {
        async get(key) {
            return blobs.get(key);
        },
        async set(key, bytes) {
            blobs.set(key, bytes);
        },
        async remove(key) {
            blobs.delete(key);
        }
    };
}

/** An all-in-memory {@link VoteStorage}; `destroy()` only drops the references. */
export function makeMemoryStorage(): VoteStorage {
    const stores = new Map<string, LruStorage>();
    let snapshots: SnapshotStorage | undefined;
    return {
        openLru({ cacheName, maxItems }) {
            let store = stores.get(cacheName);
            if (!store) {
                store = makeMemoryLruStorage(maxItems);
                stores.set(cacheName, store);
            }
            return store;
        },
        openSnapshots() {
            return (snapshots ??= makeMemorySnapshotStorage());
        },
        async destroy() {
            stores.clear();
            snapshots = undefined;
        }
    };
}
