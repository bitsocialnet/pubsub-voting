import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import { base58btc } from "multiformats/bases/base58";
import { z } from "zod";
import { encodeCanonical, dagCborCode } from "../encoding/canonical.js";
import { VotesBundleSchema, type VotesBundle } from "../schema/votes.js";

/**
 * VotesBundle <-> bytes, using the same canonical dag-cbor encoder as the criteria topic. A
 * bundle is a standalone dag-cbor block with no parent links; content-addressing makes the
 * CID a checksum over the bundle bytes, which is what the CRDT relies on to de-duplicate and
 * LWW-tiebreak (see DESIGN.md "CRDT").
 *
 * The block layout is BINARY (see DESIGN.md "Bundle wire encoding"): crypto material travels
 * as raw bytes, not strings — `address` as its 20 bytes, `signature.signature` as its 65
 * bytes, `community.publicKey` as the raw multihash behind the B58 IPNS name — roughly
 * halving a one-vote bundle. This is a *separate* serialization from the frozen EIP-712
 * signed struct (signer/eip712.ts): changing it re-hashes the bundle CID but never the
 * signature vector. Decoding maps each field back to the string form the schema and EIP-712
 * verification expect; hex round-trips to lowercase (signature recovery compares addresses
 * case-insensitively, so casing is presentation, not identity). The layout is pinned by the
 * fixed test vector in `codec.test.ts` — any change is a breaking wire change that re-freezes
 * the vector (and the checkpoint vector, which inlines these bytes).
 */

const ADDRESS_BYTES = 20;
const SIGNATURE_BYTES = 65;

// `z.instanceof(Uint8Array)` infers `Uint8Array<ArrayBuffer>`, which rejects the
// `ArrayBufferLike`-backed arrays multiformats/dag-cbor produce — hence the custom check.
const BytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array, "expected bytes");

/** The binary wire shape of one bundle block (dag-cbor map, canonical key order). */
const WireBundleSchema = z.object({
    address: BytesSchema,
    blockNumber: z.number().int().nonnegative(),
    signature: z.object({
        signature: BytesSchema,
        type: z.string().min(1)
    }),
    votes: z.array(
        z.object({
            community: z.object({
                name: z.string().optional(),
                publicKey: BytesSchema
            }),
            vote: z.number().int()
        })
    )
});
type WireBundle = z.infer<typeof WireBundleSchema>;

function hexToBytes(hex: string, expectedBytes: number, label: string): Uint8Array {
    if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex.length !== 2 + expectedBytes * 2) {
        throw new Error(`${label} must be 0x-hex of exactly ${expectedBytes} bytes`);
    }
    const out = new Uint8Array(expectedBytes);
    for (let i = 0; i < expectedBytes; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
    return out;
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = "0x";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
}

/** B58 IPNS name ("12D3KooW…", base58btc without the multibase prefix) -> raw multihash bytes. */
function publicKeyToBytes(publicKey: string): Uint8Array {
    return base58btc.decode(`z${publicKey}`);
}

/** Raw multihash bytes -> the B58 IPNS name (drop base58btc's leading `z`). */
function publicKeyFromBytes(bytes: Uint8Array): string {
    return base58btc.encode(bytes).slice(1);
}

/**
 * Map a (schema-valid) VotesBundle to its binary wire shape. Exported for the checkpoint
 * codec, which inlines these same wire objects into its chunk blocks so the byte saving
 * multiplies across every inlined winner.
 */
export function toWireBundle(bundle: VotesBundle): WireBundle {
    const parsed = VotesBundleSchema.parse(bundle);
    return {
        address: hexToBytes(parsed.address, ADDRESS_BYTES, "address"),
        blockNumber: parsed.blockNumber,
        signature: {
            signature: hexToBytes(parsed.signature.signature, SIGNATURE_BYTES, "signature.signature"),
            type: parsed.signature.type
        },
        votes: parsed.votes.map((vote) => ({
            community: {
                // dag-cbor rejects `undefined`, so an absent name omits the key entirely.
                ...(vote.community.name !== undefined ? { name: vote.community.name } : {}),
                publicKey: publicKeyToBytes(vote.community.publicKey)
            },
            vote: vote.vote
        }))
    };
}

/**
 * Map a decoded wire value back to a VotesBundle, validating both the wire shape and the
 * full bundle schema (B58 key, distinct communities, name bound). Throws on anything
 * malformed — callers on untrusted paths treat a throw as an invalid block.
 */
export function fromWireBundle(wire: unknown): VotesBundle {
    const parsed = WireBundleSchema.parse(wire);
    if (parsed.address.length !== ADDRESS_BYTES) throw new Error(`address must be ${ADDRESS_BYTES} bytes`);
    if (parsed.signature.signature.length !== SIGNATURE_BYTES) {
        throw new Error(`signature.signature must be ${SIGNATURE_BYTES} bytes`);
    }
    return VotesBundleSchema.parse({
        address: bytesToHex(parsed.address),
        blockNumber: parsed.blockNumber,
        signature: {
            signature: bytesToHex(parsed.signature.signature),
            type: parsed.signature.type
        },
        votes: parsed.votes.map((vote) => ({
            community: {
                ...(vote.community.name !== undefined ? { name: vote.community.name } : {}),
                publicKey: publicKeyFromBytes(vote.community.publicKey)
            },
            vote: vote.vote
        }))
    });
}

/** Canonically encode a VotesBundle to its binary dag-cbor block bytes. */
export function encodeBundle(bundle: VotesBundle): Uint8Array {
    return encodeCanonical(toWireBundle(bundle));
}

/** Decode binary block bytes back to a VotesBundle. Throws on malformed bytes. */
export function decodeBundle(bytes: Uint8Array): VotesBundle {
    return fromWireBundle(dagCbor.decode(bytes));
}

/** The CIDv1 (dag-cbor, sha2-256) content address of already-encoded bundle block bytes. */
export async function bundleCidForBytes(bytes: Uint8Array): Promise<CID> {
    const digest = await sha256.digest(bytes);
    return CID.createV1(dagCborCode, digest);
}

/** The CIDv1 (dag-cbor, sha2-256) content address of a VotesBundle. */
export async function bundleCid(bundle: VotesBundle): Promise<CID> {
    return bundleCidForBytes(encodeBundle(bundle));
}
