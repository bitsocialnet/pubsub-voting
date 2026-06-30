/**
 * Example: how a non-pkc host (seedit / plebbit) would call this library.
 *
 * The core is host-agnostic, so seedit does not use the pkc convenience path. It
 * supplies the three injected seams directly: its own running Helia node (with a
 * gossipsub service at `libp2p.services.pubsub` and a `blockstore`), a
 * `ChainClientFactory` (viem), and a `VoteSigner` wrapping the user's plebbit identity.
 * The engine is identical to 5chan's; only the node and signer differ.
 */
import {
    PubsubVoter,
    deriveCriteria,
    type HeliaInstance,
    type ChainClientFactory,
    type VoteSigner,
    type Criteria
} from "@bitsocial/pubsub-votes";

// Host-provided seams. seedit passes its own Helia node and wires chains + signer.
// (Bodies omitted here; this is the shape a host implements.)
declare function seeditHelia(): HeliaInstance;
declare function viemChains(): ChainClientFactory;
declare function seeditSigner(): VoteSigner;

const voter = new PubsubVoter({
    helia: seeditHelia(),
    chains: viemChains(),
    signer: seeditSigner()
});

// seedit votes on a single contest it cares about rather than a whole directory.
declare const criteria: Criteria;
const contest = await voter.contest(criteria);
await contest.start();

console.log(`contest ${contest.criteria.contest} on topic ${contest.topic}`);
const tally = await contest.getTally();
console.log("ranking:", tally.ranking);

await contest.castVotes([{ board: "12D3KooW...board", vote: 1 }]);

// A host can also derive criteria from a manifest without constructing a voter at all
// — pure, no network — e.g. to precompute topics for a directory index.
declare const someManifest: unknown;
const allCriteria: Criteria[] = deriveCriteria(someManifest);
console.log(`${allCriteria.length} criteria derived`);
