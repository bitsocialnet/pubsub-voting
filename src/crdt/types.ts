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
     * {@link current} with each winner's CID alongside its bundle — the CID is the key the
     * engine's per-bundle check state ({@link BundleChecks}) is tracked under. The optional
     * `eligible` predicate restricts the LWW reduction to bundles it admits: the checkpoint
     * encoder passes "fully verified", so a provisionally admitted winner does not HIDE its
     * verified predecessor from the served checkpoint — the reduction falls back to the newest
     * bundle that IS eligible. No predicate reduces over everything (the tally's view).
     */
    currentEntries(currentBucket: number, eligible?: (cid: CID) => boolean): Array<{ cid: CID; bundle: VotesBundle }>;

    /**
     * Drop one bundle from the working set — the eviction path for a provisionally admitted
     * bundle whose deferred chain/name check failed (see verify/background.ts). Local
     * housekeeping of an invalid admit, not a protocol subtract: the union/LWW semantics over
     * VALID bundles are untouched, and the block bytes may stay in the blockstore.
     */
    remove(cid: CID): void;

    /**
     * Drop bundles older than `voteExpiryBuckets` and those superseded per wallet from the
     * in-memory working set, bounding memory. Correctness does not depend on it — `current`
     * filters expiry at read time — so this is housekeeping, not the guarantee. A superseded
     * bundle whose superseder is still provisional (per the injected `isProvisional`) is KEPT:
     * it is the fallback winner if the provisional bundle's deferred check evicts it. Returns
     * the removed CIDs so the engine can drop their per-bundle check state.
     */
    prune(currentBucket: number): Promise<CID[]>;

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
