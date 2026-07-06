import type { Vote } from "../schema/votes.js";

/**
 * Vote-intent persistence.
 *
 * A live vote decays on its own: a bundle is valid for only `voteExpiryBuckets` after its
 * `blockNumber` (see DESIGN.md "Passive expiry"). Keeping a vote alive means periodically
 * re-signing the *same choice* with a fresh `blockNumber` and re-broadcasting it. To do
 * that across a process restart the voter must remember what it chose — but not the signed
 * bundles (those are immutable, content-addressed, and live in the host's Helia blockstore;
 * a stale `blockNumber` makes an old bundle useless). What it persists is the re-signable
 * *intent*: which boards this wallet picked in which contest. On `start()` the voter loads
 * every stored intent and republishes it; the republish scheduler re-signs each on the
 * liveness cadence (`ceil(voteExpiryBuckets / 2)` buckets — see DESIGN.md "Lifecycle").
 *
 * This is a plain key-value contract, keyed by `topic` (one intent per contest per wallet).
 * It is internal: the library picks the backend by environment — IndexedDB in the browser,
 * a SQLite file under the constructor's `dataPath` on Node — with no host-facing store seam.
 * Declared as its own interface (like `BundleStore` in crdt/types.ts) so the voter can be
 * tested against an in-memory store with no I/O.
 */

/** One contest's re-signable (or, when empty, re-announceable) choice for this wallet. */
export interface VoteIntent {
    /** The gossipsub topic this intent votes in = "bitsocial-votes/" + CID(dag-cbor(criteria)). */
    topic: string;
    /** The voting wallet address (recovered from the bundle signature). One intent per topic per address. */
    address: string;
    /**
     * The boards this wallet chose. A non-empty intent is an active vote the scheduler re-signs
     * (fresh `blockNumber`) each cadence to keep alive. An **empty array is a withdrawal
     * tombstone**: the empty bundle supersedes the prior vote under LWW, and the scheduler
     * re-announces its existing CID (never re-signing it) each cadence until it expires, then
     * deletes the intent — the bundle decays on its own via expiry + prune. See DESIGN.md
     * "Cancelling a vote".
     */
    votes: Vote[];
    /** The bucket of the last successful republish, so the scheduler knows when the next is due. */
    lastBucket: number;
}

/**
 * Where the voter keeps its own vote intents. Only ever holds *this* voter's choices, not
 * the CRDT of everyone's bundles. `list` feeds the republish loop on `start()`; `put` is
 * written on every cast and every successful republish; `delete` drops an intent that has
 * expired or been explicitly cancelled. `destroy` releases backend handles (close the DB
 * or file) and is called by `PubsubVoter.destroy()`.
 */
export interface VoteStore {
    /** Every intent to keep alive. Called once on `start()` to seed the republish scheduler. */
    list(): Promise<VoteIntent[]>;
    /** The intent for one contest, or `undefined` if this wallet has not voted there. */
    get(topic: string): Promise<VoteIntent | undefined>;
    /** Insert or replace one contest's intent (last write wins, mirroring the CRDT). */
    put(intent: VoteIntent): Promise<void>;
    /** Drop one contest's intent (expiry or explicit cancel). Idempotent. */
    delete(topic: string): Promise<void>;
    /** Release backend handles. Optional: the in-memory store has nothing to release. */
    destroy?(): Promise<void>;
}
