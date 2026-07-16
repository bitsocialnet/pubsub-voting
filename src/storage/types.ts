/**
 * The persistent-cache seam, mirroring pkc-js's LRU storage tier (`LRUStorageInterface` /
 * `_createStorageLRU`): named, bounded, LRU-evicting key-value stores under the voter's data
 * path. On Node the backing is one better-sqlite3 database per cache under
 * `{dataPath}/lru-storage/` (storage/node.ts); in the browser it is localforage (IndexedDB)
 * with pkc-js's dual-instance round-robin eviction (storage/browser.ts — bundlers swap the
 * module via the package.json `browser` field remap); `dataPath: false` selects the in-memory
 * backend on both (storage/memory.ts). Values must be JSON-serializable — callers stringify
 * anything richer (a gate score `bigint` travels as a decimal string).
 *
 * Deliberate deviation from pkc-js's interface: no explicit `init()` — every store
 * self-initializes lazily on first use, so opening a store is synchronous and cheap and the
 * voter constructor stays non-async.
 */
export interface LruStorage {
    /** The stored value, or `undefined` on a miss. A hit refreshes the entry's LRU position. */
    getItem(key: string): Promise<unknown>;
    /** Insert or replace. May evict the least-recently-used entry past the store's `maxItems`. */
    setItem(key: string, value: unknown): Promise<void>;
    removeItem(key: string): Promise<void>;
    /** Every live key (unordered). Used for the gate store's deterministic expiry purge. */
    keys(): Promise<string[]>;
    clear(): Promise<void>;
}

/** One voter's persistent-cache root: opens named LRU stores, closed as a unit on `destroy()`. */
export interface VoteStorage {
    /**
     * Open (or return the already-open) named store. Names are fixed library-internal slugs
     * (`gate-results`, `name-resolutions`), never user input.
     */
    openLru(opts: { cacheName: string; maxItems: number }): LruStorage;
    /** Close every open store (Node: close the sqlite handles). Terminal, like `PubsubVoter.destroy`. */
    destroy(): Promise<void>;
}

/**
 * `PubsubVoterOptions.dataPath`, resolved: a directory for persistent caches, or `false` for
 * in-memory-only (no disk, no IndexedDB — the pkc-js `noData` equivalent). `undefined` picks
 * the platform default: `{cwd}/.bitsocial-pubsub-voting` on Node, named IndexedDB databases in
 * the browser (where a path is meaningless and ignored).
 */
export interface StorageOptions {
    dataPath?: string | false | undefined;
}
