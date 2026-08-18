import { base64 } from "multiformats/bases/base64";
import { sha256 } from "multiformats/hashes/sha2";
import { MissingPrivateKeyError } from "../../errors.js";
import type { AnnounceSigner, AnnouncerLibp2p } from "./types.js";

/**
 * The signed provider record the announcer PUTs (IPIP-0526, as implemented by the production
 * router — pkc-http-router `lib/signature.ts`). Verification is ON by default there, so an
 * unsigned record is a 403 for the WHOLE request: the announcing node is simply absent from
 * every verifying router (issue #38 — four of six default routers rejected every announce).
 *
 * Two things make a record verifiable:
 *
 * - **`Signature`** — multibase (base64, the `m` prefix) over the sha256 digest of the raw
 *   `Payload` bytes, made by the private key the announcing peer id was derived from. libp2p's
 *   `PrivateKey.sign` is what the router's key types line up with: an ed25519 key signs those 32
 *   digest bytes directly (`crypto.verify(null, digest, key, sig)`), a secp256k1 key hashes them
 *   again through ECDSA (`crypto.verify("sha256", digest, key, sig)`) — both are exactly
 *   `sign(digest)` on this side. The public key is recovered from `Payload.ID` itself (an identity
 *   multihash), so nothing else has to travel.
 * - **`Payload.Timestamp`** — epoch milliseconds, read fresh per announce: the router rejects a
 *   missing one, and bounds it against replay (24 h stale / 1 h future). Never cache it.
 *
 * **The bytes signed must be the bytes sent.** The router verifies against the `Payload` byte
 * range it locates in the raw request body (`extractRawPayloads`), not against a re-serialized
 * parse of it — so serializing the payload to sign it and then handing the enclosing object to
 * `JSON.stringify` a second time is a real (and observed) failure mode: any difference in key
 * order, spacing, or number formatting reads as `invalid_signature`. Hence this builder
 * serializes the payload ONCE and splices that exact string into the body it returns; the body is
 * a string all the way to `fetch`, and no object is ever re-serialized.
 */

/** What the announcer signs with: libp2p's `PrivateKey` surface, narrowed to `sign`. */
export type { AnnounceSigner };

/**
 * Find the injected node's signing key. libp2p keeps it on the `components` registry of the
 * running node (it is deliberately absent from the public `Libp2p` interface, which exposes only
 * the derived `peerId`); `privateKey` is checked first so a host that surfaces it directly — or a
 * test double — is honoured without reaching into internals. Structural, like every other host
 * probe in `transport/`: the injected node is `unknown` shaped, never trusted by type.
 *
 * Throws {@link MissingPrivateKeyError} when no key is reachable, at construction, rather than
 * announcing records every verifying router will reject.
 */
export function requireAnnounceSigner(libp2p: AnnouncerLibp2p): AnnounceSigner {
    const direct: unknown = libp2p.privateKey;
    if (isSigner(direct)) return direct;
    const component: unknown = libp2p.components?.privateKey;
    if (isSigner(component)) return component;
    throw new MissingPrivateKeyError();
}

function isSigner(value: unknown): value is AnnounceSigner {
    return value !== null && typeof value === "object" && typeof (value as AnnounceSigner).sign === "function";
}

/** What one announce says: who, where, which CIDs, and when it was said. */
export interface AnnounceRecord {
    /** The announcing node's peer id — also where the router recovers the verifying key from. */
    peerId: string;
    /** Already filtered/synthesized by the caller (see `announceableAddrs` / `sentinelAddrs`). */
    addrs: readonly string[];
    /** Every joined contest's criteria CID + checkpoint root + chunk CIDs, batched. */
    keys: readonly string[];
    /** Epoch ms, read fresh per announce (the router bounds staleness and skew). */
    timestamp: number;
}

/**
 * Build the signed `PUT /routing/v1/providers` body, as the exact string to send. Returns a
 * string — not an object — on purpose: the signature covers the `Payload` substring inside it,
 * and re-serializing anything here would break it (see the module comment).
 */
export async function signedProvidersBody(record: AnnounceRecord, signer: AnnounceSigner): Promise<string> {
    const payloadJson = JSON.stringify({
        ID: record.peerId,
        Addrs: record.addrs,
        Keys: record.keys,
        Timestamp: record.timestamp
    });
    const digest = (await sha256.digest(new TextEncoder().encode(payloadJson))).digest;
    const signature = base64.encode(await signer.sign(digest));
    return `{"Providers":[{"Schema":"peer","Signature":${JSON.stringify(signature)},"Payload":${payloadJson}}]}`;
}
