/**
 * Example: how a non-pkc host (seedit / plebbit) would call this library.
 *
 * The core is host-agnostic, so seedit does not use the pkc convenience path. It
 * supplies the three injected seams directly: its own running Helia node (with a
 * gossipsub service at `libp2p.services.pubsub` and a `blockstore`), a
 * `ChainClientFactory` (viem), and a `VoteSigner` wrapping the user's gating-chain
 * wallet (the account that holds the Pass/ERC-20). The engine is identical to 5chan's;
 * only the node and signer differ.
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

// seedit votes on a single contest it cares about rather than a whole directory, but v1
// still owns its contests through a manifest. A one-entry manifest wraps that single
// criteria (empty `defaults`, so the entry IS the whole document).
declare const criteria: Criteria;
const voter = new PubsubVoter({
    helia: seeditHelia(),
    chains: viemChains(),
    signer: seeditSigner(),
    manifest: { name: criteria.name, defaults: {}, contests: [criteria] }
});

const contest = await voter.getContest({ contestId: criteria.contestId });
await contest.start();

console.log(`contest ${contest.criteria.contestId} on topic ${contest.topic}`);
const tally = await contest.getTally();
console.log("ranking:", tally.ranking);

await contest.castVotes([{ community: { publicKey: "12D3KooW...community" }, vote: 1 }]);

// A host can also derive criteria from a manifest without constructing a voter at all
// — pure, no network — e.g. to precompute topics for a directory index.
declare const someManifest: unknown;
const allCriteria: Criteria[] = deriveCriteria(someManifest);
console.log(`${allCriteria.length} criteria derived`);
