import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { VoteSchema } from "../schema/votes.js";
import type { VoteIntent, VoteStore } from "./types.js";

/**
 * The Node {@link VoteStore} backend: this wallet's re-signable vote intents in a SQLite file
 * under the constructor's `dataPath` directory (WAL mode), so republishing survives a process
 * restart (see DESIGN.md "Persistence"). It holds only *this* voter's choices — never the CRDT
 * of everyone's bundles, which lives in the host's Helia blockstore.
 *
 * `better-sqlite3` is a native Node module, so this file is imported **only dynamically** (via
 * `selectVoteStore`), keeping it out of any browser bundle — the browser uses IndexedDB. One
 * row per contest, keyed by `topic`; `votes` is stored as JSON and re-validated through
 * {@link VoteSchema} on read so a hand-edited or corrupt row cannot smuggle a malformed vote
 * back into the signer.
 */

/** The persisted `votes` column shape, re-validated on read (no `any` from `JSON.parse`). */
const StoredVotesSchema = z.array(VoteSchema);

/** The SQLite file name kept inside the `dataPath` directory. */
const DB_FILENAME = "pubsub-votes.sqlite";

/** One row of the `vote_intents` table, as returned by better-sqlite3. */
interface IntentRow {
    topic: string;
    address: string;
    votes: string;
    last_bucket: number;
}

export class SqliteVoteStore implements VoteStore {
    readonly #db: Database.Database;
    readonly #listStmt: Database.Statement<[], IntentRow>;
    readonly #getStmt: Database.Statement<[string], IntentRow>;
    readonly #putStmt: Database.Statement<[string, string, string, number]>;
    readonly #deleteStmt: Database.Statement<[string]>;

    /** Open (creating if absent) the vote-intents DB inside the `dataPath` directory. */
    constructor(dataPath: string) {
        mkdirSync(dataPath, { recursive: true });
        this.#db = new Database(join(dataPath, DB_FILENAME));
        this.#db.pragma("journal_mode = WAL");
        this.#db.exec(
            `CREATE TABLE IF NOT EXISTS vote_intents (
                topic TEXT PRIMARY KEY,
                address TEXT NOT NULL,
                votes TEXT NOT NULL,
                last_bucket INTEGER NOT NULL
            )`
        );
        this.#listStmt = this.#db.prepare("SELECT topic, address, votes, last_bucket FROM vote_intents");
        this.#getStmt = this.#db.prepare("SELECT topic, address, votes, last_bucket FROM vote_intents WHERE topic = ?");
        this.#putStmt = this.#db.prepare(
            "INSERT OR REPLACE INTO vote_intents (topic, address, votes, last_bucket) VALUES (?, ?, ?, ?)"
        );
        this.#deleteStmt = this.#db.prepare("DELETE FROM vote_intents WHERE topic = ?");
    }

    #rowToIntent(row: IntentRow): VoteIntent {
        return {
            topic: row.topic,
            address: row.address,
            votes: StoredVotesSchema.parse(JSON.parse(row.votes)),
            lastBucket: row.last_bucket
        };
    }

    async list(): Promise<VoteIntent[]> {
        return this.#listStmt.all().map((row) => this.#rowToIntent(row));
    }

    async get(topic: string): Promise<VoteIntent | undefined> {
        const row = this.#getStmt.get(topic);
        return row === undefined ? undefined : this.#rowToIntent(row);
    }

    async put(intent: VoteIntent): Promise<void> {
        this.#putStmt.run(intent.topic, intent.address, JSON.stringify(intent.votes), intent.lastBucket);
    }

    async delete(topic: string): Promise<void> {
        this.#deleteStmt.run(topic);
    }

    async destroy(): Promise<void> {
        this.#db.close();
    }
}
