/**
 * Example: how 5chan would call this library.
 *
 * The library never takes a pkc instance — it takes the host's running Helia node
 * directly (no adapter). 5chan runs on pkc-js, so it passes pkc's shared node, today
 * reached at `pkc.clients.libp2pJsClients[key]._helia`. That node must carry a gossipsub
 * service at `libp2p.services.pubsub` and a `blockstore`, or construction throws
 * `MissingPubsubError` / `MissingBlockstoreError`. This is the same shape every host uses
 * (see seedit.ts). 5chan has one directory manifest with 63 slots; the client derives one
 * criteria document (one topic) per slot and renders the winning board for each.
 * Type-checks against the public API; the live engine methods throw `NotImplementedError`
 * until built.
 */
import { readFileSync } from "node:fs";
import stripJsonComments from "strip-json-comments";
import { PubsubVoter, type HeliaInstance, type ChainClientFactory, type VoteSigner } from "@bitsocial/pubsub-votes";

// The manifest is JSONC (commented for human readers), so strip comments before parsing.
const manifest: unknown = JSON.parse(
    stripJsonComments(readFileSync(new URL("../5chan-directory-criteria.jsonc", import.meta.url), "utf8"))
);

// Host-provided seams. 5chan wires these from pkc + viem in its own code.
declare function pkcHelia(): HeliaInstance; // pkc.clients.libp2pJsClients[key]._helia
declare function viemChains(): ChainClientFactory;
declare const signer: VoteSigner;

// One voter for the whole app. The Helia node (gossipsub + blockstore) is the only mandatory seam.
const voter = new PubsubVoter({ helia: pkcHelia(), chains: viemChains(), signer });

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
    await biz.castVotes([{ board: { name: "Business & Finance", publicKey: "12D3KooW...someBoardKey" }, vote: 1 }]);
    // Withdraw later by publishing an empty bundle:
    await biz.castVotes([]);
}
