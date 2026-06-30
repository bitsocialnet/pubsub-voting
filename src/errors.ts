/**
 * Library error types.
 *
 * The pure foundation (schema, canonical encoding, topic derivation, manifest
 * derivation) and the public facade construction are fully implemented. The live
 * engine (CRDT, transport, verify, tally, chain reads) is still design-only, so the
 * facade methods that depend on it throw `NotImplementedError` rather than pretending
 * to work. See DESIGN.md for the build order.
 */

/** Thrown by facade methods whose backing engine is not yet implemented. */
export class NotImplementedError extends Error {
    constructor(what: string) {
        super(
            `${what} is not implemented yet: the live engine (CRDT/transport/verify/tally/chain) ` +
                `is still in design. The schema, canonical encoding, topic derivation, and manifest ` +
                `derivation are implemented. See DESIGN.md for the build order.`
        );
        this.name = "NotImplementedError";
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
