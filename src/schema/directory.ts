import { z } from "zod";
import { CriteriaSchema, type Criteria } from "./criteria.js";
import { DuplicateContestIdError } from "../errors.js";

/**
 * Directory authoring manifest → criteria documents.
 *
 * A directory (e.g. 5chan's 63 boards) is authored as ONE manifest of shared `defaults`
 * plus one entry per slot, and each contest's standalone criteria document is derived by
 * shallow merge: criteria = { ...defaults, ...entry }. The manifest itself is NOT a
 * protocol object — it is never encoded or published, and `defaults` is flattened away at
 * derivation. Only the derived documents matter: two clients must end up with
 * byte-identical documents to share a topic (topic = CID(dag-cbor(criteria))), which is
 * exactly why this derivation is library API rather than per-app code — two consumers
 * (e.g. the 5chan web client and a standalone seeder) re-implementing the merge is a
 * silent topic fork waiting to happen.
 *
 * The merge is shallow ON PURPOSE: an entry override replaces that whole top-level field
 * (a `rule` override brings its own complete rule object), no deep merge. Editing
 * `defaults` re-forks every inheriting contest in lockstep; editing one entry forks only
 * that contest. See the authoring manifest example (5chan-directory-criteria.jsonc) and
 * DESIGN.md "Criteria document".
 *
 * Manifest files are conventionally JSONC (commented for human readers); strip comments
 * (e.g. with `strip-json-comments`) and JSON.parse before calling — this helper is pure
 * and takes the parsed value.
 */

/**
 * The manifest shape: `contests` is required, `defaults` optional, and everything else
 * (name, description, ...) is ignored authoring metadata. Entries are kept loose here —
 * each derived document is what gets validated, against the real CriteriaSchema.
 */
export const DirectoryManifestSchema = z.looseObject({
    defaults: z.record(z.string(), z.unknown()).optional(),
    contests: z.array(z.record(z.string(), z.unknown())).nonempty()
});

export type DirectoryManifest = z.infer<typeof DirectoryManifestSchema>;

/**
 * Derive one complete, validated criteria document per manifest entry
 * (`{ ...defaults, ...entry }`, shallow). Throws if the manifest is malformed, if any
 * derived document fails CriteriaSchema, or if two entries claim the same `contestId`
 * ({@link DuplicateContestIdError} — same slot decided by two topics is an authoring bug).
 */
export function deriveDirectoryCriteria(manifest: unknown): Criteria[] {
    const { defaults = {}, contests } = DirectoryManifestSchema.parse(manifest);
    const seen = new Set<string>();
    return contests.map((entry) => {
        const criteria = CriteriaSchema.parse({ ...defaults, ...entry });
        if (seen.has(criteria.contestId)) throw new DuplicateContestIdError(criteria.contestId);
        seen.add(criteria.contestId);
        return criteria;
    });
}
