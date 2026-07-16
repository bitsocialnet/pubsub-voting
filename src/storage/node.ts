import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeMemoryStorage } from "./memory.js";
import type { LruStorage, StorageOptions, VoteStorage } from "./types.js";

/**
 * The Node backend: one better-sqlite3 database per named cache under
 * `{dataPath}/lru-storage/{cacheName}.db`, a port of pkc-js's `SqliteCache`
 * (runtime/node/sqlite-lru-cache.ts) with the same table shape and LRU rule — `lastAccess`
 * updated on every hit, eviction deletes everything past `maxItems` in recency order. Ports
 * differ in three deliberate ways: values are JSON text (not cbor blobs — callers already
 * stringify, and it keeps this file dependency-free beyond the driver), there is no TTL
 * column (freshness here is read-time policy: the name cache checks `resolvedAtMs` against a
 * per-call max-age, the gate store is purged by sample-block expiry), and LRU cleanup runs
 * inline on each write instead of on a timer (writes are per wallet-bucket / per name — rare
 * — and no timer means nothing to keep the process alive or `unref`).
 *
 * WAL mode matches pkc-js: it reduces the lost-write window when two processes share a
 * dataPath. The database opens lazily on first use, so constructing a voter touches no disk.
 */
class SqliteLruStorage implements LruStorage {
    #db: Database.Database | undefined;
    readonly #file: string;
    readonly #dir: string;
    readonly #maxItems: number;
    #statements:
        | {
              get: Database.Statement;
              set: Database.Statement;
              remove: Database.Statement;
              keys: Database.Statement;
              clear: Database.Statement;
              evict: Database.Statement;
          }
        | undefined;

    constructor(opts: { dir: string; cacheName: string; maxItems: number }) {
        this.#dir = opts.dir;
        this.#file = join(opts.dir, `${opts.cacheName}.db`);
        this.#maxItems = opts.maxItems;
    }

    #closed = false;

    #open() {
        if (this.#statements) return this.#statements;
        // A late fire-and-forget write after destroy() must fail (callers swallow cache
        // errors), never silently re-create the database file.
        if (this.#closed) throw new Error("storage is closed");
        mkdirSync(this.#dir, { recursive: true });
        const db = new Database(this.#file);
        db.pragma("journal_mode = WAL");
        db.prepare(`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, lastAccess INT)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS lastAccess ON cache (lastAccess)`).run();
        this.#db = db;
        this.#statements = {
            get: db.prepare(`UPDATE OR IGNORE cache SET lastAccess = @now WHERE key = @key RETURNING value`),
            set: db.prepare(`INSERT OR REPLACE INTO cache (key, value, lastAccess) VALUES (@key, @value, @now)`),
            remove: db.prepare(`DELETE FROM cache WHERE key = @key`),
            keys: db.prepare(`SELECT key FROM cache`),
            clear: db.prepare(`DELETE FROM cache`),
            evict: db.prepare(
                `WITH lru AS (SELECT key FROM cache ORDER BY lastAccess DESC LIMIT -1 OFFSET @maxItems)
                 DELETE FROM cache WHERE key IN lru`
            )
        };
        return this.#statements;
    }

    async getItem(key: string): Promise<unknown> {
        const row = this.#open().get.get({ key, now: Date.now() }) as { value: string } | undefined;
        return row === undefined ? undefined : JSON.parse(row.value);
    }

    async setItem(key: string, value: unknown): Promise<void> {
        const statements = this.#open();
        statements.set.run({ key, value: JSON.stringify(value ?? null), now: Date.now() });
        statements.evict.run({ maxItems: this.#maxItems });
    }

    async removeItem(key: string): Promise<void> {
        this.#open().remove.run({ key });
    }

    async keys(): Promise<string[]> {
        return (this.#open().keys.all() as Array<{ key: string }>).map((row) => row.key);
    }

    async clear(): Promise<void> {
        this.#open().clear.run();
    }

    close(): void {
        this.#closed = true;
        this.#db?.close();
        this.#db = undefined;
        this.#statements = undefined;
    }
}

/** Node's default data path when the host passes none (see {@link StorageOptions.dataPath}). */
export function defaultDataPath(): string {
    return join(process.cwd(), ".bitsocial-pubsub-voting");
}

/** Build the Node {@link VoteStorage}: sqlite under the data path, or in-memory for `false`. */
export function makeStorage(options: StorageOptions): VoteStorage {
    if (options.dataPath === false) return makeMemoryStorage();
    const dir = join(options.dataPath ?? defaultDataPath(), "lru-storage");
    const stores = new Map<string, SqliteLruStorage>();
    return {
        openLru({ cacheName, maxItems }) {
            let store = stores.get(cacheName);
            if (!store) {
                store = new SqliteLruStorage({ dir, cacheName, maxItems });
                stores.set(cacheName, store);
            }
            return store;
        },
        async destroy() {
            for (const store of stores.values()) store.close();
            stores.clear();
        }
    };
}
