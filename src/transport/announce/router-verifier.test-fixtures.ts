import crypto from "node:crypto";
import { bases } from "multiformats/basics";
import { decode as decodeMultihash } from "multiformats/hashes/digest";

/**
 * A faithful mirror of the production router's record verifier (pkc-http-router `lib/signature.ts`
 * + `lib/raw-json.ts`, IPIP-0526), used as a TEST FIXTURE — never shipped and never imported by
 * library code.
 *
 * Two things it must copy exactly, because they are what the announcer has to satisfy:
 *
 * - The signature is checked against the `Payload` bytes **located in the raw request body**, not
 *   against a re-serialization of the parsed object. So {@link rawPayload} scans the body string
 *   for the payload's byte range, exactly as the router does — which is the only way a test can
 *   catch an announcer that signs one serialization and sends another (the `invalid_signature`
 *   trap in issue #38, distinct from the `missing_signature` bug it was filed for).
 * - The verifying key is recovered from `Payload.ID` alone: the peer id's identity multihash
 *   carries the libp2p `PublicKey` protobuf, so a record signed by any other key fails even
 *   though it is perfectly well-formed.
 */

/** Why a record was refused — the router's own low-cardinality reasons, same spellings. */
export type VerifyFailureReason =
    | "missing_signature"
    | "missing_id"
    | "missing_payload_bytes"
    | "unsupported_key"
    | "invalid_signature"
    | "missing_timestamp"
    | "stale_timestamp"
    | "future_timestamp";

export interface VerifyResult {
    valid: boolean;
    reason?: VerifyFailureReason;
    error?: string;
}

/** The router's replay bounds: 24 h stale, 1 h ahead (clock skew). */
const MAX_TIMESTAMP_AGE_MS = 1000 * 60 * 60 * 24;
const MAX_TIMESTAMP_SKEW_MS = 1000 * 60 * 60;

const IDENTITY_MULTIHASH_CODE = 0x00;
const KEY_TYPE_ED25519 = 1;
/** DER prefix that turns a raw ed25519 public key into an SPKI document node's crypto imports. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * The byte range of `Providers[0].Payload` inside the raw body, as the router's scanner finds it:
 * a brace-balanced skip that never mistakes payload content for structure. Returns the exact
 * substring — signing anything else is what the router calls `invalid_signature`.
 */
export function rawPayload(body: string): string | undefined {
    const key = '"Payload":';
    const keyIndex = body.indexOf(key);
    if (keyIndex === -1) return undefined;
    let index = keyIndex + key.length;
    while (index < body.length && /\s/.test(body[index]!)) index++;
    if (body[index] !== "{") return undefined;
    const start = index;
    let depth = 0;
    let inString = false;
    for (; index < body.length; index++) {
        const char = body[index]!;
        if (inString) {
            if (char === "\\") index++;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) return body.slice(start, index + 1);
    }
    return undefined;
}

/** Every multibase encoding is accepted, exactly like the router; the reference client uses `m`. */
function decodeMultibase(text: string): Uint8Array {
    const base = Object.values(bases).find((candidate) => candidate.prefix === text[0]);
    if (base === undefined) throw new Error(`unknown multibase prefix '${text[0]}'`);
    return base.decode(text);
}

/** The two fields of libp2p's `PublicKey` protobuf (`KeyType Type = 1; bytes Data = 2`). */
function decodePublicKeyProtobuf(bytes: Uint8Array): { type: number; data: Uint8Array } {
    let index = 0;
    let type: number | undefined;
    let data: Uint8Array | undefined;
    const readVarint = (): number => {
        let value = 0;
        let shift = 0;
        while (index < bytes.length) {
            const byte = bytes[index++]!;
            value += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) return value;
            shift += 7;
        }
        throw new Error("truncated varint");
    };
    while (index < bytes.length) {
        const tag = readVarint();
        const field = tag >> 3;
        const wireType = tag & 0x7;
        if (field === 1 && wireType === 0) type = readVarint();
        else if (field === 2 && wireType === 2) {
            const length = readVarint();
            data = bytes.subarray(index, index + length);
            index += length;
        } else if (wireType === 0) readVarint();
        else if (wireType === 2) index += readVarint();
        else throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
    if (type === undefined || data === undefined) throw new Error("public key protobuf missing Type or Data");
    return { type, data };
}

/**
 * The verifying key, recovered from the peer id itself: base58btc → multihash → (identity only)
 * the libp2p `PublicKey` protobuf. Only ed25519 is mirrored here — it is what every js-libp2p node
 * this library runs on uses, and an rsa/ecdsa peer id could not be verified by the router either.
 */
export function publicKeyFromPeerId(peerId: string): crypto.KeyObject {
    const multihash = decodeMultihash(bases.base58btc.baseDecode(peerId));
    if (multihash.code !== IDENTITY_MULTIHASH_CODE) throw new Error(`peer id '${peerId}' does not embed a public key`);
    const { type, data } = decodePublicKeyProtobuf(multihash.digest);
    if (type !== KEY_TYPE_ED25519) throw new Error(`peer id '${peerId}' uses unsupported key type ${type}`);
    if (data.length !== 32) throw new Error(`ed25519 public key of peer id '${peerId}' is ${data.length} bytes`);
    return crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(data)]),
        format: "der",
        type: "spki"
    });
}

/**
 * Verify one `PUT /routing/v1/providers` body the way the production router does: signature over
 * the sha256 digest of the raw payload bytes (ed25519 signs the digest directly), then the
 * timestamp's replay bounds. Takes the body as the STRING that went on the wire — handing it a
 * parsed object would defeat the point.
 */
export function verifyProvidersBody(body: string, now: number = Date.now()): VerifyResult {
    const parsed = JSON.parse(body) as {
        Providers?: Array<{ Signature?: string; Payload?: { ID?: string; Timestamp?: number } }>;
    };
    const provider = parsed.Providers?.[0];
    if (typeof provider?.Signature !== "string" || !provider.Signature) {
        return { valid: false, reason: "missing_signature", error: "record has no Signature" };
    }
    if (typeof provider.Payload?.ID !== "string" || !provider.Payload.ID) {
        return { valid: false, reason: "missing_id", error: "record has no Payload.ID" };
    }
    const payload = rawPayload(body);
    if (payload === undefined || payload.length === 0) {
        return { valid: false, reason: "missing_payload_bytes", error: "could not read the Payload bytes of the request body" };
    }
    let key: crypto.KeyObject;
    try {
        key = publicKeyFromPeerId(provider.Payload.ID);
    } catch (error) {
        return { valid: false, reason: "unsupported_key", error: (error as Error).message };
    }
    let signature: Uint8Array;
    try {
        signature = decodeMultibase(provider.Signature);
    } catch (error) {
        return { valid: false, reason: "invalid_signature", error: `could not decode Signature: ${(error as Error).message}` };
    }
    const digest = crypto.createHash("sha256").update(Buffer.from(payload, "utf8")).digest();
    if (!crypto.verify(null, digest, key, signature)) {
        return { valid: false, reason: "invalid_signature", error: "signature does not match the Payload" };
    }
    const timestamp = provider.Payload.Timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        return { valid: false, reason: "missing_timestamp", error: "record has no Payload.Timestamp" };
    }
    if (timestamp < now - MAX_TIMESTAMP_AGE_MS) {
        return { valid: false, reason: "stale_timestamp", error: `Payload.Timestamp ${timestamp} is too old` };
    }
    if (timestamp > now + MAX_TIMESTAMP_SKEW_MS) {
        return { valid: false, reason: "future_timestamp", error: `Payload.Timestamp ${timestamp} is in the future` };
    }
    return { valid: true };
}

/** An ed25519 test peer: a real key plus the peer id derived from it, as libp2p derives one. */
export interface TestPeer {
    peerId: string;
    /** Signs like libp2p's `Ed25519PrivateKey.sign`: raw ed25519 over the bytes it is handed. */
    sign(data: Uint8Array): Uint8Array;
}

/** Protobuf header of an ed25519 `PublicKey`: `Type = 1`, `Data` = the 32 raw key bytes. */
const ED25519_PUBLIC_KEY_PROTOBUF_PREFIX = Buffer.from([0x08, 0x01, 0x12, 0x20]);

/** Generate a peer whose id embeds its public key — the only kind whose records can be verified. */
export function createTestPeer(): TestPeer {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const raw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
    const protobuf = Buffer.concat([ED25519_PUBLIC_KEY_PROTOBUF_PREFIX, raw]);
    // Identity multihash: code 0x00, then the length (36 — one varint byte).
    const multihash = Buffer.concat([Buffer.from([0x00, protobuf.length]), protobuf]);
    return {
        peerId: bases.base58btc.baseEncode(multihash),
        sign: (data) => crypto.sign(null, data, privateKey)
    };
}
