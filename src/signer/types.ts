import type { Signature, VoteAuthor } from "../schema/author.js";

/**
 * Identity seam (net-new).
 *
 * This is the third host-injected dependency, alongside the `HeliaInstance` (network +
 * blockstore) and `ChainClientFactory` (chain). It lets a host-agnostic core be driven by
 * pkc-js, plebbit, or a raw key without the library ever holding key material: the
 * library assembles the signed payload and asks the host to sign it.
 *
 * The signer owns the author identity and the wallet bindings, because those are
 * produced out of band (the EIP-191 wallet-binding message is signed once when a user
 * links a wallet — see DESIGN.md "Wallet binding", an open question on exact format).
 * The library only verifies bindings; it never creates them, so it needs no chain key
 * here. A voter constructed without a signer is read-only (renders tallies, cannot
 * cast). See DESIGN.md "Votes wire".
 */
export interface VoteSigner {
    /** The author address plus its wallet bindings, embedded into every bundle this signer produces. */
    author(): Promise<VoteAuthor> | VoteAuthor;
    /**
     * Sign the canonical bytes of a bundle's signed property names with the author's
     * ed25519 key (mirroring pkc-js `_signJson`). The library builds the bytes; the
     * private key stays in the host.
     */
    sign(signedPayload: Uint8Array): Promise<Signature> | Signature;
}
