/**
 * Tally interfaces.
 *
 * One topic decides one contest, so the tally aggregates the current bundles into a single
 * contest ranking. The synchronous checks (signature, constraints) are admission
 * preconditions — every aggregated bundle has passed them — so the per-row flags below track
 * only the two deferred NETWORK checks, one field per verification operation (mirroring
 * pkc-js's `nameResolved`): the on-chain gate read and community-name resolution. A cold join
 * admits a checkpoint's bundles provisionally and renders immediately; the background chain
 * verifier then confirms (flipping the flags, re-emitting `update`) or evicts. See DESIGN.md
 * "Background chain verification" and "Tally".
 */

/** One community's standing within a contest. */
export interface CommunityTally {
    /**
     * The community this row aggregates. Rows are keyed by `community.publicKey`; `name` is the
     * community's resolvable domain carried through from the votes. It never affects which
     * votes fold into this row, and `nameResolved` below says whether it has been checked
     * against the registry yet. See DESIGN.md "Votes wire" and "Tally".
     */
    community: { name?: string; publicKey: string };
    /** Summed weight of upvotes counted so far, in rule score units (`bigint`). */
    weight: bigint;
    /**
     * True once every bundle contributing to this row has had its gate `rule` confirmed `> 0n`
     * by an on-chain read at its bucket block. `false` means at least one contribution is still
     * awaiting its background gate read — never that one failed (a failed gate evicts the
     * bundle and recounts the row).
     */
    chainVerified: boolean;
    /**
     * Present only when the row carries a `name`: true once the shown name resolved to this
     * row's `publicKey` through the registry (pkc-js's `nameResolved` shape). `false` while the
     * carried name is still awaiting background resolution — a name that resolves to a
     * DIFFERENT key evicts its bundle instead, so a mismatched name is never shown.
     */
    nameResolved?: boolean;
}

/** A contest's ranking, highest weight first. Ordering is deterministic. */
export interface ContestTally {
    /** The `contestId` of the criteria this ranking is for. */
    contestId: string;
    ranking: CommunityTally[];
}

/** Computes the contest ranking from the CRDT's current bundles. */
export interface Tally {
    compute(): Promise<ContestTally>;
}
