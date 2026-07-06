import type { BundleStore } from "../crdt/types.js";
import type { VotesBundle } from "../schema/votes.js";
import { encodeBundle, decodeBundle, bundleCid } from "../crdt/codec.js";
import type { BlockstoreLike } from "./types.js";

/**
 * A {@link BundleStore} backed by the host's Helia blockstore. `put` writes a bundle as a
 * dag-cbor block locally; `get` reads by CID — and because bitswap retrieves through the
 * blockstore, an unknown CID is fetched from peers. A fetch that fails or times out surfaces
 * as `undefined` (not a throw), which the forward-gate reads as "unfetchable -> ignore"
 * rather than a provable fault. Lives in transport/ (not crdt/) because it touches the
 * blockstore; the CRDT stays libp2p-free.
 */
export function makeBlockstoreBundleStore(blockstore: BlockstoreLike): BundleStore {
    return {
        async put(bundle: VotesBundle) {
            const cid = await bundleCid(bundle);
            await blockstore.put(cid, encodeBundle(bundle));
            return cid;
        },
        async get(cid, options) {
            try {
                return decodeBundle(await blockstore.get(cid, options));
            } catch {
                return undefined; // unfetchable / undecodable / aborted — gate treats as ignore
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
