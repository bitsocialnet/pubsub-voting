import { MemoryVoteStore } from "./memory.js";
import type { VoteIntent, VoteStore } from "./types.js";

/**
 * Pick the vote store for a voter by environment:
 *   - a global `indexedDB` (the browser) → the IndexedDB backend;
 *   - otherwise Node with a `dataPath` → a **SQLite file under `dataPath`** (WAL mode, the same
 *     `dataPath` convention pkc-js and `@bitsocial/bso-resolver` use);
 *   - otherwise (Node, no `dataPath`) → in-memory (intents lost on restart).
 *
 * The concrete backends are imported **lazily** (dynamic `import()` inside {@link LazyVoteStore}):
 * the Node backend pulls in the native `better-sqlite3`, which must never enter a browser bundle,
 * and the browser backend touches `indexedDB`, absent on Node. Deferring the import to first use
 * keeps each out of the other environment's module graph while leaving this function synchronous
 * (the `PubsubVoter` constructor stays sync). See DESIGN.md "Persistence".
 */
export function selectVoteStore(dataPath: string | undefined): VoteStore {
    if (typeof indexedDB !== "undefined") {
        return new LazyVoteStore(async () => {
            const { IndexedDbVoteStore } = await import("./indexeddb.js");
            return new IndexedDbVoteStore();
        });
    }
    if (dataPath !== undefined) {
        return new LazyVoteStore(async () => {
            const { SqliteVoteStore } = await import("./sqlite.js");
            return new SqliteVoteStore(dataPath);
        });
    }
    return new MemoryVoteStore();
}

/**
 * A {@link VoteStore} that defers constructing its backend until the first method call, so the
 * backend module (and its environment-specific dependency) is only `import()`ed when actually
 * used. The factory runs at most once; every method delegates to the resolved backend.
 */
class LazyVoteStore implements VoteStore {
    #backend: Promise<VoteStore> | undefined;

    constructor(private readonly factory: () => Promise<VoteStore>) {}

    #resolve(): Promise<VoteStore> {
        if (this.#backend === undefined) this.#backend = this.factory();
        return this.#backend;
    }

    async list(): Promise<VoteIntent[]> {
        return (await this.#resolve()).list();
    }

    async get(topic: string): Promise<VoteIntent | undefined> {
        return (await this.#resolve()).get(topic);
    }

    async put(intent: VoteIntent): Promise<void> {
        return (await this.#resolve()).put(intent);
    }

    async delete(topic: string): Promise<void> {
        return (await this.#resolve()).delete(topic);
    }

    async destroy(): Promise<void> {
        // Nothing to release if the backend was never opened.
        if (this.#backend === undefined) return;
        await (await this.#backend).destroy?.();
    }
}
