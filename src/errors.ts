/**
 * Library error types.
 *
 * The engine is implemented — schemas, encoding, topic/manifest derivation, the verify
 * pipeline, the Merkle-CRDT, the tally, and the transport's validate-before-forward gossip
 * gate — so `VoteNetwork.start`/`castVotes`/`getTally` are live. The remaining stub is the
 * `PubsubVoter` client-level republish scheduler, which still throws `NotImplementedError`.
 * See DESIGN.md.
 */

/** Thrown by the facade paths that are not yet implemented (the client-level republish scheduler). */
export class NotImplementedError extends Error {
    constructor(what: string) {
        super(
            `${what} is not implemented yet. The engine (verify, CRDT, tally, and the transport ` +
                `forward-gate) is live; the client-level republish scheduler is the remaining stub. ` +
                `See DESIGN.md.`
        );
        this.name = "NotImplementedError";
    }
}

/**
 * Thrown when a criteria document names an interpreter `type` this client does not
 * implement (in the `eligibility`/`weight` slot or in `requires.interpreters`). A
 * client that hits this is too old (or missing a host override) and must recuse
 * itself from the contest rather than miscount. See DESIGN.md "Interpreters".
 */
export class UnknownInterpreterError extends Error {
    constructor(
        readonly slot: "eligibility" | "weight" | "requires",
        readonly type: string
    ) {
        super(
            `Unknown interpreter "${type}" referenced by the criteria ${slot}. This client does not ` +
                `implement it; pass it via the \`interpreters\` option to shadow/extend the built-ins, ` +
                `or recuse this contest. Built-ins: see registry.ts.`
        );
        this.name = "UnknownInterpreterError";
    }
}

/**
 * Thrown at construction when the injected Helia node's libp2p has no usable pubsub
 * (gossipsub) service at `libp2p.services.pubsub`. The library broadcasts and receives
 * head CIDs over gossipsub, so a node without it cannot participate. Helia's default
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
 * blockstore (bitswap retrieves through it), so the engine cannot resolve a head without
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

/** Thrown when a write (cast/withdraw) is attempted on a voter constructed without a signer. */
export class ReadOnlyError extends Error {
    constructor() {
        super(
            "This voter is read-only: it was constructed without a `signer`. " +
                "Provide a VoteSigner to cast or withdraw votes; reading tallies needs no signer."
        );
        this.name = "ReadOnlyError";
    }
}
