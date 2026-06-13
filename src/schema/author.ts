import { z } from "zod";

/**
 * Author and wallet wire shapes.
 *
 * These mirror the pkc-js author/wallet schema exactly so a Votes bundle carries
 * a standard Bitsocial author. Source of truth upstream:
 *   pkc-js src/schema/schema.ts  (WalletSchema, AuthorWalletsSchema, ChainTickerSchema)
 *
 * Note: pkc-js defines the wallet *shape* but no binding verifier. The proof that
 * a chain wallet belongs to an author (the `signature` below) is verified in this
 * library, not upstream. See DESIGN.md "Wallet binding".
 */

/** Unix-epoch seconds. Matches pkc-js PKCTimestampSchema (positive integer). */
export const PKCTimestampSchema = z.number().int().positive();

/** Chain ticker is unrestricted for now ("eth", "btc", ...), matching pkc-js. */
export const ChainTickerSchema = z.string().min(1);

/**
 * A detached signature with an explicit type tag.
 * For Votes bundles `type` is the ed25519 scheme; for wallet bindings it is the
 * chain signature scheme (for example "eip191").
 */
export const SignatureSchema = z.object({
    signature: z.string().min(1),
    type: z.string().min(1)
});

/**
 * A wallet attached to an author. `signature` binds `address` (a chain address)
 * to the author address. `timestamp` gives the binding a monotonic version so a
 * compromised author key cannot be downgraded to an older binding.
 */
export const WalletSchema = z.object({
    address: z.string(),
    timestamp: PKCTimestampSchema,
    signature: SignatureSchema
});

/** chainTicker -> wallet. The eligibility chain's wallet carries voting weight. */
export const AuthorWalletsSchema = z.record(ChainTickerSchema, WalletSchema);

/**
 * The minimal author needed to vote: the immutable Bitsocial author address and
 * at least the wallets map. This is a subset of the pkc-js author; extra author
 * fields are not signed into a Votes bundle and are intentionally omitted.
 */
export const VoteAuthorSchema = z.object({
    address: z.string(),
    wallets: AuthorWalletsSchema
});

export type Signature = z.infer<typeof SignatureSchema>;
export type Wallet = z.infer<typeof WalletSchema>;
export type AuthorWallets = z.infer<typeof AuthorWalletsSchema>;
export type VoteAuthor = z.infer<typeof VoteAuthorSchema>;
