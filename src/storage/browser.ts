import localForage from "localforage";
import { makeMemoryStorage } from "./memory.js";
import type { LruStorage, StorageOptions, VoteStorage } from "./types.js";

/**
 * The browser backend, swapped in for storage/node.ts by the package.json `browser` field
 * remap (same mechanism pkc-js uses for its whole runtime tree, scoped here to one module).
 * It is a port of pkc-js's localforage-lru (runtime/browser/localforage-lru.ts): two
 * IndexedDB databases per named cache (`pubsub-votes-{cacheName}` and `…2`) with round-robin
 * eviction — writes fill the active database, and when it reaches `maxItems` the databases
 * swap roles and the new active one is cleared, so at most the oldest half of entries drops
 * at once. A read hit in the inactive database promotes the entry to the active one, which is
 * what makes the scheme approximate LRU rather than plain FIFO.
 *
 * `dataPath` is meaningless in the browser (pkc-js's browser `getDefaultDataPath()` is
 * likewise `undefined`): a string is ignored, `false` still selects the in-memory backend.
 */
class LocalForageLruStorage implements LruStorage {
    readonly #maxItems: number;
    readonly #name: string;
    #initialized:
        | Promise<{
              active: () => LocalForage;
              inactive: () => LocalForage;
              swap: () => Promise<void>;
              grow: () => Promise<void>;
          }>
        | undefined;

    constructor(opts: { cacheName: string; maxItems: number }) {
        this.#name = `pubsub-votes-${opts.cacheName}`;
        this.#maxItems = opts.maxItems;
    }

    #init() {
        this.#initialized ??= (async () => {
            const database1 = localForage.createInstance({ name: this.#name });
            const database2 = localForage.createInstance({ name: `${this.#name}2` });
            const [size1, size2] = await Promise.all([database1.length(), database2.length()]);
            // The largest database is the active one, unless it is full (a full database is
            // always the inactive, about-to-be-dropped half) — pkc-js's exact recovery rule.
            let [active, inactive] =
                (size1 >= size2 && size1 !== this.#maxItems) || size2 === this.#maxItems
                    ? [database1, database2]
                    : [database2, database1];
            let activeSize = await active.length();
            const swap = async () => {
                activeSize = 0;
                [active, inactive] = [inactive, active];
                await active.clear();
            };
            return {
                active: () => active,
                inactive: () => inactive,
                grow: async () => {
                    activeSize += 1;
                    if (activeSize >= this.#maxItems) {
                        // removeItem/clear never decrement the counter, so it only ever
                        // over-counts — reconcile at the threshold so a purge-heavy session
                        // cannot swap (and clear) before the active half is actually full.
                        activeSize = await active.length();
                        if (activeSize >= this.#maxItems) await swap();
                    }
                },
                swap
            };
        })();
        return this.#initialized;
    }

    async getItem(key: string): Promise<unknown> {
        const db = await this.#init();
        const value = await db.active().getItem(key);
        if (value !== null && value !== undefined) return value;
        const older = await db.inactive().getItem(key);
        if (older === null || older === undefined) return undefined;
        await this.setItem(key, older); // promote: a hit in the older half re-enters the active one
        return older;
    }

    async setItem(key: string, value: unknown): Promise<void> {
        const db = await this.#init();
        const existing = await db.active().getItem(key);
        await db.active().setItem(key, value ?? null);
        if (existing === null || existing === undefined) await db.grow();
    }

    async removeItem(key: string): Promise<void> {
        const db = await this.#init();
        await Promise.all([db.active().removeItem(key), db.inactive().removeItem(key)]);
    }

    async keys(): Promise<string[]> {
        const db = await this.#init();
        const [keys1, keys2] = await Promise.all([db.active().keys(), db.inactive().keys()]);
        return [...new Set([...keys1, ...keys2])];
    }

    async clear(): Promise<void> {
        const db = await this.#init();
        await Promise.all([db.active().clear(), db.inactive().clear()]);
    }
}

/** Build the browser {@link VoteStorage}: IndexedDB via localforage, or in-memory for `false`. */
export function makeStorage(options: StorageOptions): VoteStorage {
    if (options.dataPath === false) return makeMemoryStorage();
    const stores = new Map<string, LruStorage>();
    return {
        openLru({ cacheName, maxItems }) {
            let store = stores.get(cacheName);
            if (!store) {
                store = new LocalForageLruStorage({ cacheName, maxItems });
                stores.set(cacheName, store);
            }
            return store;
        },
        // localforage holds no closeable handles; dropping the references is the whole teardown.
        async destroy() {
            stores.clear();
        }
    };
}
