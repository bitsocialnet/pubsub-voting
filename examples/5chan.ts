/**
 * Example: how 5chan would call this library.
 *
 * The library never takes a pkc instance — it takes the host's running Helia node
 * directly (no adapter). 5chan runs on pkc-js, so it passes pkc's shared node, today
 * reached at `pkc.clients.libp2pJsClients[key]._helia`. That node must carry a gossipsub
 * service at `libp2p.services.pubsub`, a `blockstore`, and a libp2p fetch service at
 * `libp2p.services.fetch` (`@libp2p/fetch` — the checkpoint root-record pull), or
 * construction throws `MissingPubsubError` / `MissingBlockstoreError` /
 * `MissingFetchError`. This is the same shape every host uses (see seedit.ts). 5chan has one
 * directory manifest with 63 slots; the client derives one criteria document (one topic) per
 * slot and renders the winning community for each. Type-checks against the public API — the
 * reactive `PubsubVoter` / `Contest` (`createContest`) / `ContestVote` (`createContestVote`)
 * facade. Keeping a vote alive is 5chan's job: it tracks what it voted for and refreshes on the
 * `republishIntervalBuckets` cadence (this library never re-publishes on its own).
 */
import { readFileSync } from "node:fs";
import stripJsonComments from "strip-json-comments";
import {
    PubsubVoter,
    DirectoryManifestSchema,
    republishIntervalBuckets,
    type HeliaInstance,
    type ChainClientFactory,
    type VoteSigner,
    type NameResolver
} from "@bitsocial/pubsub-votes";

// The manifest is JSONC (commented for human readers), so strip comments before parsing.
// Validate it through the schema at load: this yields a typed `DirectoryManifest` and
// surfaces a malformed file here rather than deep in the constructor.
const manifest = DirectoryManifestSchema.parse(
    JSON.parse(stripJsonComments(readFileSync(new URL("../5chan-directory-criteria.jsonc", import.meta.url), "utf8")))
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
// `voter.start()` joins and serves all 63 directory contests. The Helia node
// (gossipsub + blockstore + fetch service) is the only mandatory seam. There is no
// library-side persistence: 5chan keeps track of its own votes and republishes them itself.
const voter = new PubsubVoter({
    helia: pkcHelia(),
    chains: viemChains(),
    signer,
    nameResolvers: [bsoResolver],
    manifest
});

// Join + serve every slot in one call (a full 5chan host participates in the whole directory).
await voter.start();

// Render the homepage: the winning community for each slot. The voter owns the manifest, so it
// already knows every contest — reach each by its `contestId` (contests cache by topic).
const contests = await Promise.all(voter.contestIds.map((contestId) => voter.createContest({ contestId })));
console.log(`created ${contests.length} directory contests`);

for (const contest of contests) {
    // Subscribe reactively: re-render the slot whenever incoming votes change the tally.
    contest.on("update", () => {
        const winner = contest.tally?.ranking[0]?.community ?? "(no votes yet)";
        console.log(`${contest.criteria.contestId}: ${JSON.stringify(winner)}  [topic ${contest.topic}]`);
    });
    contest.on("error", (err) => console.warn(`${contest.criteria.contestId}: ${String(err)}`));
    await contest.update(); // start syncing + fire the initial update
}

// Publish a vote in one slot. With a signer this is a write; v1 is one upvote per topic.
if (!voter.readOnly) {
    // `name` must be the community's resolvable domain (unique per community); the tally
    // drops any vote whose name does not resolve to the claimed publicKey.
    const vote = await voter.createContestVote({
        contestId: "biz",
        votes: [{ community: { name: "bizfinance.bso", publicKey: "12D3KooW...someCommunityKey" }, vote: 1 }]
    });
    vote.on("publishingstatechange", (state) => console.log(`biz vote: ${state}`));
    const bundle = await vote.publish();

    // Keeping it alive is 5chan's job: it schedules a refresh before the vote expires. A vote
    // sampled at bucket b expires once the current bucket exceeds b + voteExpiryBuckets; the
    // recommended cadence is republishIntervalBuckets(criteria) buckets. To refresh, publish again.
    const criteria = (await voter.createContest({ contestId: "biz" })).criteria;
    console.log(`refresh /biz/ every ~${republishIntervalBuckets(criteria)} buckets; last vote at block ${bundle.blockNumber}`);

    // Withdraw (active): publish an empty ballot that supersedes the prior vote under LWW.
    await (await voter.createContestVote({ contestId: "biz", votes: [] })).publish();
}

// On shutdown: leave all topics and unregister the fetch responder.
await voter.destroy();
