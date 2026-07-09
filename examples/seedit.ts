/**
 * Example: how a non-pkc host (seedit / plebbit) would call this library.
 *
 * The core is host-agnostic, so seedit does not use the pkc convenience path. It
 * supplies the three injected seams directly: its own running Helia node (with a
 * gossipsub service at `libp2p.services.pubsub`, a `blockstore`, and a libp2p fetch
 * service at `libp2p.services.fetch`), a
 * `ChainClientFactory` (viem), and a `VoteSigner` wrapping the user's gating-chain
 * wallet (the account that holds the Pass/ERC-20). The engine is identical to 5chan's;
 * only the node and signer differ.
 */
import {
    PubsubVoter,
    topicFor,
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

// seedit votes on a single contest it cares about. A contest is addressed by its full
// criteria document — the exact bytes every participant shares (the topic is their CID),
// so seedit ships the document with the app and passes it straight to the create calls.
declare const criteria: Criteria;
const voter = new PubsubVoter({
    helia: seeditHelia(),
    chains: viemChains(),
    signer: seeditSigner()
});

const contest = await voter.createContest({ criteria });
await contest.update(); // start syncing this contest

console.log(`contest ${contest.criteria.contestId} on topic ${contest.topic}`);
const tally = await contest.getTally();
console.log("ranking:", tally.ranking);

const vote = await voter.createContestVote({ criteria, votes: [{ community: { publicKey: "12D3KooW...community" }, vote: 1 }] });
await vote.publish();
// Keeping the vote alive is seedit's job: re-publish before it expires (see republishIntervalBuckets).

// Topic derivation is pure and needs no voter — e.g. to precompute a directory index.
console.log("topic:", await topicFor(criteria));
