import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";

/**
 * State-based grow-only LWW winner-set interfaces.
 *
 * State is a last-write-wins element-set keyed by the gating-chain wallet address. Each
 * bundle is a standalone dag-cbor block addressed by its CID — it carries no parent links.
 * The live path gossips individual bundle CIDs; a peer fetches each unknown bundle by CID,
 * verifies it (at the transport gate), and LWW-merges it into its per-wallet winner-set.
 * There is no DAG to walk and no notion of history "heads" — convergence comes from
 * gossipsub flood, the heartbeat re-gossip, and checkpoint reconciliation.
 * See DESIGN.md "CRDT".
 */

/**
 * The conflict-resolution rule for two bundles claiming the same wallet:
 * higher blockNumber wins; tie broken by lower bundle CID. Returns the winner.
 * Pure and deterministic so all clients agree.
 */
export type LwwResolve = (a: { bundle: VotesBundle; cid: CID }, b: { bundle: VotesBundle; cid: CID }) => CID;

/**
 * The CRDT store. `add` and `merge` only ever grow knowledge; `current` is the
 * LWW reduction (one bundle per wallet) that the tally consumes.
 */
export interface VoteCrdt {
    /** Store a locally produced bundle as a standalone dag-cbor block. Returns its CID. */
    add(bundle: VotesBundle): Promise<CID>;

    /**
     * Integrate remote bundle CIDs: fetch any unknown bundle by CID and LWW-merge it into the
     * winner-set. There is no ancestor recursion — each CID is a standalone bundle. Idempotent
     * and order-independent.
     */
    merge(cids: CID[]): Promise<void>;

    /**
     * LWW reduction (at most one bundle per wallet), filtered to the given bucket: a wallet
     * whose winning bundle has expired drops out entirely, so neither the tally nor a
     * checkpoint ever carries a decayed vote. `currentBucket` is `bucketForBlock(currentBlock)`.
     */
    current(currentBucket: number): VotesBundle[];

    /**
     * Drop bundles older than `voteExpiryBuckets` and those superseded per wallet from the
     * in-memory working set, bounding memory. Correctness does not depend on it — `current`
     * filters expiry at read time — so this is housekeeping, not the guarantee.
     */
    prune(currentBucket: number): Promise<void>;

    /** Size of the in-memory working set — lets callers/tests observe that `prune` shrinks it. */
    nodeCount(): number;
}

/**
 * Persistence for vote bundles, backed by the host's Helia blockstore (dag-cbor).
 * Declared as its own seam so the CRDT can be tested against an in-memory store.
 */
export interface BundleStore {
    put(bundle: VotesBundle): Promise<CID>;
    /** `options.signal` cancels an in-flight bitswap fetch (the gate's per-fetch timeout aborts it). */
    get(cid: CID, options?: { signal?: AbortSignal }): Promise<VotesBundle | undefined>;
    has(cid: CID): Promise<boolean>;
}
