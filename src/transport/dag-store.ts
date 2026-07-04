import type { DagNode, DagNodeStore } from "../crdt/types.js";
import { encodeDagNode, decodeDagNode, dagNodeCid } from "../crdt/codec.js";
import type { BlockstoreLike } from "./types.js";

/**
 * A {@link DagNodeStore} backed by the host's Helia blockstore. `put` writes a dag-cbor
 * block locally; `get` reads by CID — and because bitswap retrieves through the blockstore,
 * an unknown CID is fetched from peers. A fetch that fails or times out surfaces as
 * `undefined` (not a throw), which the forward-gate reads as "unfetchable -> ignore" rather
 * than a provable fault. Lives in transport/ (not crdt/) because it touches the blockstore;
 * the CRDT stays libp2p-free.
 */
export function makeBlockstoreDagNodeStore(blockstore: BlockstoreLike): DagNodeStore {
    return {
        async put(node: DagNode) {
            const cid = await dagNodeCid(node);
            await blockstore.put(cid, encodeDagNode(node));
            return cid;
        },
        async get(cid) {
            try {
                return decodeDagNode(await blockstore.get(cid));
            } catch {
                return undefined; // unfetchable / undecodable — gate treats as ignore
            }
        },
        async has(cid) {
            try {
                return await blockstore.has(cid);
            } catch {
                return false;
            }
        }
    };
}
