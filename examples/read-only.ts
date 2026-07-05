/**
 * Example: a read-only consumer.
 *
 * Most uses of this library only render tallies and never cast — a homepage, a
 * directory index, a bot. Such a consumer omits the `signer`, so it never touches key
 * material. Reading needs no identity; writing throws `ReadOnlyError`.
 */
import {
    PubsubVoter,
    ReadOnlyError,
    topicFor,
    type HeliaInstance,
    type ChainClientFactory,
    type Criteria
} from "@bitsocial/pubsub-votes";

declare function hostHelia(): HeliaInstance;
declare function viemChains(): ChainClientFactory;
declare const criteria: Criteria;

// No `signer` → read-only voter. The voter still owns its contests through a manifest; a
// one-entry manifest wraps the single criteria this consumer renders.
const voter = new PubsubVoter({
    helia: hostHelia(),
    chains: viemChains(),
    manifest: { name: criteria.name, defaults: {}, contests: [criteria] }
});
console.log("read-only:", voter.readOnly); // true

const contest = await voter.getContest({ contestId: criteria.contestId });
const tally = await contest.getTally(); // allowed
console.log(tally.ranking[0]?.board);

try {
    await contest.castVotes([{ board: { publicKey: "12D3KooW..." }, vote: 1 }]); // throws ReadOnlyError
} catch (err) {
    if (err instanceof ReadOnlyError) console.log("cannot vote without a signer, as expected");
    else throw err;
}

// Topic derivation is pure and needs no voter at all:
console.log("topic:", await topicFor(criteria));
