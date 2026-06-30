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
