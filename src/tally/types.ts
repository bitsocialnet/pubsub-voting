/**
 * Tally interfaces, design only.
 *
 * One topic decides one contest, so the tally aggregates the current bundles into a
 * single contest ranking. Verification is lazy and top-down: only the votes that can
 * still change the visible order are verified (signature, wallet binding, chain
 * reads), stopping once the remaining unverified weight cannot flip the ranking. So a
 * leaderboard can render fast and refine. See DESIGN.md "Tally".
 */

/** One board's standing within a contest. */
export interface BoardTally {
    board: string;
    /** Summed weight of upvotes counted so far. */
    weight: number;
    /** True once every vote contributing to this row has passed full verification. */
    verified: boolean;
}

/** A contest's ranking, highest weight first. Ordering is deterministic. */
export interface ContestTally {
    contest: string;
    ranking: BoardTally[];
}

export interface TallyOptions {
    /**
     * Upper bound on chain verifications to spend this pass. The tally verifies
     * top-down within the budget and marks rows whose order is not yet locked as
     * `verified: false`.
     */
    verifyBudget?: number;
}

/** Computes the contest ranking from the CRDT's current bundles. */
export interface Tally {
    compute(options?: TallyOptions): Promise<ContestTally>;
}
