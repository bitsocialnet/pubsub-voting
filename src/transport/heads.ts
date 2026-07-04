import { CID } from "multiformats/cid";
import * as dagCbor from "@ipld/dag-cbor";

/**
 * The pubsub message payload: the current DAG head CIDs, dag-cbor-encoded as an array of
 * links. A head announcement carries NO authority — it is only a pointer; all trust comes
 * from re-verifying the bundle behind each head (see DESIGN.md "Transport"). Encoding is
 * the same canonical dag-cbor the rest of the protocol uses, so CIDs travel as native links.
 */

/** Encode head CIDs to a pubsub message payload. */
export function encodeHeads(heads: CID[]): Uint8Array {
    return dagCbor.encode(heads);
}

/**
 * Decode a pubsub message payload to head CIDs, throwing on anything that is not a bounded
 * dag-cbor array of well-formed CIDs. The gate treats a throw here as layer-1 badness
 * (`reject`) — the cheapest, pre-fetch check.
 */
export function decodeHeads(data: Uint8Array): CID[] {
    const decoded = dagCbor.decode(data);
    if (!Array.isArray(decoded)) throw new Error("heads message is not an array");
    const heads: CID[] = [];
    for (const item of decoded) {
        const cid = CID.asCID(item);
        if (!cid) throw new Error("heads message contains a non-CID element");
        heads.push(cid);
    }
    return heads;
}
