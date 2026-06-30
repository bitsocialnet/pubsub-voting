/**
 * Example: how a non-pkc host (seedit / plebbit) would call this library.
 *
 * The core is host-agnostic, so seedit does not use the pkc convenience path. It
 * supplies the three injected seams directly: a `Libp2pHandle` adapting its own
 * libp2p/Helia node, a `ChainClientFactory` (viem), and a `VoteSigner` wrapping the
 * user's plebbit identity. The engine is identical to 5chan's; only the seams differ.
 */
import {
    PubsubVoter,
    deriveCriteria,
    type Libp2pHandle,
    type ChainClientFactory,
    type VoteSigner,
    type Criteria
} from "@bitsocial/pubsub-votes";

// Host-provided adapters. Each maps seedit's runtime onto the library's seam type.
// (Bodies omitted here; this is the shape a host implements.)
declare function seeditLibp2p(): Libp2pHandle;
declare function viemChains(): ChainClientFactory;
declare function seeditSigner(): VoteSigner;

const voter = new PubsubVoter({
    libp2p: seeditLibp2p(),
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
