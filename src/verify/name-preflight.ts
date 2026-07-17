import type { Vote } from "../schema/votes.js";
import type { NameResolver } from "../chain/types.js";
import { resolveNameThroughCache, type NameResolutionCache } from "./name-resolution-cache.js";

/**
 * Publish-time community-name preflight — the publisher-side twin of the verify pipeline's
 * step 4 (see bundle.ts). Gossipsub has no rejection-feedback channel: a peer that drops a
 * bundle never tells the publisher why (or that it dropped it at all), so the only "clear
 * error" a publisher can ever get is from running the same checks locally BEFORE the vote
 * hits the wire. A vote naming a community whose name does not check out is guaranteed to be
 * dropped by every honest verifier, so publishing it is pure waste; failing fast here turns
 * that silent network-wide drop into an immediate, explainable publish error.
 *
 * The failure split mirrors the pipeline's `reject`/`ignore` philosophy, adapted to the
 * publisher (who, unlike a relayer, can always just fix the vote and retry):
 *   - definitive from this node's view — no resolver handles the TLD, the name has no record,
 *     or it resolves to a DIFFERENT key than the vote claims — fails the preflight; every
 *     verifier sharing this node's view would drop the bundle the same way.
 *   - transient — the resolver THREW (registry RPC down) — passes the preflight with
 *     `settled: false`: a resolver outage must not block voting (the same reason the
 *     background verifier retries instead of evicting on a throw), and the deferred check
 *     settles or evicts the bundle once the resolver recovers.
 *
 * Resolutions ride the shared {@link NameResolutionCache} (the pkc-js rule, 1-hour max-age),
 * so a preflight-resolved name is a cache hit for the background verifier's own pass — the
 * preflight adds at most one live registry read per name per hour, not a second read path.
 */

/** One name that definitively failed the preflight (the first failure aborts the scan). */
export interface NamePreflightFailure {
    ok: false;
    communityName: string;
    /** The `community.publicKey` the vote claims the name points at. */
    claimedPublicKey: string;
    /** What the registry actually resolved the name to; absent for no-resolver / no-record. */
    resolvedPublicKey?: string;
    /** Human-readable cause, same wording as the verify pipeline's step-4 verdicts. */
    reason: string;
}

export type NamePreflightResult =
    | {
          ok: true;
          /**
           * True when every carried name resolved to its claimed key right now; false when at
           * least one resolution was SKIPPED on a resolver throw (transient outage) and is
           * still owed to the background verifier. Feeds the publisher's own
           * `nameResolved` check state, so a preflight-settled vote renders verified
           * immediately instead of flashing a pending row.
           */
          settled: boolean;
      }
    | NamePreflightFailure;

/**
 * Resolve every distinct `community.name` carried by `votes` and check each against its
 * vote's claimed `publicKey`. Returns the first definitive failure, or `ok` with whether
 * every name settled (see module doc for the definitive/transient split). Votes carrying no
 * name are free: no resolver is consulted and `{ ok: true, settled: true }` returns
 * synchronously.
 */
export async function preflightCommunityNames(opts: {
    votes: readonly Vote[];
    nameResolvers: NameResolver[];
    cache: NameResolutionCache | undefined;
}): Promise<NamePreflightResult> {
    const { votes, nameResolvers, cache } = opts;
    let settled = true;
    for (const v of votes) {
        const name = v.community.name;
        if (!name) continue;
        const resolver = nameResolvers.find((r) => r.canResolve({ name }));
        if (!resolver) {
            return {
                ok: false,
                communityName: name,
                claimedPublicKey: v.community.publicKey,
                reason: `no resolver handles community name "${name}"`
            };
        }
        let record: { publicKey: string } | undefined;
        try {
            record = await resolveNameThroughCache({ resolver, name, cache });
        } catch {
            settled = false; // transient registry outage — never blocks a publish
            continue;
        }
        if (!record) {
            return {
                ok: false,
                communityName: name,
                claimedPublicKey: v.community.publicKey,
                reason: `community name "${name}" does not resolve`
            };
        }
        if (record.publicKey !== v.community.publicKey) {
            return {
                ok: false,
                communityName: name,
                claimedPublicKey: v.community.publicKey,
                resolvedPublicKey: record.publicKey,
                reason: `community name "${name}" resolves to ${record.publicKey}, not the claimed ${v.community.publicKey}`
            };
        }
    }
    return { ok: true, settled };
}
