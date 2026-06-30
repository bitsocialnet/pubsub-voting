import * as dagCbor from "@ipld/dag-cbor";
import type { Criteria } from "../schema/criteria.js";

/**
 * Canonical encoding.
 *
 * dag-cbor is itself the canonical form the whole protocol relies on: it sorts map
 * keys deterministically and rejects `undefined`, so identical logical objects encode
 * to identical bytes regardless of authoring key order. That property is what makes
 * `topic = CID(dag-cbor(criteria))` a self-validating binding (see DESIGN.md
 * "Criteria document"). Nothing here re-implements canonicalisation; it just names the
 * single encoder the rest of the library must route through so the bytes never diverge.
 *
 * This module is pure and has no libp2p/helia import, so it is unit-testable offline.
 */

/** Canonically encode any dag-cbor-safe value to bytes. */
export function encodeCanonical(value: unknown): Uint8Array {
    return dagCbor.encode(value);
}

/**
 * Canonically encode a criteria document. This is the exact byte sequence whose CID
 * becomes the pubsub topic, so it MUST be stable across clients and library versions.
 */
export function encodeCriteria(criteria: Criteria): Uint8Array {
    return dagCbor.encode(criteria);
}

/** The dag-cbor codec code (0x71), exposed so callers build CIDs with the right codec. */
export const dagCborCode = dagCbor.code;
