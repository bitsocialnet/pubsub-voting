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
} from "@bitsocial/pubsub-voting";

declare function hostHelia(): HeliaInstance;
declare function viemChains(): ChainClientFactory;
declare const criteria: Criteria;

// No `signer` → read-only voter. A contest is addressed by its full criteria document;
// there is nothing else to configure.
const voter = new PubsubVoter({ helia: hostHelia(), chains: viemChains() });
console.log("read-only:", voter.readOnly); // true

// A SEEDER — an always-online, publicly dialable read-only peer — additionally announces
// provider records (each joined contest's criteria CID + checkpoint root + chunk CIDs) to the
// network's Delegated Routing V1 routers, so cold joiners discover it without waiting for
// gossipsub subscription propagation. Plain clients and browsers omit this (the default):
//
//   new PubsubVoter({ helia, chains, httpRouterUrls: ["https://routing.example"] });

const contest = await voter.createContest({ criteria });
const tally = await contest.getTally(); // allowed — reading needs no signer
console.log(tally.ranking[0]?.community);
// Or subscribe reactively: contest.on("update", () => render(contest.tally)); await contest.update();

const vote = await voter.createContestVote({ criteria, votes: [{ community: { publicKey: "12D3KooW..." }, vote: 1 }] });
try {
    await vote.publish(); // throws ReadOnlyError (and emits an "error" event)
} catch (err) {
    if (err instanceof ReadOnlyError) console.log("cannot vote without a signer, as expected");
    else throw err;
}

// Topic derivation is pure and needs no voter at all:
console.log("topic:", await topicFor(criteria));
