# @bitsocial/pubsub-voting

Trustless, leaderless voting over libp2p pubsub, designed to run on top of a host node's shared libp2p/Helia instance.

> **Status: engine, reactive facade, and live-delta transport implemented and unit-tested.** The zod schemas, canonical dag-cbor encoding, topic derivation, the verify pipeline (signature + constraints + on-chain gate + community-name resolution), the LWW winner-set CRDT with its binary bundle codec, the tally, the transport's **validate-before-forward gossip gate** over **inline bundle deltas**, and the **root-record checkpoint sync** (on-demand encode, suppressed 10-minute topic heartbeat, libp2p-fetch pull, divergent roots chased via directed bitswap) are all implemented — so the reactive `PubsubVoter` / `Contest` (`createContest`) / `ContestVote` (`createContestVote`) facade is live. The gate runs the full validity pipeline on the message bytes in an async gossipsub topic validator *before* re-forwarding, so an invalid bundle (bad signature, wallet the gate rejects, squatted name) is never propagated and `reject` scores the sender. Cold-join checkpoint bundles instead admit on the synchronous offline checks and settle their **deferred chain checks in the background, batched via multicall3** — the tally renders immediately with per-row `chainVerified`/`nameResolved` flags and refines as they land, and a node's own checkpoint only ever serves fully verified bundles (see [DESIGN.md, Background chain verification](./DESIGN.md#background-chain-verification)). **Keeping a live vote from decaying is the consuming client's job** — this library publishes each vote once and exposes `republishIntervalBuckets` so the client can schedule its own refreshes (see [DESIGN.md, Republishing is the client's job](./DESIGN.md#republishing-is-the-clients-job-not-this-librarys)). The host side has since caught up: pkc-js registers gossipsub (`16.0.2`) and `@libp2p/fetch` on the shared node as of `0.0.63` ([pkc-js#183](https://github.com/pkcprotocol/pkc-js/issues/183) is closed), so a stock pkc-js host passes both construction guards — the remaining pkc-js work is the version-stable Helia accessor and gossipsub score tuning. See [ROADMAP.md](./ROADMAP.md), [DESIGN.md](./DESIGN.md), the [Transport gate](./DESIGN.md#transport-gossipsub-topic--validation), and [open questions](./DESIGN.md#open-questions).

## What it is for

The first consumer is [5chan](https://github.com/bitsocialnet/5chan), a serverless, adminless imageboard on the Bitsocial protocol. 5chan has a [competitive directory system](https://github.com/bitsocialnet/5chan/blob/master/README.md#competitive-directory-system): many communities compete for each directory slot (for example, multiple "Business & Finance" communities), but only the highest-voted one appears on the homepage. Today those assignments are curated by hand through pull requests to [`5chan-directories.json`](https://github.com/bitsocialnet/lists/blob/master/5chan-directories.json). This library is the planned replacement: directory voting that is decided by holders rather than by maintainers, with no server to trust.

The same engine generalizes to the original use case in [pkc-js issue #25](https://github.com/pkcprotocol/pkc-js/issues/25) (a default-communities list voted on over pubsub) and to any future Bitsocial client that needs holder-weighted, censorship-resistant curation.

## Why a separate library (not in pkc-js)

[pkc-js](https://github.com/pkcprotocol/pkc-js) (Public Key Communities) is the protocol layer: communities, publications, the challenge exchange. Voting is application/governance layer. Keeping it separate means:

- Chain-RPC and governance churn stay out of pkc-js core. pkc-js deliberately touches chains only for name resolution; it has no balance lookups, no chainTicker-to-RPC mapping, and no off-chain vote signing or verification. This library owns all of that.
- The engine is reusable across clients and contests.
- The core (`schema/`, `verify/`, `crdt/`, `tally/`) is transport-agnostic and unit-testable without a network. libp2p only appears in `transport/`.

This library does not start its own node. It consumes the host's running Helia node directly — no adapter — and drives that node's gossipsub service and blockstore itself. The node must carry a pubsub service at `libp2p.services.pubsub` (a plain Helia node does not — register e.g. `@libp2p/gossipsub`), a usable `blockstore`, and a libp2p fetch service at `libp2p.services.fetch` (register `@libp2p/fetch` — the checkpoint root-record pull rides it); construction throws `MissingPubsubError` / `MissingBlockstoreError` / `MissingFetchError` otherwise. With pkc-js that node is reached at `pkc.clients.libp2pJsClients[key].heliaNode` — the documented, semver-covered accessor since pkc-js `0.0.72` (see [DESIGN.md, Deferred pkc-js work](./DESIGN.md#deferred-pkc-js-work)).

## Design at a glance

- **Settings live in the topic.** `topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`. Two peers on the same topic provably ran identical rules, so the network validates itself with no intermediary.
- **Votes are a state-based grow-only CRDT.** A signed `Votes` bundle is a standalone dag-cbor block (no parent links); each wallet gossips its own bundle **inline as a live delta**, validated straight from the message bytes — no fetch toward the publisher. State is a last-write-wins set keyed by wallet, so aggregation is a monotonic union: a peer can omit a vote but can never subtract one that an honest peer serves. Cold start and gap-fill exchange a tiny **root record** (libp2p-fetch pull + a slow topic heartbeat) and pull the checkpoint blocks behind it via directed bitswap from its advertisers.
- **The gate and weight are data, not code.** A fixed rule registry (mirroring pkc-js's challenge registry) maps a `type` string to a verifier, and the criteria's `gate` composes those rules with `all` / `any` — so "the Pass, or a moderator, and not banned" is a document, not a custom rule. v1 ships exactly the soulbound-NFT path — an `erc5192-min-balance` gate (the 5chan Pass: `balanceOf` **plus** an on-chain assertion that the contract declares its tokens locked, read at the verifier's head so a freshly-acquired Pass votes immediately) and `constant` weight (1 pass = 1 vote). A gate on a *transferable* asset would let one Pass back several concurrent votes, so the plain `erc721-min-balance` rule ships unregistered; balance-derived (token-weighted) voting is deferred. See [DESIGN.md, Does one Pass mean one vote?](./DESIGN.md#does-one-pass-mean-one-vote) and [ROADMAP.md](./ROADMAP.md).

See [DESIGN.md](./DESIGN.md) for the full rationale, including how this resists vote-dropping and how criteria upgrades fork cleanly.

## Research

- [Token-gated ephemeral boards](./docs/research/token-gated-ephemeral-boards.md) explores an adjacent, ownerless discussion protocol derived from on-chain assets. It is research rather than part of this library's roadmap or wire format.

## Usage

The library never starts a node and never takes a host SDK (there is no `pkc` argument). A host passes its own running Helia node in directly and injects its seams into a single `PubsubVoter`. **Identity is not one of the seams**: the voting wallet (`VoteSigner`) belongs to each ballot, passed to `createContestVote`, so one voter on the host's shared node publishes for as many wallets as the host holds keys for — and a client that only renders tallies never touches key material.

| Seam | Type | Required | Purpose |
|---|---|---|---|
| `helia` | `HeliaInstance` | yes | the host's running Helia node; must carry a gossipsub service at `libp2p.services.pubsub` (else `MissingPubsubError`), a `blockstore` (else `MissingBlockstoreError`), and a libp2p fetch service at `libp2p.services.fetch` (else `MissingFetchError`) |
| `chains` | `ChainClientFactory` | yes | resolves the chain a contest counts in (`{ chainId }`, from `criteria.bucketChainId`) to a viem `PublicClient`; every gate rule and the weight rule read through it. **RPC endpoints are this client's own settings, never part of the criteria document** — return one shared (memoized) client per chain, pointed at a gateway that carries a multicall3 deployment in its viem `chain` config and serves **historical state at least `voteExpiryBuckets × blocksPerBucket` blocks behind head** (the v1 gate reads the head first, but falls back to the block a ballot names — see [Custom rules](#custom-rules)); return `undefined` for a chain with no RPC configured, and `createContest`/`createContestVote` throws `MissingChainClientError` (recuse, don't miscount) |
| `nameResolvers` | `NameResolver[]` | no | community-name resolvers (same interface and instances as pkc-js's `nameResolvers`, e.g. `@bitsocial/bso-resolver` for `name.bso`); each vote's `community.name` claim is verified through them — inline at the forward-gate for live votes, in the background verifier for cold-join admits — and a bundle whose name resolves to a different `publicKey` than claimed is dropped/evicted |
| `dataPath` | `string \| false` | no | directory for the voter's persistent state (gate-result + name-resolution caches, and each joined contest's **checkpoint snapshot** — its last fully-verified winner-set, reloaded at join so a restart with no other peer online keeps the tally), the pkc-js `dataPath` equivalent. Node default: `{cwd}/.bitsocial-pubsub-voting` (better-sqlite3 under `{dataPath}/lru-storage/` + `{dataPath}/checkpoints.db`); in the browser the path is ignored and everything lives in IndexedDB. Pass `false` for in-memory-only (the pkc-js `noData` equivalent). A restart re-serves settled gate reads and fresh name resolutions from the store instead of the RPC, and restores each contest's checkpoint before the cold-start pull. A seeder should always set a stable path |
| `httpRouterUrls` | `string[]` | no | Delegated Routing V1 router base URLs to **announce provider records to** (one signed `PUT /routing/v1/providers` per router — IPIP-0526: the record carries a `Signature` made by the node's own libp2p key and a fresh `Payload.Timestamp`, both required by [pkc-http-router](https://github.com/pkcprotocol/pkc-http-router), the router implementation this library targets, which rejects the whole PUT with 403 otherwise; `Keys` batches every joined contest's criteria CID + current checkpoint root + chunk CIDs — hourly, debounced on root changes, and on address changes). **Seeders only**: absent/empty means never announce (the default — plain clients are not dialable), and the browser build never announces regardless. The node must be publicly **reachable** (its listening port open/forwarded/published), but it does not need to know its own public IP: private, loopback, and link-local addrs are filtered client-side, and when nothing survives — the normal zero-config case behind NAT or a Docker bridge, and even on public-IP hosts, since libp2p withholds unconfirmed public addrs pending AutoNAT — the announcer sends the wildcard sentinels (`/ip4/0.0.0.0/...`, `/ip6/::/...`) that the router rewrites to the PUT's observed source IP, exactly as kubo announces work. Configured `addresses.announce` values (concrete public addrs, DNS/AutoTLS, or a kubo-style wildcard) are used as-is. Only a loopback-only node announces nothing. *Querying* needs no URLs here — cold-join discovery uses the injected node's `libp2p.contentRouting`, which the host wires its routers into |

A contest is addressed by its **full criteria document**, passed to `createContest` / `createContestVote`. The document is strictly validated there (`CriteriaSchema` + the rule registry + the `chains` factory: an unimplemented rule throws `UnknownRuleError`, an unresolvable required chain throws `MissingChainClientError` — recuse, don't miscount), and its canonical bytes derive the topic — so the exact document every participant shares is the only contest configuration that exists. The document names its chain only by `bucketChainId`; RPC endpoints stay out of it, so operators can swap gateways without forking the topic.

Who may vote is the document's `gate` — one rule, or a boolean tree of them:

```ts
gate: { rule: { type: "erc5192-min-balance", contract: "0x13d4…91b9", min: 1 } }
gate: { all: [{ rule: passRule }, { rule: notBannedRule }] }          // every rule must admit
gate: { any: [{ rule: passRule }, { rule: moderatorRule }] }          // any one of them admits
gate: { all: [{ any: [{ rule: passRule }, { rule: moderatorRule }] }, { rule: notBannedRule }] }
```

Each rule still answers one question about one wallet and knows nothing about the others; the document composes them. Because the topic is the CID of these bytes, the schema rejects the spellings that would mean the same as a shorter tree — a branch needs **at least two** children, may not repeat a child, and may not nest a branch of its own kind (`{ all: [{ all: [A, B] }, C] }` is just `{ all: [A, B, C] }`) — since each would put one contest on two topics. A rule may appear in two different branches, which is how a gate says "any two of these three": `{ any: [{ all: [A, B] }, { all: [A, C] }, { all: [B, C] }] }`. Trees nest at most 4 deep with at most 8 rules in total. No rule names a chain: every one of them reads the chain the contest counts in (`bucketChainId`), which is the chain the block each rule is handed comes from. Child order is significant and is the order the forward gate evaluates in, so put the cheapest or most discriminating rule first.

### Construct a voter

```ts
import { PubsubVoter, type ChainClientFactory } from "@bitsocial/pubsub-voting";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

// The host's chain settings: which RPC gateway to trust per chain is THIS client's choice
// (never part of a criteria document). One shared client per chain, memoized — sharing is
// what lets parallel contests' pinned-block reads coalesce into shared multicalls.
const viemChainFactory = (): ChainClientFactory => {
  const clients: Record<number, ReturnType<typeof createPublicClient>> = {
    [base.id]: createPublicClient({ chain: base, transport: http("https://my-trusted-base-rpc.example") })
  };
  return ({ chainId }) => clients[chainId]; // undefined → recuse contests counting in that chain
};

const voter = new PubsubVoter({
  helia,                        // the host's Helia node; needs a gossipsub service at libp2p.services.pubsub + a blockstore
  chains: viemChainFactory(),   // ({ chainId }) => viem PublicClient | undefined
  nameResolvers: [bsoResolver], // optional; verifies community-name claims (e.g. @bitsocial/bso-resolver)
  dataPath: "/path/to/data",    // optional; persistent state: caches + checkpoint snapshots (default {cwd}/.bitsocial-pubsub-voting; false → in-memory)
  httpRouterUrls: [             // optional, SEEDERS ONLY (publicly reachable node): announce provider
    "https://routing.example"   // records (criteria CID + checkpoint root + chunks) so cold joiners
  ]                             // can discover this node via the routers; clients omit this
});
```

Construction throws `MissingPubsubError`, `MissingBlockstoreError`, or `MissingFetchError` if the node lacks a usable pubsub service, blockstore, or libp2p fetch service (and `MissingPrivateKeyError` if `httpRouterUrls` is set but the node exposes no signing key, since provider records must be signed) — the library fails fast rather than letting a later `publish`/`subscribe`/`fetch` fail obscurely. ("Bitswap" is not a separately checkable property — it is a block broker wired beneath `blockstore` — so the validated guarantee is a well-formed blockstore, the surface bitswap retrieves through. The fetch service carries the checkpoint root-record pull; the library registers its own responder on it.)

### Read a tally reactively

`createContest` mints a per-contest read object; `update()` starts syncing and it emits `update` (carrying a fresh `tally`) and `error`, just like a pkc-js `community`:

```ts
const contest = await voter.createContest({ criteria });  // criteria: the contest's full document (strictly validated here)
contest.on("update", () => render(contest.tally));        // tally rides the object; recomputed before each emit
contest.on("error", (err) => showConnectivityWarning(err)); // tally chain read failed, the background verifier's RPC/resolver is down (retrying), or a deferred check evicted THIS wallet's own vote (VoteEvictedError)
await contest.update();                                   // join the topic, cold-start, begin emitting
// const fresh = await contest.getTally();                // or force a fresh read, bypassing the cache
// await contest.stop();                                  // leave the topic
```

### Will this wallet's vote count?

Ask the contest before signing. `checkEligibility` runs the contest's **real gate rules** through
the same chain clients, head reader and memos the forward gate uses, so each reads at whatever
block it reads at and applies whatever threshold it applies. When the gate refuses, the wording is
the rules' own — render it verbatim:

```ts
const check = await contest.checkEligibility({ address: wallet });
if (check.eligible) {
    show(`eligible — holds ${check.score}`);
} else {
    for (const failure of check.failures) show(failure.error); // e.g. "this wallet holds none of the gate token (0x13d4…91b9)"
}
```

With a composite gate you get one entry per rule, so a client can show a checklist rather than a
single verdict:

| field | what it is |
| --- | --- |
| `checks` | every rule in the gate, in document order: `{ leaf, ruleId, type, satisfied, score, error? }` |
| `failures` | the rules whose failure **explains** the refusal — render these |
| `gate` | the same tree as `criteria.gate`, each node carrying its `satisfied`, for rendering the real requirement |
| `error` | `failures` joined into one sentence, for a caller that only wants a string |

`failures` is deliberately **not** `checks.filter(c => !c.satisfied)`. Under `any`, a wallet that
qualifies as a moderator also "fails" the Pass rule — telling it to go and buy a Pass would be
worse than saying nothing.

Key rows by **`leaf`** — the rule's position in the gate, and the only field guaranteed unique in
one result. `type` is not (a gate may name one rule twice on different options) and neither is
`ruleId` (a gate may name the same rule in two branches). Use `ruleId` to compare *across* results
instead: equal ids are one question, so a directory of 63 boards gated on one Pass shows the same
id everywhere, and shares one chain read behind it.

A check's `satisfied` is `true`, `false`, or **`undefined`** — the last meaning that rule's chain
read failed and the gate was decided without it. Render it as unknown, never as a requirement the
wallet is missing: nothing was learned about them. A wallet admitted by a branch that did answer
still gets `eligible: true` while an unrelated contract's RPC is down; the call throws only when
the gate cannot be decided without the rule that failed, because at that point there is no honest
answer to give.

Do **not** reimplement this by reading balances yourself: which block counts is the rule's
business and changes when the rule changes. A client that hard-codes "peers verify at the bucket
boundary" keeps telling voters to wait for a window that a head-reading gate no longer imposes.

It is a courtesy check, not a promise — eligibility can change between the check and the publish,
and each peer verifies against its own chain view. `publish()` deliberately does not call it: the
gate is the network's decision, and a rejection still surfaces after the fact as
`VoteEvictedError`, carrying the same kind of reason.

Each ranking row carries one flag **per deferred verification operation** (mirroring pkc-js's
`nameResolved`), and every background settlement re-fires `update` — so a leaderboard can render
provisional rows immediately and refine them in place:

```ts
contest.on("update", () => {
    for (const row of contest.tally?.ranking ?? []) {
        // row.community: { name?: string, publicKey: string } — identity is ALWAYS publicKey.
        // Show the name only once it has been checked against the registry.
        const label = row.community.name && row.nameResolved ? row.community.name : row.community.publicKey;
        // row.chainVerified: true once EVERY contributing vote's on-chain gate read confirmed.
        // false means "still being read in the background", never "failed" — a vote that fails
        // a deferred check is evicted and the row recounted instead.
        renderRow(label, row.weight, row.chainVerified ? "verified" : "verifying…");
    }
});
```

A cold join **renders fast and refines**: checkpoint bundles are admitted after the synchronous offline checks (signature + constraints), so the first tally arrives with `chainVerified: false` rows, and the background verifier then batches the deferred gate reads (one multicall per bucket) and name resolutions — each settlement re-fires `update` with the flags flipped. See [DESIGN.md, Background chain verification](./DESIGN.md#background-chain-verification).

Repeated `createContest` calls with byte-identical criteria return the same `Contest` (engines are keyed by topic, the criteria CID).

### Publish or withdraw a vote

`createContestVote` mints a publishable ballot; `publish()` signs and broadcasts it once and emits `publishingstatechange`, like a pkc-js publication. The `signer` is the ballot's — the wallet that holds the Pass and whose recovered address *is* the voter:

```ts
const vote = await voter.createContestVote({
  criteria,
  votes: [{ community: { publicKey: "12D3KooW..." }, vote: 1 }],
  signer: mySigner                                                // VoteSigner: address() + signBallot()
});
vote.on("publishingstatechange", (state) => console.log(state)); // stopped → signing → publishing → published, then verified-locally and/or verified-by-peer (or failed)
const { bundle, cid, recipientCount } = await vote.publish();     // the signed VotesBundle, its CID, and how many peers gossipsub sent it directly to
vote.signer === mySigner;                                         // the ballot carries the wallet it was minted with

// Withdraw (active): publish an empty ballot; it supersedes the prior vote under LWW.
await (await voter.createContestVote({ criteria, votes: [], signer: mySigner })).publish();
```

A ballot is required to name its wallet, so a client that holds no key simply never mints one — there is no read-only mode to check, and nothing on an unpublished ballot to render. Two wallets on one voter are two `createContestVote` calls with two signers; the CRDT keys them apart by recovered address, so both land in the tally.

A community's identity is its `publicKey`. The optional `name` is the community's resolvable domain (e.g. `memes.bso`) — unique per community, never a free label: the schema requires a TLD, the name is resolved through the injected `nameResolvers` (inline at the forward-gate for live votes, in the background verifier for cold-join admits), and any bundle whose name resolves to a different `publicKey` than claimed is dropped/evicted. Bundles must also name pairwise-distinct `community.publicKey`s. See [DESIGN.md, Votes wire](./DESIGN.md#votes-wire).

`recipientCount` is the peer-reach hint gossipsub reports: how many peers it sent the vote *directly* to at publish time (first-hop fan-out, filtered for send failures) — **not** total network reach, and **not** an acceptance confirmation, since each recipient still runs the forward-gate before re-forwarding. Treat it as a coarse "did this reach anyone?" signal. Note that gossipsub *rejects* the publish with `NoPeersSubscribedToTopic` when it would reach zero peers (common right after joining, before the mesh grafts), unless the host enables `allowPublishToZeroTopicPeers` — so a resolved `recipientCount === 0` only occurs under that host setting; otherwise a no-reach publish surfaces as a thrown error (and a `failed` state).

#### Rejection feedback

Gossipsub gives a publisher **no acceptance or rejection feedback** — a peer that drops a bundle does so silently. Since every honest peer runs the same checks this node runs, the library turns its own local verdict into the feedback the protocol can't provide, in two places:

- **At `publish()`**: each vote's `community.name` is preflighted through the shared resolution cache first — a name that definitively fails (no resolver for its TLD, no record, or it resolves to a **different** `publicKey` than the vote claims) throws `InvalidCommunityNameError` before signing or joining the topic, since every verifier would silently drop that bundle anyway. A resolver that merely *throws* (registry outage) never blocks the publish — the check stays deferred to the background verifier.
- **After `publish()` resolved**: `"published"` means signed and broadcast, **not** accepted by the network. The deferred checks (the on-chain gate read, and any name resolution a preflight outage skipped) run in the background; if one evicts the bundle, the vote emits a `VoteEvictedError` on its `error` event — carrying the evicted `bundle` and the exact `verdict` any verifier would produce — and its `publishingState` flips to `"failed"` post hoc. The same error fires on the contest's `error` event, for long-lived views.

The positive verdicts are states too, so a client never has to infer "it counted" from the absence of an error:

- `"verified-locally"` — our own deferred checks came back clean for this bundle. Still our verdict, but every honest peer runs byte-identical checks, so it is the strongest inference available without hearing from anyone.
- `"verified-by-peer"` — a peer advertised a checkpoint containing this bundle. A node serves only fully verified bundles in its own checkpoint, so an honest peer including it implies that peer verified it too; what is *observed* is that somebody other than us is keeping the vote.

The two are independent outcomes of two asynchronous races, not a sequence: a peer can serve our bundle back before our own gate read returns, in which case `"verified-by-peer"` is reached directly and `"verified-locally"` is never emitted. Peer evidence is the stronger of the two, so it is never walked back to the local verdict arriving late. Treat both as terminal-positive; do not wait for `"verified-locally"` before `"verified-by-peer"`.

Both are readable from the contest by bundle CID, which is how a restored vote asks after a reload — the publishing `ContestVote` is long gone by then, but the vote lives for `voteExpiryBuckets`. Persist `PublishOutcome.cid` and ask with it:

```ts
contest.checksFor(cid);          // { chainVerified, nameResolved? } — or undefined if not held (never admitted, evicted, expired)
contest.checkpointPeersFor(cid); // peer ids seen serving OUR bundle back in their checkpoint (own bundles only; a lower bound)
```

`checksFor` needs nothing extra: the checks are recorded on every admit path, including the snapshot restore. **`checkpointPeersFor` does**, because the engine cannot recognise a bundle it did not sign — the signer belongs to the publication, not the contest, so a restored bundle looks like any other wallet's. A client that persisted the CID re-arms attribution once, after `update()`:

```ts
contest.trackOwnBundle(cid); // idempotent; attribution runs from here forward, not backwards
```

```ts
vote.on("error", (err) => {
    if (err instanceof VoteEvictedError) console.log(err.verdict.reason); // e.g. "not admitted: rule score is 0n at block …"
});
await vote.publish(); // throws InvalidCommunityNameError if a carried name can't back the vote
```

### Republishing is the client's job

A vote is not permanent: a bundle is valid only for `voteExpiryBuckets` after its `blockNumber`, so a live vote must be re-published before it decays. **This library does not do that automatically** — it publishes each vote once and the consuming client decides when (or whether) to refresh. To refresh, just `createContestVote(...).publish()` again (with the same signer); a new bundle at the current bucket supersedes the old one. To stop, simply stop refreshing and let the vote lapse. The library gives you what you need to schedule it — all pure, no chain reads:

```ts
import { republishIntervalBuckets } from "@bitsocial/pubsub-voting";

const cadence = republishIntervalBuckets(criteria); // ceil(voteExpiryBuckets / 2) — the recommended cadence, in buckets
// A vote sampled at bucket b (bundle.blockNumber / criteria.blocksPerBucket) expires once the
// current bucket exceeds b + criteria.voteExpiryBuckets; refresh before then.
```

See [DESIGN.md, Republishing is the client's job](./DESIGN.md#republishing-is-the-clients-job-not-this-librarys) for why an always-on re-signer was deliberately kept out of a library that runs on the host's shared node.

### Many contests (a 5chan-style directory)

One criteria document is one contest (one topic). A directory is conveniently authored as a single manifest of shared `defaults` plus one entry per slot — as in the published [5chan-directory-criteria.jsonc](https://github.com/bitsocialnet/lists/blob/master/5chan-directory-criteria.jsonc) and [examples/5chan.ts](./examples/5chan.ts) — and `deriveDirectoryCriteria` derives the finished documents (`{ ...defaults, ...entry }`, shallow — an override replaces that whole field) and validates each one. What participants must share **byte-identically** is the derived documents (the topic is their CID), which is why every consumer of the same directory should derive through this one helper rather than re-implement the merge. The manifest is JSONC by convention; strip comments before parsing:

```ts
import { deriveDirectoryCriteria } from "@bitsocial/pubsub-voting";
import stripJsonComments from "strip-json-comments";

const manifest = JSON.parse(stripJsonComments(manifestJsonc)) as unknown;
const allCriteria = deriveDirectoryCriteria(manifest); // → Criteria[], throws on invalid entries or duplicate contestIds (DuplicateContestIdError)

const contests = await Promise.all(allCriteria.map((criteria) => voter.createContest({ criteria }))); // → Contest[]
for (const contest of contests) await contest.update(); // a full host joins + serves the whole directory
```

There is no separate seeder API: a node that joins a topic (via `update()` or `publish()`) automatically serves that contest's checkpoint root record over libp2p-fetch — the responder registers itself on the first joined topic and unregisters when the last is left. A seeder is just a client that joins everything.

### Lifecycle (`stop` / `destroy`)

`stop()` leaves every joined topic but keeps the voter **reusable** — each `Contest` can `update()` again and you can `createContest` afterward. `destroy()` is **terminal** (like pkc-js): it leaves every topic, unregisters the fetch responder, and marks the voter and its contests dead — any later `createContest`/`createContestVote`, or a pre-existing `Contest.update()`/`ContestVote.publish()`, throws `VoterDestroyedError`. Construct a new `PubsubVoter` to participate again. (There is no store to dispose — republishing is the client's concern.)

```ts
const voter = new PubsubVoter({ helia, chains });
// … create + update contests, app runs …
await voter.destroy();   // terminal: leave all topics, unregister the responder, forbid reuse
```

### Pure helpers (no node, no network)

```ts
import { topicFor, deriveDirectoryCriteria } from "@bitsocial/pubsub-voting";

const topic = await topicFor(criteria);            // "bitsocial-votes/" + CID(dag-cbor(criteria))
const allCriteria = deriveDirectoryCriteria(json); // directory manifest → validated Criteria[] (see above)
```

Full, type-checked call patterns for a pkc-js host, a plebbit/seedit host, and a read-only consumer are in [examples/](./examples/).

### Custom rules

The gate and weight are a single flat registry of rules, one `type` per file, mirroring the pkc-js challenge registry. Each rule owns its option schema, its own reads (`readContract`, `getBalance`, ... through `ctx.chain`, the viem `PublicClient` for its `options.chain`), which block it reads at, and what it memoizes — see [What a rule owns](#what-a-rule-owns-its-block-and-its-cache) below. There is **one kind**: `evaluate → RuleResult`, either `{ success: true, score }` with a positive score or `{ success: false, error }` — where `error` is the voter-facing reason the rule refused. The criteria has two *slots* drawing from the one registry — the **gate** slot treats the score as admission (`> 0n` admits), the **weight** slot as the vote's magnitude. A wallet's vote counts as `gate admits ? weight.score : 0n`. A rule never sees the gate it sits in: composition (`all` / `any`), which failures a voter is shown, and whether a refusal may be blamed on the sender are all folded by the library from what each rule returned. A rule that needs a threshold fails below it (so `erc5192-min-balance`'s optional `min` gates), which lets the same rule serve either slot. A chain-reading rule may also implement the optional `evaluateMany({ options, wallets, ctx })` batch hook (`wallets` in place of `wallet`, returning `{ results }` — one per input wallet, in order) — its semantics MUST equal mapping `evaluate` — which the background verifier uses to batch a cold join's gate reads. The batch is simply everything pending, so its wallets need not share a `sampleBlock`: a rule reading the head scores them all at once, a rule reading pinned blocks groups them itself. (`erc5192-min-balance` implements it over multicall3, hoisting its one lock assertion out of the per-wallet reads; see [DESIGN.md, Background chain verification](./DESIGN.md#background-chain-verification).)

Built-ins: `erc5192-min-balance` (v1) and `constant` (v1).

Two chain-reading rules ship in the tree but are deliberately **not** built in, so a criteria naming either recuses via `UnknownRuleError` instead of silently gating on an asset that does not bound Sybils:

- **`erc721-min-balance`** (exported) — a bare `balanceOf` on a *transferable* token. One token walked A → B → C inside one expiry window backs three concurrent live votes, since each bundle is verified once, when it is merged, and the winner set is LWW-keyed per wallet. `erc5192-min-balance` is this rule plus `supportsInterface(0xb45a3c0e)`, which refuses a contract that does not declare its tokens locked.
- **`erc20-balance`** (not exported) — the same amplification, reopened by fungibility, plus the open lazy-tally ceiling question for balance-derived weight.

A host that wants a transferable gate anyway registers `erc721MinBalance` explicitly through the `rules` option below — the library stops blessing the configuration, it does not forbid it. `erc20-balance` is not exported at all, so a host that wants balance-weighting supplies its own rule of that `type`. See [DESIGN.md, Does one Pass mean one vote?](./DESIGN.md#does-one-pass-mean-one-vote).

A host adds or shadows rules by `type` via the `rules` option — this is how clients like 5chan or seedit register custom rules without forking the library:

```ts
import { PubsubVoter, type Rule } from "@bitsocial/pubsub-voting";
import { z } from "zod";

const seeditModAllowlist: Rule<{ type: "seedit-mod-allowlist"; allow: string[] }> = {
  type: "seedit-mod-allowlist",
  optionsSchema: z.object({ type: z.literal("seedit-mod-allowlist"), allow: z.array(z.string()) }),
  async evaluate({ options, wallet }) {
    return options.allow.includes(wallet.address)
      ? { success: true, score: 1n }
      : { success: false, error: "this wallet is not on the moderator allowlist" }; // shown to the voter
  }
};

const voter = new PubsubVoter({
  helia, chains,
  rules: { "seedit-mod-allowlist": seeditModAllowlist } // flat map; shadows/extends built-ins by `type`
});
```

A custom `type` becomes part of `dag-cbor(criteria)`, so it is provably pinned to the topic it runs on, and a client that does not implement a `type` named in `criteria.requires.rules` throws `UnknownRuleError` and recuses itself rather than miscounting.

#### What a rule owns: its block, and its cache

A rule is handed the pinned block its ballot names, a lazy head reader, and its own memo, and decides for itself which to read and what to remember:

```ts
evaluate(args: { options: O; wallet: { address: string; sampleBlock: number }; ctx: ChainReadContext }): Promise<RuleResult>

interface ChainReadContext {
  chain: ChainClient;                        // the viem PublicClient for options.chain
  head: () => Promise<{ block: number }>;    // this verifier's current block — lazy, coalesced
  cache: RuleCache;                          // this rule's memo, persistent and shared across contests
}
```

- **`wallet.sampleBlock`** is the bundle's bucketized block, already floored — the historical block every verifier agrees the ballot names. Read there and your score is identical on every verifier forever. It is *not* a claim about when the ballot was signed (it trails by up to `blocksPerBucket`).
- **`ctx.head()`** is this verifier's current block. Read there and a wallet qualifies the moment it acquires the gating asset, instead of waiting for the next bucket boundary. Resolve it once per evaluation and pin your reads to that number — always pass an explicit `blockNumber: BigInt(...)`, or the read coalescer cannot batch you.
- **`ctx.cache`** memoizes under a `key` you choose and an `epoch` that says when the answer stops being true (a moved epoch is how an entry expires; `purgeBelow` drops what is behind). **Chain-reading rules must use it** — it is what turns "one chain read per unique bundle" into "one read per key per epoch", so without it an ineligible wallet can make every peer on the topic pay an RPC round trip per fresh-signed bundle. `memoMany` reads only the misses, in one batched call.

```ts
const { values } = await ctx.cache.memoMany({
  keys: wallets.map((w) => `bal/${w.toLowerCase()}`),
  epoch: block,                                   // e.g. the pinned block, or a coarse head window
  read: async ({ keys }) => ({ values: await readOnChain(keys) })
});
```

`RuleResult` is a discriminated union, shaped like pkc-js's `ChallengeResult`:

```ts
type RuleResult =
  | { success: true;  score: bigint }                          // score MUST be > 0n
  | { success: false; error: string; penalize?: boolean };     // penalize default true
```

**`error` is required on the failing branch**, because only the rule knows why a wallet fell short — it holds none, it holds too few, the contract gates nothing. That sentence is what the library shows the voter: it becomes the verdict reason, so it reaches the publisher on `VoteEvictedError.verdict.reason`, and it is what `contest.checkEligibility()` returns. Write it about the wallet ("this wallet holds none of the gate token"), not about the library, and leave block numbers out unless a voter can act on them. Making it optional would mean every UI re-deriving the rule's thresholds and block choice to say anything useful — which is exactly the coupling `ctx` and `RuleCache` exist to remove.

**`penalize`** answers the one thing the library cannot: may the failure be blamed on the sender? `true` (the default) says every honest verifier computes this same failure — true of a read pinned to the block the bundle names — so the forward gate `reject`s the message (penalizing the delivering peer in gossipsub's scoring) and the verdict is cached as terminal. `false` says an honest peer could legitimately disagree, so the bundle is dropped `ignore`-class instead: no penalty, verdict uncached, and the background verifier re-examines it for a grace window before giving up.

Across a composite gate the library folds those answers, and the fold is not a simple OR. An `all` fails as soon as one child does, so **one** attributable failure makes the whole refusal attributable — that rule alone closes the gate identically everywhere. An `any` fails only when every alternative does, so it is attributable only if **every** one of them is: a single unprovable failure means a peer on a fresher chain may be looking at a wallet this gate would admit, and penalizing it would punish honest relaying.

`erc5192-min-balance` reads the head first — so a freshly-acquired Pass counts immediately — falls back to `wallet.sampleBlock` when the head refuses (ERC-5192 does not forbid burning, and without the fallback a burn would erase votes retroactively for peers that had not verified them yet), memoizes each leg under its own epoch, and returns `penalize: false`, because at validation time it cannot attribute a failure to anyone: the peer that forwarded the vote verified it against *its* head. Every other rule in the tree reads `wallet.sampleBlock` and leaves `penalize` at its default — a transferable or fungible balance can decrease, so reading it at the head would silently invalidate votes already counted. See [DESIGN.md, What a rule owns](./DESIGN.md#what-a-rule-owns-and-what-the-pipeline-owns).

### Weighted voting (deferred)

v1 ships `constant` weight (one Pass, one vote) **on purpose** — it resists whale dominance and downvote weaponization. Balance-derived, token-weighted voting (Pass gate + BSO weight via `erc20-balance`) is a designed-but-unshipped capability: the rule path and result shape leave room for it with no engine change, but it is not in the v1 built-ins and carries open governance/abuse and lazy-tally questions — plus the Sybil amplification a fungible gate reopens, which the soulbound gate's fix cannot close for a balance (it needs a hold-duration guard instead). See [ROADMAP.md](./ROADMAP.md), [DESIGN.md, Does one Pass mean one vote?](./DESIGN.md#does-one-pass-mean-one-vote), and [DESIGN.md, Future improvements](./DESIGN.md#future-improvements).

## Layout

```
src/
  schema/        zod schemas (criteria, votes, shared wire primitives) + inferred types
  encoding/      canonical dag-cbor encoding                      [implemented]
  topic.ts       topic = "bitsocial-votes/" + CID(dag-cbor)       [implemented]
  signer/        VoteSigner seam + EIP-712 ballot typed data       [implemented]
  client/        reactive facade: PubsubVoter + Contest (createContest) + ContestVote (createContestVote) [implemented]
  errors.ts      ReadOnly/MissingPubsub/MissingBlockstore/MissingFetch/... [implemented]
  rules/         one file per `type` + registry/resolver          [implemented]
  chain/         ChainClient = viem PublicClient + bucket math     [implemented]
  verify/        signature + constraints + full BundleVerifier + verdict cache [implemented]
  crdt/          state-based LWW winner-set: union, binary bundle codec, in-memory store [implemented]
  checkpoint/    deterministic checkpoint codec (root manifest + size-capped chunks) [implemented]
  transport/     async validate-before-forward gossip gate + message codec (inline bundle / root record) + root chase + transport [implemented]
  tally/         deterministic aggregation over pre-validated bundles [implemented]
  storage/       persistent-cache backends: better-sqlite3 (Node) / IndexedDB (browser-field remap) / in-memory [implemented]
  index.ts       public entry: re-exports + facade + design types
```

## License

GPL-3.0-or-later, matching 5chan.
