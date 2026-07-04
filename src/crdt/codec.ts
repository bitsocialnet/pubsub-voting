import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import { encodeCanonical, dagCborCode } from "../encoding/canonical.js";
import type { DagNode } from "./types.js";

/**
 * DagNode <-> bytes, using the same canonical dag-cbor encoder as the criteria topic. A
 * node is `{ value: VotesBundle, parents: CID[] }`; dag-cbor encodes the parent CIDs as
 * native links, so the node is a proper Merkle-DAG block. Content-addressing makes the
 * CID a checksum over the bundle plus its linked history — the property the CRDT relies on
 * to detect truncated state and de-duplicate (see DESIGN.md "CRDT").
 */

/** Canonically encode a DagNode to dag-cbor bytes. */
export function encodeDagNode(node: DagNode): Uint8Array {
    return encodeCanonical({ value: node.value, parents: node.parents });
}

/** Decode dag-cbor bytes back to a DagNode (parent links come back as CID instances). */
export function decodeDagNode(bytes: Uint8Array): DagNode {
    return dagCbor.decode<DagNode>(bytes);
}

/** The CIDv1 (dag-cbor, sha2-256) content address of a DagNode. */
export async function dagNodeCid(node: DagNode): Promise<CID> {
    const digest = await sha256.digest(encodeDagNode(node));
    return CID.createV1(dagCborCode, digest);
}
