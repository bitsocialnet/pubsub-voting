import { CID } from "multiformats/cid";
import * as dagCbor from "@ipld/dag-cbor";

/**
 * The pubsub message payload: the current winner bundle CIDs, dag-cbor-encoded as an array of
 * links. An announcement carries NO authority — each CID is only a pointer; all trust comes
 * from re-verifying the standalone bundle behind each CID (see DESIGN.md "Transport"). Encoding
 * is the same canonical dag-cbor the rest of the protocol uses, so CIDs travel as native links.
 */

/** Encode bundle CIDs to a pubsub message payload. */
export function encodeWinnerCids(cids: CID[]): Uint8Array {
    return dagCbor.encode(cids);
}

/**
 * Decode a pubsub message payload to bundle CIDs, throwing on anything that is not a bounded
 * dag-cbor array of well-formed CIDs. The gate treats a throw here as layer-1 badness
 * (`reject`) — the cheapest, pre-fetch check.
 */
export function decodeWinnerCids(data: Uint8Array): CID[] {
    const decoded = dagCbor.decode(data);
    if (!Array.isArray(decoded)) throw new Error("winner-CIDs message is not an array");
    const cids: CID[] = [];
    for (const item of decoded) {
        const cid = CID.asCID(item);
        if (!cid) throw new Error("winner-CIDs message contains a non-CID element");
        cids.push(cid);
    }
    return cids;
}
