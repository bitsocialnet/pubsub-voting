/**
 * Example: how 5chan would call this library.
 *
 * The library never takes a pkc instance — it takes the host's running Helia node
 * directly (no adapter). 5chan runs on pkc-js, so it passes pkc's shared node, reached
 * through the public `pkc.clients.libp2pJsClients[key].heliaNode` accessor (semver-covered
 * since pkc-js `0.0.72`). That node must carry a gossipsub
 * service at `libp2p.services.pubsub`, a `blockstore`, and a libp2p fetch service at
 * `libp2p.services.fetch` (`@libp2p/fetch` — the checkpoint root-record pull), or
 * construction throws `MissingPubsubError` / `MissingBlockstoreError` /
 * `MissingFetchError`. This is the same shape every host uses (see seedit.ts).
 *
 * A contest is addressed by its full criteria document — the exact bytes every participant
 * shares (`topic = CID(dag-cbor(criteria))`). How 5chan authors its 63 documents is its own
 * business: here it keeps a local JSONC manifest of shared defaults plus one entry per slot
 * and derives each document by shallow merge, but distributing the 63 finished documents
 * directly works just as well — the library only ever sees complete documents. Type-checks
 * against the public API — the reactive `PubsubVoter` / `Contest` (`createContest`) /
 * `ContestVote` (`createContestVote`) facade. Keeping a vote alive is 5chan's job: it tracks
 * what it voted for and refreshes on the `republishIntervalBuckets` cadence (this library
 * never re-publishes on its own).
 */
import { readFileSync } from "node:fs";
import stripJsonComments from "strip-json-comments";
import {
    PubsubVoter,
    deriveDirectoryCriteria,
    republishIntervalBuckets,
    type Criteria,
    type HeliaInstance,
    type ChainClientFactory,
    type VoteSigner,
    type NameResolver
} from "@bitsocial/pubsub-voting";

// 5chan's authoring manifest is JSONC (commented for human readers) and is NOT a protocol
// object — it is never encoded or published. `deriveDirectoryCriteria` derives one
// complete, standalone criteria document per slot ({ ...defaults, ...entry }, shallow) and
// validates each against the real schema. Two clients must end up with byte-identical
// documents to share a topic, which is why every consumer (this app, a seeder) derives
// through the same exported helper instead of re-implementing the merge.
const manifest = JSON.parse(
    stripJsonComments(readFileSync(new URL("../5chan-directory-criteria.jsonc", import.meta.url), "utf8"))
) as unknown;
const allCriteria: Criteria[] = deriveDirectoryCriteria(manifest);

// Host-provided seams. 5chan wires these from pkc + viem in its own code. The name
// resolvers are the same instances 5chan already gives pkc-js (e.g. @bitsocial/
// bso-resolver's BsoResolver for name.bso) — needed because votes carry community names,
// whose name→publicKey claim the tally verifies before counting.
declare function pkcHelia(): HeliaInstance; // pkc.clients.libp2pJsClients[key].heliaNode
declare function viemChains(): ChainClientFactory;
declare const signer: VoteSigner;
declare const bsoResolver: NameResolver; // e.g. new BsoResolver({ key: "bso-viem", provider: "viem" })

// One voter for the whole app: the seams are injected once, and every contest shares them.
// There is no library-side persistence: 5chan keeps track of its own votes and republishes
// them itself.
const voter = new PubsubVoter({
    helia: pkcHelia(),
    chains: viemChains(),
    signer,
    nameResolvers: [bsoResolver]
});

// Render the homepage: the winning community for each slot. A full 5chan host participates
// in the whole directory simply by creating + updating every contest — the first join also
// registers the checkpoint fetch responder, so this node serves root records for every
// contest it participates in (and stops serving when it leaves them).
const contests = await Promise.all(allCriteria.map((criteria) => voter.createContest({ criteria })));
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
const biz = allCriteria.find((criteria) => criteria.contestId === "biz")!;
if (!voter.readOnly) {
    // `name` must be the community's resolvable domain (unique per community); the tally
    // drops any vote whose name does not resolve to the claimed publicKey.
    const vote = await voter.createContestVote({
        criteria: biz,
        votes: [{ community: { name: "bizfinance.bso", publicKey: "12D3KooW...someCommunityKey" }, vote: 1 }]
    });
    vote.on("publishingstatechange", (state) => console.log(`biz vote: ${state}`));
    const { bundle, recipientCount } = await vote.publish();
    console.log(`biz vote sent directly to ${recipientCount} peer(s)`); // first-hop reach, not total propagation

    // Keeping it alive is 5chan's job: it schedules a refresh before the vote expires. A vote
    // sampled at bucket b expires once the current bucket exceeds b + voteExpiryBuckets; the
    // recommended cadence is republishIntervalBuckets(criteria) buckets. To refresh, publish again.
    console.log(`refresh /biz/ every ~${republishIntervalBuckets(biz)} buckets; last vote at block ${bundle.blockNumber}`);

    // Withdraw (active): publish an empty ballot that supersedes the prior vote under LWW.
    await (await voter.createContestVote({ criteria: biz, votes: [] })).publish();
}

// On shutdown: terminal teardown — leave all topics, unregister the fetch responder, and forbid
// reuse (a later create/update/publish throws VoterDestroyedError). Use voter.stop() to leave
// topics but keep the voter reusable.
await voter.destroy();
