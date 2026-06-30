/**
 * Example: how 5chan would call this library.
 *
 * The library never takes a pkc instance — it only needs a `Libp2pHandle`. 5chan runs
 * on pkc-js, so its host code adapts pkc's shared node (today reached at
 * `pkc.clients.libp2pJsClients[key]._helia`) into a `Libp2pHandle` and passes it to the
 * one `PubsubVoter` constructor. This is the same shape every host uses (see seedit.ts);
 * only the adapter differs. 5chan has one directory manifest with 63 slots; the client
 * derives one criteria document (one topic) per slot and renders the winning board for
 * each. Type-checks against the public API; the live engine methods throw
 * `NotImplementedError` until built.
 */
import { PubsubVoter, type Libp2pHandle, type ChainClientFactory, type VoteSigner } from "@bitsocial/pubsub-votes";
import manifest from "../5chan-directory-criteria.json" with { type: "json" };

// Host-provided seams. 5chan wires these from pkc + viem in its own code.
declare function pkcLibp2p(): Libp2pHandle; // wraps pkc.clients.libp2pJsClients[key]._helia
declare function viemChains(): ChainClientFactory;
declare const signer: VoteSigner;

// One voter for the whole app. libp2p is the only mandatory seam.
const voter = new PubsubVoter({ libp2p: pkcLibp2p(), chains: viemChains(), signer });

// Derive every directory slot from the manifest: 63 contests, one topic each.
const contests = await voter.contestsFromManifest(manifest);
console.log(`joined ${contests.length} directory contests`);

// Render the homepage: the winning board for each slot.
for (const contest of contests) {
    await contest.start();
    const tally = await contest.getTally();
    const winner = tally.ranking[0]?.board ?? "(no votes yet)";
    console.log(`${contest.criteria.contest}: ${winner}  [topic ${contest.topic}]`);
}

// Cast a vote in one slot. With a signer this is a write; v1 is one upvote per topic.
const biz = contests.find((c) => c.criteria.contest === "biz");
if (biz && !biz.readOnly) {
    await biz.castVotes([{ board: "12D3KooW...someBoardAddress", vote: 1 }]);
    // Withdraw later by publishing an empty bundle:
    await biz.castVotes([]);
}
