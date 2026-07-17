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

This library does not start its own node. It consumes the host's running Helia node directly — no adapter — and drives that node's gossipsub service and blockstore itself. The node must carry a pubsub service at `libp2p.services.pubsub` (a plain Helia node does not — register e.g. `@libp2p/gossipsub`), a usable `blockstore`, and a libp2p fetch service at `libp2p.services.fetch` (register `@libp2p/fetch` — the checkpoint root-record pull rides it); construction throws `MissingPubsubError` / `MissingBlockstoreError` / `MissingFetchError` otherwise. With pkc-js today that node is reached at `pkc.clients.libp2pJsClients[key]._helia`; a version-stable accessor on pkc-js is a planned follow-up (see [DESIGN.md, Deferred pkc-js work](./DESIGN.md#deferred-pkc-js-work)).

## Design at a glance

- **Settings live in the topic.** `topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`. Two peers on the same topic provably ran identical rules, so the network validates itself with no intermediary.
- **Votes are a state-based grow-only CRDT.** A signed `Votes` bundle is a standalone dag-cbor block (no parent links); each wallet gossips its own bundle **inline as a live delta**, validated straight from the message bytes — no fetch toward the publisher. State is a last-write-wins set keyed by wallet, so aggregation is a monotonic union: a peer can omit a vote but can never subtract one that an honest peer serves. Cold start and gap-fill exchange a tiny **root record** (libp2p-fetch pull + a slow topic heartbeat) and pull the checkpoint blocks behind it via directed bitswap from its advertisers.
- **The gate and weight are data, not code.** A fixed rule registry (mirroring pkc-js's challenge registry) maps a `type` string to a verifier. v1 ships exactly the NFT path — an `erc721-min-balance` gate `rule` (5chan Pass) and `constant` weight (1 pass = 1 vote). Balance-derived (token-weighted) voting is deferred; see [ROADMAP.md](./ROADMAP.md).

See [DESIGN.md](./DESIGN.md) for the full rationale, including how this resists vote-dropping and how criteria upgrades fork cleanly.

## Usage

The library never starts a node and never takes a host SDK (there is no `pkc` argument). A host passes its own running Helia node in directly and injects its seams into a single `PubsubVoter`:

| Seam | Type | Required | Purpose |
|---|---|---|---|
| `helia` | `HeliaInstance` | yes | the host's running Helia node; must carry a gossipsub service at `libp2p.services.pubsub` (else `MissingPubsubError`), a `blockstore` (else `MissingBlockstoreError`), and a libp2p fetch service at `libp2p.services.fetch` (else `MissingFetchError`) |
| `chains` | `ChainClientFactory` | yes | resolves each chain a contest's criteria requires (`{ chain, chainId }`) to a viem `PublicClient`; rules read through it for the gate and weight. **RPC endpoints are this client's own settings, never part of the criteria document** — return one shared (memoized) client per chain, pointed at a gateway that serves historical state at least `voteExpiryBuckets × blocksPerBucket` blocks behind head and carries a multicall3 deployment in its viem `chain` config; return `undefined` for a chain with no RPC configured, and `createContest`/`createContestVote` throws `MissingChainClientError` (recuse, don't miscount) |
| `signer` | `VoteSigner` | no | the voting wallet's address + EIP-712 ballot signing; omit for a read-only voter |
| `nameResolvers` | `NameResolver[]` | no | community-name resolvers (same interface and instances as pkc-js's `nameResolvers`, e.g. `@bitsocial/bso-resolver` for `name.bso`); each vote's `community.name` claim is verified through them — inline at the forward-gate for live votes, in the background verifier for cold-join admits — and a bundle whose name resolves to a different `publicKey` than claimed is dropped/evicted |
| `dataPath` | `string \| false` | no | directory for the voter's persistent state (gate-result + name-resolution caches, and each joined contest's **checkpoint snapshot** — its last fully-verified winner-set, reloaded at join so a restart with no other peer online keeps the tally), the pkc-js `dataPath` equivalent. Node default: `{cwd}/.bitsocial-pubsub-voting` (better-sqlite3 under `{dataPath}/lru-storage/` + `{dataPath}/checkpoints.db`); in the browser the path is ignored and everything lives in IndexedDB. Pass `false` for in-memory-only (the pkc-js `noData` equivalent). A restart re-serves settled gate reads and fresh name resolutions from the store instead of the RPC, and restores each contest's checkpoint before the cold-start pull. A seeder should always set a stable path |
| `httpRouterUrls` | `string[]` | no | Delegated Routing V1 router base URLs to **announce provider records to** (one unsigned `PUT /routing/v1/providers` per router; `Keys` batches every joined contest's criteria CID + current checkpoint root + chunk CIDs — hourly, debounced on root changes, and on address changes). **Seeders only**: absent/empty means never announce (the default — plain clients are not dialable), and the browser build never announces regardless. The node must be publicly **reachable** (its listening port open/forwarded/published), but it does not need to know its own public IP: private, loopback, and link-local addrs are filtered client-side, and when nothing survives — the normal zero-config case behind NAT or a Docker bridge, and even on public-IP hosts, since libp2p withholds unconfirmed public addrs pending AutoNAT — the announcer sends the wildcard sentinels (`/ip4/0.0.0.0/...`, `/ip6/::/...`) that the router rewrites to the PUT's observed source IP, exactly as kubo announces work. Configured `addresses.announce` values (concrete public addrs, DNS/AutoTLS, or a kubo-style wildcard) are used as-is. Only a loopback-only node announces nothing. *Querying* needs no URLs here — cold-join discovery uses the injected node's `libp2p.contentRouting`, which the host wires its routers into |

A contest is addressed by its **full criteria document**, passed to `createContest` / `createContestVote`. The document is strictly validated there (`CriteriaSchema` + the rule registry + the `chains` factory: an unimplemented rule throws `UnknownRuleError`, an unresolvable required chain throws `MissingChainClientError` — recuse, don't miscount), and its canonical bytes derive the topic — so the exact document every participant shares is the only contest configuration that exists. The document names each required chain only by ticker + `chainId`; RPC endpoints stay out of it, so operators can swap gateways without forking the topic.

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
  return ({ chainId }) => clients[chainId]; // undefined → recuse contests requiring that chain
};

const voter = new PubsubVoter({
  helia,                        // the host's Helia node; needs a gossipsub service at libp2p.services.pubsub + a blockstore
  chains: viemChainFactory(),   // ({ chain, chainId }) => viem PublicClient | undefined
  signer: mySigner,             // optional; omit → read-only voter
  nameResolvers: [bsoResolver], // optional; verifies community-name claims (e.g. @bitsocial/bso-resolver)
  dataPath: "/path/to/data",    // optional; persistent state: caches + checkpoint snapshots (default {cwd}/.bitsocial-pubsub-voting; false → in-memory)
  httpRouterUrls: [             // optional, SEEDERS ONLY (publicly reachable node): announce provider
    "https://routing.example"   // records (criteria CID + checkpoint root + chunks) so cold joiners
  ]                             // can discover this node via the routers; clients omit this
});
```

Construction throws `MissingPubsubError`, `MissingBlockstoreError`, or `MissingFetchError` if the node lacks a usable pubsub service, blockstore, or libp2p fetch service — the library fails fast rather than letting a later `publish`/`subscribe`/`fetch` fail obscurely. ("Bitswap" is not a separately checkable property — it is a block broker wired beneath `blockstore` — so the validated guarantee is a well-formed blockstore, the surface bitswap retrieves through. The fetch service carries the checkpoint root-record pull; the library registers its own responder on it.)

### Read a tally reactively (no signer needed)

`createContest` mints a per-contest read object; `update()` starts syncing and it emits `update` (carrying a fresh `tally`) and `error`, just like a plebbit-js `subplebbit`:

```ts
const contest = await voter.createContest({ criteria });  // criteria: the contest's full document (strictly validated here)
contest.on("update", () => render(contest.tally));        // tally rides the object; recomputed before each emit
contest.on("error", (err) => showConnectivityWarning(err)); // tally chain read failed, or the background verifier's RPC/resolver is down (retrying)
await contest.update();                                   // join the topic, cold-start, begin emitting
// const fresh = await contest.getTally();                // or force a fresh read, bypassing the cache
// await contest.stop();                                  // leave the topic
```

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

### Publish or withdraw a vote (needs a signer)

`createContestVote` mints a publishable ballot; `publish()` signs and broadcasts it once and emits `publishingstatechange`, like a plebbit-js publication:

```ts
const vote = await voter.createContestVote({ criteria, votes: [{ community: { publicKey: "12D3KooW..." }, vote: 1 }] });
vote.on("publishingstatechange", (state) => console.log(state)); // stopped → signing → publishing → succeeded (or failed)
const { bundle, recipientCount } = await vote.publish();          // the signed VotesBundle + how many peers gossipsub sent it directly to

// Withdraw (active): publish an empty ballot; it supersedes the prior vote under LWW.
await (await voter.createContestVote({ criteria, votes: [] })).publish();
```

A community's identity is its `publicKey`. The optional `name` is the community's resolvable domain (e.g. `memes.bso`) — unique per community, never a free label: the schema requires a TLD, the name is resolved through the injected `nameResolvers` (inline at the forward-gate for live votes, in the background verifier for cold-join admits), and any bundle whose name resolves to a different `publicKey` than claimed is dropped/evicted. Bundles must also name pairwise-distinct `community.publicKey`s. See [DESIGN.md, Votes wire](./DESIGN.md#votes-wire).

`recipientCount` is the peer-reach hint gossipsub reports: how many peers it sent the vote *directly* to at publish time (first-hop fan-out, filtered for send failures) — **not** total network reach, and **not** an acceptance confirmation, since each recipient still runs the forward-gate before re-forwarding. Treat it as a coarse "did this reach anyone?" signal. Note that gossipsub *rejects* the publish with `NoPeersSubscribedToTopic` when it would reach zero peers (common right after joining, before the mesh grafts), unless the host enables `allowPublishToZeroTopicPeers` — so a resolved `recipientCount === 0` only occurs under that host setting; otherwise a no-reach publish surfaces as a thrown error (and a `failed` state).

`publish()` on a voter built without a `signer` throws `ReadOnlyError` (and emits an `error`).

### Republishing is the client's job

A vote is not permanent: a bundle is valid only for `voteExpiryBuckets` after its `blockNumber`, so a live vote must be re-published before it decays. **This library does not do that automatically** — it publishes each vote once and the consuming client decides when (or whether) to refresh. To refresh, just `createContestVote(...).publish()` again; a new bundle at the current bucket supersedes the old one. To stop, simply stop refreshing and let the vote lapse. The library gives you what you need to schedule it — all pure, no chain reads:

```ts
import { republishIntervalBuckets } from "@bitsocial/pubsub-voting";

const cadence = republishIntervalBuckets(criteria); // ceil(voteExpiryBuckets / 2) — the recommended cadence, in buckets
// A vote sampled at bucket b (bundle.blockNumber / criteria.blocksPerBucket) expires once the
// current bucket exceeds b + criteria.voteExpiryBuckets; refresh before then.
```

See [DESIGN.md, Republishing is the client's job](./DESIGN.md#republishing-is-the-clients-job-not-this-librarys) for why an always-on re-signer was deliberately kept out of a library that runs on the host's shared node.

### Many contests (a 5chan-style directory)

One criteria document is one contest (one topic). A directory is conveniently authored as a single manifest of shared `defaults` plus one entry per slot — as in [5chan-directory-criteria.jsonc](./5chan-directory-criteria.jsonc) and [examples/5chan.ts](./examples/5chan.ts) — and `deriveDirectoryCriteria` derives the finished documents (`{ ...defaults, ...entry }`, shallow — an override replaces that whole field) and validates each one. What participants must share **byte-identically** is the derived documents (the topic is their CID), which is why every consumer of the same directory should derive through this one helper rather than re-implement the merge. The manifest is JSONC by convention; strip comments before parsing:

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
const voter = new PubsubVoter({ helia, chains, signer });
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

The gate and weight are a single flat registry of rules, one `type` per file, mirroring the pkc-js challenge registry. Each rule owns its option schema and is evaluated at the bundle's bucket block. Chain-reading rules get `ctx.chain` — the viem `PublicClient` for their `options.chain` — and write their own reads (`readContract`, `getBalance`, ...), pinning each call to the sampled block with `blockNumber: BigInt(ctx.blockNumber)`. There is **one kind**: `evaluate → { score: bigint }`, a non-negative score where `0n` means "does not qualify" (a result object, not a bare `bigint`, so slot-specific fields can be added later). The criteria has two *slots* drawing from the one registry — the **rule** slot treats the score as a gate (`> 0n` admits), the **weight** slot as the vote's magnitude. A wallet's vote counts as `rule.score > 0n ? weight.score : 0n`. A rule that needs a threshold returns `0n` below it (so `erc721-min-balance`'s optional `min` gates), which lets the same rule serve either slot. A chain-reading rule may also implement the optional `evaluateMany(walletAddresses, ctx)` batch hook — its semantics MUST equal mapping `evaluate` — which the background verifier uses to batch a cold join's gate reads (`erc721-min-balance` implements it over multicall3; see [DESIGN.md, Background chain verification](./DESIGN.md#background-chain-verification)).

Built-ins: `erc721-min-balance` (v1) and `constant` (v1). A host adds or shadows rules by `type` via the `rules` option — this is how clients like 5chan or seedit register custom rules without forking the library:

```ts
import { PubsubVoter, type Rule } from "@bitsocial/pubsub-voting";
import { z } from "zod";

const seeditModAllowlist: Rule<{ type: "seedit-mod-allowlist"; allow: string[] }> = {
  type: "seedit-mod-allowlist",
  optionsSchema: z.object({ type: z.literal("seedit-mod-allowlist"), allow: z.array(z.string()) }),
  async evaluate({ options, walletAddress }) {
    return { score: options.allow.includes(walletAddress) ? 1n : 0n }; // gate: 1n admits, 0n rejects
  }
};

const voter = new PubsubVoter({
  helia, chains,
  rules: { "seedit-mod-allowlist": seeditModAllowlist } // flat map; shadows/extends built-ins by `type`
});
```

A custom `type` becomes part of `dag-cbor(criteria)`, so it is provably pinned to the topic it runs on, and a client that does not implement a `type` named in `criteria.requires.rules` throws `UnknownRuleError` and recuses itself rather than miscounting.

### Weighted voting (deferred)

v1 ships `constant` weight (one Pass, one vote) **on purpose** — it resists whale dominance and downvote weaponization. Balance-derived, token-weighted voting (Pass gate + BSO weight via `erc20-balance`) is a designed-but-unshipped capability: the rule path and result shape leave room for it with no engine change, but it is not in the v1 built-ins and carries open governance/abuse and lazy-tally questions. See [ROADMAP.md](./ROADMAP.md) and [DESIGN.md, Future improvements](./DESIGN.md#future-improvements).

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
