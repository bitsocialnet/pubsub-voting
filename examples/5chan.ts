/**
 * Example: how 5chan would call this library.
 *
 * The library never takes a pkc instance — it takes the host's running Helia node
 * directly (no adapter). 5chan runs on pkc-js, so it passes pkc's shared node, today
 * reached at `pkc.clients.libp2pJsClients[key]._helia`. That node must carry a gossipsub
 * service at `libp2p.services.pubsub`, a `blockstore`, and a libp2p fetch service at
 * `libp2p.services.fetch` (`@libp2p/fetch` — the checkpoint root-record pull), or
 * construction throws `MissingPubsubError` / `MissingBlockstoreError` /
 * `MissingFetchError`. This is the same shape every host uses
 * (see seedit.ts). 5chan has one directory manifest with 63 slots; the client derives one
 * criteria document (one topic) per slot and renders the winning community for each.
 * Type-checks against the public API, and every method used here — `start`, `castVotes`,
 * `forget`, `getTally`, `stop`/`destroy`, and the republish scheduler — is live.
 */
import { readFileSync } from "node:fs";
import stripJsonComments from "strip-json-comments";
import {
    PubsubVoter,
    type HeliaInstance,
    type ChainClientFactory,
    type VoteSigner,
    type NameResolver
} from "@bitsocial/pubsub-votes";

// The manifest is JSONC (commented for human readers), so strip comments before parsing.
const manifest: unknown = JSON.parse(
    stripJsonComments(readFileSync(new URL("../5chan-directory-criteria.jsonc", import.meta.url), "utf8"))
);

// Host-provided seams. 5chan wires these from pkc + viem in its own code. The name
// resolvers are the same instances 5chan already gives pkc-js (e.g. @bitsocial/
// bso-resolver's BsoResolver for name.bso) — needed because votes carry community names,
// whose name→publicKey claim the tally verifies before counting.
declare function pkcHelia(): HeliaInstance; // pkc.clients.libp2pJsClients[key]._helia
declare function viemChains(): ChainClientFactory;
declare const signer: VoteSigner;
declare const bsoResolver: NameResolver; // e.g. new BsoResolver({ key: "bso-viem", provider: "viem" })

// One voter for the whole app. The manifest is owned by the voter, so a single
// `voter.start()` joins all 63 directory contests and keeps this wallet's votes
// republished (re-signed with a fresh blockNumber on each contest's liveness cadence).
// The Helia node (gossipsub + blockstore + fetch service) is the only mandatory seam. `dataPath` (Node,
// same convention as pkc-js) keeps this wallet's vote intents in a SQLite file so
// republishing resumes after a restart.
const voter = new PubsubVoter({
    helia: pkcHelia(),
    chains: viemChains(),
    signer,
    nameResolvers: [bsoResolver],
    manifest,
    dataPath: "./.5chan-votes"
});

// Join every slot and arm republishing in one call.
await voter.start();

// Render the homepage: the winning community for each slot. The voter owns the manifest, so it
// already knows every contest — reach each by its `contestId` (networks cache by topic, so
// these are the very networks start() joined).
const contests = await Promise.all(voter.contestIds.map((contestId) => voter.getContest({ contestId })));
console.log(`joined ${contests.length} directory contests`);

for (const contest of contests) {
    const tally = await contest.getTally();
    const winner = tally.ranking[0]?.community ?? "(no votes yet)";
    console.log(`${contest.criteria.contestId}: ${winner}  [topic ${contest.topic}]`);
}

// Cast a vote in one slot. With a signer this is a write; v1 is one upvote per topic.
const biz = await voter.getContest({ contestId: "biz" });
if (!biz.readOnly) {
    // `name` must be the community's resolvable domain (unique per community); the tally
    // drops any vote whose name does not resolve to the claimed publicKey.
    await biz.castVotes([{ community: { name: "bizfinance.bso", publicKey: "12D3KooW...someCommunityKey" }, vote: 1 }]);
    // Withdraw later, two ways:
    await biz.castVotes([]);                    // active: broadcast an empty bundle that supersedes under LWW; the scheduler re-announces the tombstone (no re-sign) until it expires, then drops it
    await voter.forget({ contestId: "biz" });   // passive: drop the stored intent, publish nothing, and let the vote decay at its own expiry
}

// On shutdown: stop every republish loop, leave all topics, and dispose the vote store.
await voter.destroy();
