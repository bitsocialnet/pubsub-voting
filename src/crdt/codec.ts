import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import { encodeCanonical, dagCborCode } from "../encoding/canonical.js";
import type { VotesBundle } from "../schema/votes.js";

/**
 * VotesBundle <-> bytes, using the same canonical dag-cbor encoder as the criteria topic. A
 * bundle is a standalone dag-cbor block with no parent links; content-addressing makes the
 * CID a checksum over the bundle bytes, which is what the CRDT relies on to de-duplicate and
 * LWW-tiebreak (see DESIGN.md "CRDT").
 */

/** Canonically encode a VotesBundle to dag-cbor bytes. */
export function encodeBundle(bundle: VotesBundle): Uint8Array {
    return encodeCanonical(bundle);
}

/** Decode dag-cbor bytes back to a VotesBundle. */
export function decodeBundle(bytes: Uint8Array): VotesBundle {
    return dagCbor.decode<VotesBundle>(bytes);
}

/** The CIDv1 (dag-cbor, sha2-256) content address of a VotesBundle. */
export async function bundleCid(bundle: VotesBundle): Promise<CID> {
    const digest = await sha256.digest(encodeBundle(bundle));
    return CID.createV1(dagCborCode, digest);
}
