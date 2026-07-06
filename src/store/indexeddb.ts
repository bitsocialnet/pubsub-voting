import { z } from "zod";
import { VoteSchema } from "../schema/votes.js";
import type { VoteIntent, VoteStore } from "./types.js";

/**
 * The browser {@link VoteStore} backend: this wallet's re-signable vote intents in an
 * IndexedDB object store, so republishing survives a page reload (see DESIGN.md "Persistence").
 * It holds only *this* voter's choices — never the CRDT of everyone's bundles.
 *
 * Selected by `selectVoteStore` when a global `indexedDB` is present (the browser); Node uses
 * the SQLite backend instead. No third-party dependency — plain IndexedDB behind small
 * promise wrappers. One record per contest, keyed by `topic`; each record is re-validated
 * through {@link VoteSchema} on read so a corrupt entry cannot smuggle a malformed vote back
 * into the signer.
 */

const DB_NAME = "bitsocial-pubsub-votes";
const STORE_NAME = "vote_intents";

/** The persisted intent shape, re-validated on read (IndexedDB returns `any`). */
const StoredIntentSchema = z.object({
    topic: z.string(),
    address: z.string(),
    votes: z.array(VoteSchema),
    lastBucket: z.number()
});

/** Wrap an IndexedDB request as a promise. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export class IndexedDbVoteStore implements VoteStore {
    #db: IDBDatabase | undefined;

    /** Open (creating the object store on first use) the vote-intents database. */
    async #open(): Promise<IDBDatabase> {
        if (this.#db !== undefined) return this.#db;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME, { keyPath: "topic" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        this.#db = db;
        return db;
    }

    async #tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
        const db = await this.#open();
        const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
        return run(store);
    }

    async list(): Promise<VoteIntent[]> {
        const rows = await this.#tx("readonly", (store) => promisify(store.getAll()));
        return rows.map((row) => StoredIntentSchema.parse(row));
    }

    async get(topic: string): Promise<VoteIntent | undefined> {
        const row: unknown = await this.#tx("readonly", (store) => promisify(store.get(topic)));
        return row === undefined ? undefined : StoredIntentSchema.parse(row);
    }

    async put(intent: VoteIntent): Promise<void> {
        await this.#tx("readwrite", (store) => promisify(store.put(intent)));
    }

    async delete(topic: string): Promise<void> {
        await this.#tx("readwrite", (store) => promisify(store.delete(topic)));
    }

    async destroy(): Promise<void> {
        this.#db?.close();
        this.#db = undefined;
    }
}
