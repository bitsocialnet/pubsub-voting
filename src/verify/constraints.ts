import type { VotesBundle } from "../schema/votes.js";
import type { Criteria } from "../schema/criteria.js";
import type { VerifyResult } from "./types.js";

/**
 * Offline verify stage 1, constraints half: the criteria-bound checks that gate a bundle
 * before any signature recovery or chain read — `votes.length <= criteria.maxVotesPerAddress`
 * and each `vote` within `criteria.voteSchema` (see verify/types.ts stage 1).
 *
 * Pure and synchronous: no signature recovery, no chain. These bounds live in the
 * *criteria*, not in the wire type, which is exactly why `VotesBundleSchema` does NOT
 * enforce them — the schema owns only criteria-independent wire shape (pairwise-distinct
 * boards). This runtime check is where the cap belongs. See DESIGN.md "Votes wire".
 *
 * An empty `votes` array (withdrawal/abstention) is always valid regardless of the cap.
 */
export function checkBundleConstraints(bundle: VotesBundle, criteria: Criteria): VerifyResult {
    // Withdrawal/abstention: the empty bundle is always legal, cap and range notwithstanding.
    if (bundle.votes.length === 0) return { valid: true };

    if (bundle.votes.length > criteria.maxVotesPerAddress) {
        return {
            valid: false,
            reason: `votes.length ${bundle.votes.length} exceeds maxVotesPerAddress ${criteria.maxVotesPerAddress}`
        };
    }

    const { min, max } = criteria.voteSchema;
    for (const v of bundle.votes) {
        if (v.vote < min || v.vote > max) {
            return {
                valid: false,
                reason: `vote ${v.vote} for board ${v.board.publicKey} is outside voteSchema [${min}, ${max}]`
            };
        }
    }
    return { valid: true };
}
