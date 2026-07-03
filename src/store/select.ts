import { MemoryVoteStore } from "./memory.js";
import type { VoteStore } from "./types.js";

/**
 * Pick the vote store for a voter by environment: on Node a **SQLite file under `dataPath`**
 * (the same `dataPath` convention pkc-js and `@bitsocial/bso-resolver` use — a directory,
 * one file inside it, WAL mode), and IndexedDB in the browser. Those concrete backends land
 * with the engine, so today this returns an in-memory store (intents lost on restart)
 * regardless of `dataPath`; the option is threaded now so it stays stable, and the Node
 * backend reads it once wired.
 */
export function selectVoteStore(dataPath: string | undefined): VoteStore {
    // The Node (sqlite-under-`dataPath`) and browser (IndexedDB) backends are deferred with
    // the engine; until then persistence is in-memory regardless of `dataPath`.
    void dataPath;
    return new MemoryVoteStore();
}
