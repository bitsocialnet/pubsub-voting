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
