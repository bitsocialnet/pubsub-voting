import type { VotesBundle } from "../schema/votes.js";
import type { Criteria } from "../schema/criteria.js";
import type { VerifyResult } from "./types.js";
import { NotImplementedError } from "../errors.js";

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
 *
 * Design only: throws NotImplementedError until the verify engine lands. The expected
 * behavior is pinned in `constraints.test.ts` (a reproduce-first `it.fails`).
 */
export function checkBundleConstraints(_bundle: VotesBundle, _criteria: Criteria): VerifyResult {
    throw new NotImplementedError("verify: checkBundleConstraints (criteria-bound offline constraints)");
}
