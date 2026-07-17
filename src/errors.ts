import type { VotesBundle } from "./schema/votes.js";
import type { VerifyFail } from "./verify/types.js";

/**
 * Library error types.
 *
 * The engine and client lifecycle are implemented — schemas, encoding, topic derivation,
 * the verify pipeline, the LWW winner-set CRDT, the tally, the transport's
 * validate-before-forward gossip gate, and the reactive `PubsubVoter` / `Contest` / `ContestVote`
 * facade. Republishing a live vote is the client's job (no scheduler, no persistence); see
 * DESIGN.md "Republishing is the client's job".
 */

/** Thrown by any facade path deferred to a later version (none in v1's shipped surface). */
export class NotImplementedError extends Error {
    constructor(what: string) {
        super(`${what} is not implemented yet. See DESIGN.md / ROADMAP.md.`);
        this.name = "NotImplementedError";
    }
}

/**
 * Thrown when a criteria document names a rule `type` this client does not
 * implement (in the `rule`/`weight` slot or in `requires.rules`). A
 * client that hits this is too old (or missing a host override) and must recuse
 * itself from the contest rather than miscount. See DESIGN.md "Rules".
 */
export class UnknownRuleError extends Error {
    constructor(
        readonly slot: "rule" | "weight" | "requires",
        readonly type: string
    ) {
        super(
            `Unknown rule "${type}" referenced by the criteria ${slot}. This client does not ` +
                `implement it; pass it via the \`rules\` option to shadow/extend the built-ins, ` +
                `or recuse this contest. Built-ins: see registry.ts.`
        );
        this.name = "UnknownRuleError";
    }
}

/**
 * Thrown by `createContest` / `createContestVote` when the criteria's dependency manifest
 * names a chain (`requires.chains`) the host's `ChainClientFactory` cannot resolve to a
 * client (it returned `undefined`). RPC endpoints are client-local settings, not part of
 * the criteria document, so a client with no gateway configured for a required chain must
 * recuse the contest rather than miscount — the chain-side twin of `UnknownRuleError`.
 */
export class MissingChainClientError extends Error {
    constructor(
        readonly chain: string,
        readonly chainId: number
    ) {
        super(
            `No chain client for "${chain}" (chainId ${chainId}), which this contest's criteria ` +
                `requires. RPC endpoints are client settings, not part of the criteria document: ` +
                `configure the \`chains\` factory (PubsubVoterOptions.chains) to return a viem ` +
                `PublicClient for this chain, or recuse this contest.`
        );
        this.name = "MissingChainClientError";
    }
}

/**
 * Thrown at construction when the injected Helia node's libp2p has no usable pubsub
 * (gossipsub) service at `libp2p.services.pubsub`. The library broadcasts and receives
 * winner bundle CIDs over gossipsub, so a node without it cannot participate. Helia's default
 * libp2p services do NOT include pubsub — the host must register a gossipsub service
 * (e.g. `@chainsafe/libp2p-gossipsub`) before passing the node in. We fail fast here
 * rather than letting a later `publish`/`subscribe` fail obscurely. See DESIGN.md
 * "Transport".
 */
export class MissingPubsubError extends Error {
    constructor() {
        super(
            "The injected Helia node's libp2p has no usable pubsub service at " +
                "`libp2p.services.pubsub`. This library needs a gossipsub service to broadcast " +
                "and receive votes. Register one before constructing PubsubVoter (Helia's " +
                "default services do not include pubsub; e.g. add `@chainsafe/libp2p-gossipsub` " +
                "as `services.pubsub`). See DESIGN.md \"Transport\"."
        );
        this.name = "MissingPubsubError";
    }
}

/**
 * Thrown at construction when the injected Helia node has no usable `blockstore`. Vote
 * bundles are immutable content-addressed blocks fetched by CID through the host's
 * blockstore (bitswap retrieves through it), so the engine cannot resolve a bundle without
 * one. Note "bitswap" is not a separately introspectable property of a Helia node — it
 * is a block broker wired *beneath* `blockstore` — so the checkable guarantee is a
 * well-formed blockstore, the surface bitswap retrieves through. See DESIGN.md
 * "Transport".
 */
export class MissingBlockstoreError extends Error {
    constructor() {
        super(
            "The injected Helia node has no usable `blockstore`. This library fetches vote " +
                "bundles by CID through it (bitswap retrieves through the blockstore), so a " +
                "node without one cannot resolve votes. Pass a full Helia instance (e.g. the " +
                "result of `createHelia`). See DESIGN.md \"Transport\"."
        );
        this.name = "MissingBlockstoreError";
    }
}

/**
 * Thrown at construction when the injected Helia node's libp2p has no usable **fetch
 * service** at `libp2p.services.fetch`. The root-record pull — cold-start / reconnect
 * checkpoint sync — rides the libp2p fetch protocol (this library registers its own lookup
 * and runs its own requester), so the host must register `@libp2p/fetch` on the shared
 * node. See DESIGN.md "Checkpoints" and "Deferred pkc-js work".
 */
export class MissingFetchError extends Error {
    constructor() {
        super(
            "The injected Helia node's libp2p has no usable fetch service at " +
                "`libp2p.services.fetch`. This library pulls peers' checkpoint root records " +
                "over the libp2p fetch protocol on cold start, so the service is required. " +
                "Register `@libp2p/fetch` as `services.fetch` before constructing PubsubVoter. " +
                "See DESIGN.md \"Checkpoints\"."
        );
        this.name = "MissingFetchError";
    }
}

/**
 * Thrown once a voter has been `destroy()`ed and something tries to keep using it. Unlike `stop()`
 * (which leaves every topic but keeps the client reusable), `destroy()` is terminal: every contest
 * is stopped and can no longer update or publish. Surfaced by `createContest` / `createContestVote`,
 * and by a pre-existing `Contest.update()` / `ContestVote.publish()`. Construct a new
 * `PubsubVoter` to participate again.
 */
export class VoterDestroyedError extends Error {
    constructor() {
        super(
            "This voter has been destroyed: its contests are stopped and can no longer update or " +
                "publish. `destroy()` is terminal (unlike the reusable `stop()`). Construct a new " +
                "PubsubVoter to participate again."
        );
        this.name = "VoterDestroyedError";
    }
}

/**
 * Thrown by `deriveDirectoryCriteria` when two manifest entries derive the same `contestId`.
 * One directory slot decided by two topics is an authoring bug in the manifest: either the
 * duplicate entry is a copy-paste mistake, or the slot's electorate would be split.
 */
export class DuplicateContestIdError extends Error {
    constructor(readonly contestId: string) {
        super(
            `Directory manifest derives contestId "${contestId}" twice. Each directory slot must ` +
                `be decided by exactly one contest (one criteria document, one topic); remove or ` +
                `rename the duplicate entry.`
        );
        this.name = "DuplicateContestIdError";
    }
}

/** Thrown when a publish (vote/withdraw) is attempted on a voter constructed without a signer. */
export class ReadOnlyError extends Error {
    constructor() {
        super(
            "This voter is read-only: it was constructed without a `signer`. " +
                "Provide a VoteSigner to publish or withdraw votes; reading tallies needs no signer."
        );
        this.name = "ReadOnlyError";
    }
}

/**
 * Thrown by `ContestVote.publish()` when a vote carries a `community.name` that definitively
 * fails the publish-time preflight (see verify/name-preflight.ts): no configured resolver
 * handles it, it resolves to no record, or it resolves to a DIFFERENT key than the vote
 * claims. Every honest verifier runs the same check and drops such a bundle without telling
 * the publisher (gossipsub has no rejection feedback), so the vote is refused here — before
 * signing, before joining the topic — instead of being published into a silent network-wide
 * drop. Fix the name (or the claimed `publicKey`) and publish again. A resolver that merely
 * THREW (registry outage) does not throw this: the vote publishes and the background verifier
 * settles the check, surfacing a `VoteEvictedError` if it turns out bad.
 */
export class InvalidCommunityNameError extends Error {
    constructor(
        /** The offending `community.name`. */
        readonly communityName: string,
        /** The `community.publicKey` the vote claims the name points at. */
        readonly claimedPublicKey: string,
        /** What the registry resolved the name to; `undefined` for no-resolver / no-record. */
        readonly resolvedPublicKey: string | undefined,
        reason: string
    ) {
        super(
            `Cannot publish this vote: ${reason}. Every verifier checks a carried community ` +
                `name against its registry and silently drops a bundle whose name does not ` +
                `resolve to the claimed publicKey, so this vote would never be counted. Fix ` +
                `the name (or the claimed publicKey), or drop the name from the vote, and ` +
                `publish again.`
        );
        this.name = "InvalidCommunityNameError";
    }
}

/**
 * Emitted (never thrown) when a deferred network check EVICTS this wallet's own published
 * vote: the background verifier read the gate rule as `0n` at the vote's sample block, or its
 * carried community name did not check out (see DESIGN.md "Background chain verification").
 * `publish()` resolves on the offline checks, so an own vote that fails a deferred check
 * would otherwise just silently vanish from the local tally — while every honest peer,
 * running the same checks, drops it with no feedback (gossipsub has no rejection channel).
 * This error is that missing feedback, built from the local verdict: it fires on the
 * publishing `ContestVote`'s `error` event (flipping its `publishingState` to `"failed"`)
 * and on the contest's `error` event. Carries the evicted bundle and the exact verdict.
 */
export class VoteEvictedError extends Error {
    constructor(
        /** The signed bundle that was evicted (the one `publish()` resolved with). */
        readonly bundle: VotesBundle,
        /** The failing verdict, with the same `reason` wording every verifier produces. */
        readonly verdict: VerifyFail
    ) {
        super(
            `This wallet's published vote failed a deferred verification check and was ` +
                `evicted from the local tally: ${verdict.reason}. Honest peers run the same ` +
                `checks, so the network will not count this vote either. Fix the cause and ` +
                `publish again.`
        );
        this.name = "VoteEvictedError";
    }
}
