/**
 * Example: a read-only consumer.
 *
 * Most uses of this library only render tallies and never cast — a homepage, a directory
 * index, a bot. Such a consumer never calls `createContestVote`, so it never touches key
 * material: the voter itself holds no identity, and reading needs none.
 */
import { PubsubVoter, topicFor, type HeliaInstance, type ChainClientFactory, type Criteria } from "@bitsocial/pubsub-voting";

declare function hostHelia(): HeliaInstance;
declare function viemChains(): ChainClientFactory;
declare const criteria: Criteria;

// The voter takes no identity at all — a signer belongs to a ballot, not to the client. A
// contest is addressed by its full criteria document; there is nothing else to configure.
const voter = new PubsubVoter({ helia: hostHelia(), chains: viemChains() });

// A SEEDER — an always-online, publicly dialable read-only peer — additionally announces
// provider records (each joined contest's criteria CID + checkpoint root + chunk CIDs) to the
// network's Delegated Routing V1 routers, so cold joiners discover it without waiting for
// gossipsub subscription propagation. Plain clients and browsers omit this (the default):
//
//   new PubsubVoter({ helia, chains, httpRouterUrls: ["https://routing.example"] });

const contest = await voter.createContest({ criteria });
const tally = await contest.getTally(); // reading needs no signer
console.log(tally.ranking[0]?.community);
// Or subscribe reactively: contest.on("update", () => render(contest.tally)); await contest.update();

// To cast a vote later, this same voter mints a ballot with whatever wallet the app has by
// then — `voter.createContestVote({ criteria, votes, signer })`. Nothing about the voter has
// to change, and a host holding several wallets publishes each ballot with its own.

// Topic derivation is pure and needs no voter at all:
console.log("topic:", await topicFor(criteria));
