import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";

/**
 * Merkle-CRDT interfaces, design only.
 *
 * State is a last-write-wins element-set keyed by the gating-chain wallet
 * address. Each bundle is a dag-cbor DAG node linking the heads known at signing,
 * so the log is a Merkle-clock. Convergence is automatic (the join is commutative)
 * and missing history is detectable (a head commits to its ancestors).
 * See DESIGN.md "CRDT".
 */

/** One node in the Merkle-clock: a bundle plus the heads it linked at signing. */
export interface DagNode {
    value: VotesBundle;
    parents: CID[];
}

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
    /** Store a locally produced bundle as a new node, updating heads. Returns its CID. */
    add(bundle: VotesBundle): Promise<CID>;

    /**
     * Integrate remote heads: fetch any unknown nodes by CID, walk to known
     * ancestors, update heads. Idempotent and order-independent.
     */
    merge(heads: CID[]): Promise<void>;

    /** Current heads (the only thing broadcast over pubsub). */
    heads(): CID[];

    /** LWW reduction: at most one current bundle per wallet. */
    current(): VotesBundle[];

    /**
     * Drop bundles older than `voteExpiryBuckets` and those superseded per wallet.
     * Keeps the DAG and blockstore bounded.
     */
    prune(currentBucket: number): Promise<void>;
}

/**
 * Persistence for DAG nodes, backed by the host's Helia blockstore (dag-cbor).
 * Declared as its own seam so the CRDT can be tested against an in-memory store.
 */
export interface DagNodeStore {
    put(node: DagNode): Promise<CID>;
    get(cid: CID): Promise<DagNode | undefined>;
    has(cid: CID): Promise<boolean>;
}
