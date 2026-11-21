import localForage from "localforage";
import { makeMemoryStorage } from "./memory.js";
import type { LruStorage, SnapshotStorage, StorageOptions, VoteStorage } from "./types.js";

/** Which database of each round-robin LRU is active, keyed by cache: one small database for all. */
const LRU_ROLES_DATABASE = "pubsub-voting-lru-roles";

/**
 * The browser backend, swapped in for storage/node.ts by the package.json `browser` field
 * remap (same mechanism pkc-js uses for its whole runtime tree, scoped here to one module).
 * It is a port of pkc-js's localforage-lru (runtime/browser/localforage-lru.ts): two
 * IndexedDB databases per named cache (`pubsub-voting-{cacheName}` and `…2`) with round-robin
 * eviction — writes fill the active database, and when it reaches `maxItems` the databases
 * swap roles and the new active one is cleared, so at most the oldest half of entries drops
 * at once. A read hit in the inactive database promotes the entry to the active one, which is
 * what makes the scheme approximate LRU rather than plain FIFO. Unlike pkc-js, each swap also
 * records which database is now active (in {@link LRU_ROLES_DATABASE}), because a reload cannot
 * always infer it from the two sizes.
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
        this.#name = `pubsub-voting-${opts.cacheName}`;
        this.#maxItems = opts.maxItems;
    }

    #init() {
        this.#initialized ??= (async () => {
            const name2 = `${this.#name}2`;
            const database1 = localForage.createInstance({ name: this.#name });
            const database2 = localForage.createInstance({ name: name2 });
            const roles = localForage.createInstance({ name: LRU_ROLES_DATABASE });
            const [size1, size2, marked] = await Promise.all([
                database1.length(),
                database2.length(),
                roles.getItem<string>(this.#name)
            ]);
            // The half the last rotation made active, as `swap` recorded it. Sizes alone cannot
            // tell: the retired half is full right after a swap, but the expiry purge removes keys
            // from both halves, so it can come back below maxItems and still the larger one, and
            // its next fill would then clear the NEWER half. With no record (a cache written
            // before it existed) fall back to pkc-js's recovery rule: the largest database is the
            // active one, unless it is full (a full database is the retired, about-to-drop half).
            const firstActive =
                marked === this.#name || marked === name2
                    ? marked === this.#name
                    : (size1 >= size2 && size1 !== this.#maxItems) || size2 === this.#maxItems;
            let [active, inactive] = firstActive ? [database1, database2] : [database2, database1];
            let activeSize = await active.length();
            const swap = async () => {
                activeSize = 0;
                [active, inactive] = [inactive, active];
                // Record the new role only once its clear has landed: the two databases commit
                // independently, and a record naming a half that still holds the oldest entries
                // would make the next load trust it and clear the NEWER half on its next fill.
                // Interrupted in between, the old record still names the full, newer half.
                await active.clear();
                await roles.setItem(this.#name, active === database1 ? this.#name : name2);
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
                        const half = active;
                        const size = await half.length();
                        // A concurrent grow() swapped while this one was counting: that half is
                        // retired and the counter now belongs to the new one. Swapping again
                        // would flip back and clear the half just retired.
                        if (active !== half) return;
                        activeSize = size;
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

/**
 * The browser checkpoint-snapshot store: a single localforage (IndexedDB) database, no
 * dual-instance eviction — a snapshot must never be evicted (see types.ts). localforage
 * round-trips typed arrays natively under its IndexedDB driver; an `ArrayBuffer` coming
 * back from an older driver is re-wrapped.
 */
class LocalForageSnapshotStorage implements SnapshotStorage {
    #db: LocalForage | undefined;

    #init(): LocalForage {
        return (this.#db ??= localForage.createInstance({ name: "pubsub-voting-checkpoints" }));
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        const value = await this.#init().getItem<unknown>(key);
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        return undefined;
    }

    async set(key: string, bytes: Uint8Array): Promise<void> {
        await this.#init().setItem(key, bytes);
    }

    async remove(key: string): Promise<void> {
        await this.#init().removeItem(key);
    }
}

/** Build the browser {@link VoteStorage}: IndexedDB via localforage, or in-memory for `false`. */
export function makeStorage(options: StorageOptions): VoteStorage {
    if (options.dataPath === false) return makeMemoryStorage();
    const stores = new Map<string, LruStorage>();
    let snapshots: SnapshotStorage | undefined;
    return {
        openLru({ cacheName, maxItems }) {
            let store = stores.get(cacheName);
            if (!store) {
                store = new LocalForageLruStorage({ cacheName, maxItems });
                stores.set(cacheName, store);
            }
            return store;
        },
        openSnapshots() {
            return (snapshots ??= new LocalForageSnapshotStorage());
        },
        // localforage holds no closeable handles; dropping the references is the whole teardown.
        async destroy() {
            stores.clear();
            snapshots = undefined;
        }
    };
}
