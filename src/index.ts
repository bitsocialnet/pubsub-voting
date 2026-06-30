/**
 * Public entry, design only.
 *
 * Re-exports the schemas and the design interfaces, and declares the top-level
 * VoteNetwork facade the implementation will provide. No runtime is implemented
 * yet; see DESIGN.md.
 */

// Schemas (runtime values) and their inferred types.
export * from "./schema/author.js";
export * from "./schema/votes.js";
export * from "./schema/criteria.js";
export * from "./interpreters/options.js";

// Design interfaces (types only).
export type * from "./interpreters/types.js";
export type * from "./chain/types.js";
export type * from "./verify/types.js";
export type * from "./crdt/types.js";
export type * from "./transport/types.js";
export type * from "./tally/types.js";

import type { Criteria } from "./schema/criteria.js";
import type { Vote, VotesBundle } from "./schema/votes.js";
import type { InterpreterRegistry } from "./interpreters/types.js";
import type { ChainClients } from "./chain/types.js";
import type { Libp2pHandle } from "./transport/types.js";
import type { ContestTally, TallyOptions } from "./tally/types.js";

/** Construction options for a VoteNetwork. */
export interface VoteNetworkOptions {
    /** The static criteria document; also derives the topic. */
    criteria: Criteria;
    /** Injected host node handle (today: pkc.clients.libp2pJsClients[key]._helia). */
    libp2p: Libp2pHandle;
    /** chainTicker -> client, built from `criteria.requires.chains`. */
    chains: ChainClients;
    /** Optional interpreter overrides that shadow built-ins by `type`. */
    interpreters?: Partial<InterpreterRegistry>;
}

/**
 * The top-level facade: join the topic, keep the CRDT in sync, cast votes, and
 * read tallies. This is the only object most consumers (for example 5chan) touch.
 */
export interface VoteNetwork {
    /** Join the topic, fetch and union heads from peers, subscribe to gossip. */
    start(): Promise<void>;
    /** Leave the topic and release the transport. Does not stop the host node. */
    stop(): Promise<void>;

    /**
     * Sign the given votes into a bundle for the current bucket, add it to the
     * CRDT, and broadcast the new heads. Returns the published bundle. Pass an empty
     * array to withdraw: a newer empty bundle supersedes the prior one under LWW.
     */
    castVotes(votes: Vote[]): Promise<VotesBundle>;

    /** Current contest ranking, verified lazily top-down. */
    getTally(options?: TallyOptions): Promise<ContestTally>;

    /** Fired when incoming votes change the state. */
    on(event: "update", cb: () => void): void;
}
