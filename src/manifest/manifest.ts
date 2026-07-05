import { z } from "zod";
import { CriteriaSchema, type Criteria } from "../schema/criteria.js";

/**
 * Directory manifest derivation.
 *
 * A manifest is a DRY authoring convenience, NOT a wire or consensus object: it is
 * never encoded or published. A client derives one complete, standalone criteria
 * document per contest by shallow-merging each `contests` entry over `defaults`
 * (`criteria = { ...defaults, ...entry }`), then validating the result against the
 * real `CriteriaSchema`. An override replaces a whole top-level field (no deep merge),
 * so `/q/` can raise its gate without touching any other slot. `defaults` is flattened
 * away here; there is no shared rule object at runtime. See DESIGN.md "Criteria
 * document". Pure and offline.
 *
 * The manifest schema is intentionally permissive — it only pins the structural fields
 * (`name`, `defaults`, `contests[].contestId`, `contests[].name`). `CriteriaSchema` is
 * the real gate: each derived document must be a valid, canonically-encodable criteria.
 * Uniqueness of `contestId` across a manifest is enforced where the manifest is owned —
 * the `PubsubVoter` constructor (see `DuplicateContestIdError`) — not here, so that
 * `deriveCriteria` stays a pure, order-preserving transform.
 */

/** One contest entry: its unique `contestId` plus any per-contest rule overrides. */
export const ManifestContestSchema = z.looseObject({
    contestId: z.string().min(1),
    name: z.string().min(1)
});

export const DirectoryManifestSchema = z.looseObject({
    name: z.string().min(1),
    /** Rule fields inherited by every contest unless overridden. Validated post-merge. */
    defaults: z.looseObject({}),
    contests: z.array(ManifestContestSchema).nonempty()
});

export type ManifestContest = z.infer<typeof ManifestContestSchema>;
export type DirectoryManifest = z.infer<typeof DirectoryManifestSchema>;

/** Shallow-merge one entry over defaults and validate the result as a criteria document. */
export function mergeCriteria(
    defaults: Record<string, unknown>,
    entry: Record<string, unknown>
): Criteria {
    return CriteriaSchema.parse({ ...defaults, ...entry });
}

/** Derive every contest's criteria document from a manifest, in `contests` order. */
export function deriveCriteria(manifest: unknown): Criteria[] {
    const parsed = DirectoryManifestSchema.parse(manifest);
    const defaults = parsed.defaults as Record<string, unknown>;
    return parsed.contests.map((entry) => mergeCriteria(defaults, entry as Record<string, unknown>));
}
