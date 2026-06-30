import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { Criteria } from "./schema/criteria.js";
import { encodeCriteria, dagCborCode } from "./encoding/canonical.js";

/**
 * Topic derivation.
 *
 *   topic = "bitsocial-votes/" + CID(dag-cbor(criteria))
 *
 * The topic is the content address of the criteria document, so subscribing to a
 * topic is itself proof that two peers ran byte-identical rules. A different value
 * (different contest, gate, expiry, ...) yields different bytes, a different CID, and
 * therefore a different topic — which is how criteria upgrades fork cleanly. Reordering
 * keys does NOT fork the topic, because dag-cbor sorts them. See DESIGN.md
 * "Criteria document". Pure and offline: no libp2p/helia, no network.
 */

/** Prefix that namespaces every vote topic. */
export const TOPIC_PREFIX = "bitsocial-votes/";

/** The CIDv1 (dag-cbor, sha2-256) of a criteria document's canonical encoding. */
export async function criteriaCid(criteria: Criteria): Promise<CID> {
    const bytes = encodeCriteria(criteria);
    const digest = await sha256.digest(bytes);
    return CID.createV1(dagCborCode, digest);
}

/** The gossipsub topic a criteria document maps to. */
export async function topicFor(criteria: Criteria): Promise<string> {
    const cid = await criteriaCid(criteria);
    return TOPIC_PREFIX + cid.toString();
}
