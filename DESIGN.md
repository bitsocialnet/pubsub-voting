# Design: @bitsocial/pubsub-votes

This document is the design of record. The repo currently implements **schemas and interfaces only**; this explains what they are for and how the runtime will behave once built.

## Context

- **Consumer:** [5chan](https://github.com/bitsocialnet/5chan) and its [competitive directory system](https://github.com/bitsocialnet/5chan/blob/master/README.md#competitive-directory-system). Many boards compete for each directory slot; only the highest-voted board appears on the homepage. Current curation is manual pull requests to [`5chan-directories.json`](https://github.com/bitsocialnet/lists/blob/master/5chan-directories.json). This library replaces that with holder-decided, censorship-resistant voting.
- **Origin:** [pkc-js issue #25](https://github.com/pkcprotocol/pkc-js/issues/25), which sketched pubsub voting (settings in the topic, bucketized block numbers, per-bucket heartbeat republish). This design keeps the good parts and replaces the bare heartbeat with a Merkle-CRDT.
- **Host:** [pkc-js](https://github.com/pkcprotocol/pkc-js) (Public Key Communities) provides the shared libp2p/Helia node. It is *only* the node host: it supplies no identity and no signing for voting. This library adds everything chain-related, the CRDT, and the vote-signing/verification, none of which exist in pkc-js.

## Decisions

- **State model: Merkle-CRDT.** Votes form a last-write-wins element-set keyed by wallet, carried in a Merkle-DAG. Broadcast head CIDs over pubsub; fetch the diff by CID. Precedent: Merkle-CRDTs (Sanjuán et al., Protocol Labs 2020), `go-ds-crdt` (powers IPFS Cluster's shared pinset with no leader), OrbitDB, Secure Scuttlebutt.
- **Weighting v1: 5chan Pass only.** ERC-721 ownership gates eligibility; weight is constant (1 pass = 1 vote). The interpreter design keeps a combo path open (pass eligibility + BSO ERC-20 weight) without a redesign.
- **Voting is upvote-only in v1.** Downvotes turn a contest into a cheap weapon against competitors; approval-style upvotes (vote for as many boards as you like, capped by `maxVotesPerAddress`) avoid that. The wire keeps a numeric `vote` field so a future criteria could widen the range.
- **Identity is the voting wallet, not a pkc-js author.** The eligibility-chain wallet (whose private key 5chan or its clients hold, never pkc-js) signs each vote directly as EIP-712 typed data; the address recovered from that signature is the only identity in the system. There is no pkc-js author and no author→wallet binding — the signature *is* the identity. This drops a whole verification layer (no binding to forge or keep monotonic) and the ed25519 author signer.

## Votes are off-chain

A vote is never written to a blockchain. Casting a vote is: sign the bundle with the eligibility-chain wallet (EIP-712 typed data — no gas, an off-chain signature), store it as a dag-cbor node in the host's Helia blockstore (IPFS content-addressing, not a chain), and broadcast the new head CIDs over gossipsub. There is no transaction and no gas.

The chain is **read-only**, and only to decide *who may vote* and *how much*:

- **Eligibility** (`erc721-min-balance`): does the wallet hold the 5chan Pass? This is the Sybil-resistance anchor. Without a scarce, hard-to-forge asset gating votes, anyone could generate unlimited identities and stuff the ballot.
- **Weight** (`constant` in v1, which reads no chain state at all; `erc20-balance` reserved for the combo path).

`ChainClient` is just a viem `PublicClient` — read-only by construction (no wallet actions). The library does not wrap it in a curated read API; each interpreter writes its own reads (`readContract`, `getBalance`, ...) against whatever ABI it needs, so custom interpreters are not boxed into a fixed set of helpers. The `blockNumber` carried in a bundle is not a write either: it pins the bucketized historical block every verifier reads balances at (every interpreter call passes `blockNumber: BigInt(ctx.blockNumber)`), so the tally is deterministic across clients (see "CRDT" and the bucket math in `chain/`).

So the only on-chain action a voter ever takes is acquiring the Pass, once, beforehand and unrelated to voting. Dropping the chain entirely is possible in principle — eligibility and weight are a pluggable interpreter registry, so a non-chain eligibility interpreter could replace `erc721-min-balance` — but that would trade the Pass for some other Sybil-resistance mechanism, which v1 deliberately does not do.

## Why this resists the hard failure modes

### Can always-online peers drop votes?

No single peer can remove a vote from the network.

1. **Gossipsub floods.** Every honest peer re-forwards every valid message to its mesh. Declining to forward only affects a peer's own links; as long as one honest path connects you to the voter, you receive the vote.
2. **Aggregation is a monotonic union (a CRDT join).** Votes are signed and idempotent, so combining two peers' sets can only add, never remove. A liar can omit a vote from what it serves you but cannot subtract one that an honest peer serves.
3. **Cold start pulls from k peers and unions.** On join, fetch current heads from several independent peers via the libp2p fetch protocol and union them. To hide a vote, every source you consult must lack it.

The residual threat is an eclipse attack (all your peers are sybils), which is the standard p2p threat, not specific to voting. Mitigations are high peer count and diverse bootstrap/rendezvous.

### Is there precedent for agreed state over pubsub?

Yes. Merkle-CRDT is exactly "a pubsub topic whose peers converge on a shared latest state with no leader." `go-ds-crdt` runs this in production for IPFS Cluster. The Merkle structure also makes missing data **detectable**: a head CID commits to its whole history, so a client can tell when a peer served a truncated state and heal the diff by CID. The open-membership limit (you cannot learn about heads nobody told you) is what the multi-peer fetch in the previous section covers.

### Who publishes snapshots?

Anyone, trustlessly. A snapshot is a head CID plus compacted state that every client re-verifies locally. The publisher has zero authority because state only ever joins by union, so a bad snapshot cannot subtract or forge. The expected availability layer is **bitsocial-seeder**: hosts run it, it joins the vote topics and helps peers cold-start (the eth-bootnode / IPFS-gateway pattern), but it is convenience, not an oracle — union-only means a seeder can never subtract or forge a vote. If all seeders vanish, live gossip plus multi-peer fetch still works, just with slower cold start.

### How fast is cold start?

For a topic with ~1000 votes, cold start is **fetch-bound, not compute-bound**. The state is ~1000 small dag-cbor nodes (each: voting wallet address, one vote, blockNumber, one secp256k1 signature, parent CIDs ≈ 0.3–1 KB), so well under ~1 MB total. Walking that many small blocks over bitswap is round-trip-dominated: single-digit to low-tens of seconds against a healthy `bitsocial-seeder`, worse against flaky peers. The crypto is cheap (secp256k1 `ecrecover` is ~tens to low-hundreds of µs each, so recovering ~1000 vote signatures is still well under a second), and chain reads are lazy (tally only, only for ranking-relevant votes), so neither gates the join. The two levers that shrink this number are the **snapshot/compaction** format (fetch one compacted blob instead of N nodes — see "Open questions") and **per-contest topics** (sync only the slot you care about).

### What happens when criteria change on upgrade?

A criteria change is a new interpreter `type` and/or new criteria bytes (including the `contest` id, which is part of the encoded object), which is a new CID, which is a **new topic**. Old clients that do not implement a `type` named in `requires` recuse themselves rather than miscount. The old topic drains as people update. There is no state migration because the heartbeat republish means there is no long-lived server state.

## Components

```
schema/        the wire and the criteria document (zod)
interpreters/  flat type -> interpreter registry (one kind; eligibility/weight slots)
chain/         historical-block reads (ERC-721 / ERC-20), chainTicker -> RPC
verify/        vote signature (recovers the voting wallet), blockNumber monotonicity   [interfaces only for now]
crdt/          Merkle-clock + LWW reduction
transport/     gossipsub topic (broadcast heads + topic validator) + libp2p fetch (cold-start sync)
tally/         deterministic per-contest aggregation, lazy top-down verify
```

The first three plus `verify/`, `crdt/`, and `tally/` have no libp2p dependency, so the engine is unit-testable without a network. libp2p appears only in `transport/`.

### Criteria document

Shipped static in the client bundle (offline), and `topic = "bitsocial-votes/" + CID(dag-cbor(criteria))`. dag-cbor is canonical (sorted keys, rejects `undefined`), so identical bytes yield an identical topic, which is the self-validating binding — and reordering keys does *not* fork the topic, only different values/fields/types do. Optionally also publish the bytes to IPFS for out-of-band verifiers.

**One criteria document describes one contest, so there is one topic per contest (directory slot).** The `contest` value differs per document, which makes each contest's bytes distinct and forks the topic automatically. A client subscribes only to the contests it cares about, so cold start syncs one slot's votes rather than every directory's history — this is the main scaling lever (see "How fast is cold start?"). The `requires` block is the dependency manifest and doubles as version negotiation.

Because the rules live inside each document, a client that votes across a whole directory authors them in one manifest and derives one document per slot. [`5chan-directory-criteria.jsonc`](./5chan-directory-criteria.jsonc) is a **pure example** for 5chan — illustration only, not a shipped or authoritative config (the contract is the real 5chan Pass, but the bucket/expiry numbers, RPC URL, and the `/q/` override are placeholders). It is **not** a criteria document and is never encoded or published — it is a generator. It has a `defaults` block (every `CriteriaSchema` field except `name`/`contest`: 5chan Pass eligibility via `erc721-min-balance` on Base, `constant` weight, the one-vote-per-topic bounds) and a `contests` list of all 63 directory slots (`/a/`, `/biz/`, `/g/`, …). The client derives each slot's document by shallow-merging its entry over the defaults — `criteria = { ...defaults, ...entry }` — canonically encodes it, and gets one topic per slot.

The point of the structure is that **rules are per-contest, not global**. `defaults` is only a DRY authoring convenience; it is flattened away at derivation, so there is no shared rule object at runtime — every contest is a complete, independent document and topic. Any entry may override any field (the override replaces that whole top-level field, no deep merge), so `/a/` and `/adv/` can run different eligibility, weight, vote bounds, or expiry. The example shows this on `/q/` (5chan Feedback), whose entry raises the gate to two Passes; in 5chan v1 every other slot just inherits the common Pass gate. Key order in the file is irrelevant since dag-cbor sorts canonically, so editing `defaults` re-forks every inheriting slot in lockstep, while editing one `contests` entry forks only that slot.

### Votes wire

```
VotesBundle { address, votes: Vote[], blockNumber, signature }
Vote        { board: { name?, publicKey }, vote }
```

The contest is not on the wire as a field: one topic decides one contest, so the contest is implied by the topic the bundle was published to (and bound into the signature — see below). A vote names the `board` and a numeric `vote`. A `board` is a pkc-js community identity — `{ name?, publicKey }`, where `publicKey` is the B58 IPNS name (e.g. `12D3KooW…`, the same shape pkc-js uses) and `name` is an optional human label (which may be a resolvable domain like `business.eth`). `publicKey` is validated strictly as a base58btc IPNS key (pkc-js's `isIpns` check) and a domain or non-decodable string is rejected — stricter than pkc-js's own loose `z.string().min(1)` field, because this is the vote-identity boundary. **Board identity is `publicKey` alone**: the tally aggregates on `publicKey`, so two votes for the same board that disagree on (or omit) `name` still fold into one row and cannot be split or spoofed apart. Note `board.publicKey` is the *community's* identity, not the voter's — the voter is the eligibility-chain wallet in `address`. `address` is the voting wallet (the holder of the Pass / ERC-20) and MUST equal the address recovered from `signature`; it is carried so the LWW key and chain reads are available without re-recovering, and a forged `address` simply fails the recovery check.

The eligibility-chain wallet signs the bundle directly as **EIP-712 typed data** (`viem.signTypedData`; verification is `viem.verifyTypedData` / `recoverTypedDataAddress`). There is no separate author and no author→wallet binding — the recovered signer *is* the voter. The signed message binds:

- **the contest** — the criteria CID (equivalently the topic), carried as the raw binary CID bytes (see "Wire freeze"), so a signature can never be replayed onto another contest or another app's topic;
- **the `votes`** (each `board` `{ name, publicKey }` + numeric `vote`);
- **the `blockNumber`** — the LWW key and the bucketized block every verifier reads balances at.

The EIP-712 `domain` is `{ name: "bitsocial-votes", chainId }` with `chainId` set to the eligibility chain, which gives cross-chain/cross-app domain separation for free. There is deliberately no `version` field — nothing version-negotiates the domain, so a layout change is a new frozen vector, not a version bump. Constraints: `votes.length <= maxVotesPerAddress` (v1: 1, the one-vote-per-topic rule), and each `vote` within `voteSchema` (v1: exactly 1). An **empty `votes` array is always valid** — it is the withdrawal form (see "Cancelling a vote").

#### Wire freeze (v1)

The concrete EIP-712 `types` struct is frozen (see `src/signer/eip712.ts`, `BALLOT_TYPES`). Field names and order are part of the type hash, so any change is a breaking wire change that re-freezes the conformance vector:

```
Ballot { criteria: bytes, votes: Vote[], blockNumber: uint256 }
Vote   { board: Board, vote: int256 }
Board  { name: string, publicKey: string }
```

- **`criteria` is `bytes`, not a string.** It carries the raw binary CID (`cid.bytes`, 36 bytes for a CIDv1/dag-cbor/sha2-256 criteria — so `bytes32` cannot hold it). Hashing the canonical bytes avoids the multibase/version ambiguity a stringified CID would bake in, so independent clients recover identical signers. Note this is the CID of the whole criteria document, distinct from the `criteria.contest` slot-code field inside it — the ballot field is named `criteria` (not `contest`) to avoid that collision.
- **`vote` is `int256` (signed).** v1 is upvote-only, but signed leaves room for a future criteria to widen the range to downvotes without a layout change.
- **`board` is a `Board` struct `{ name, publicKey }`.** `publicKey` is the B58 IPNS community name; `name` is a display label. EIP-712 has no optional fields, so `name` is always signed as a string — the **empty string** when the wire vote carries no name. Since board identity is `publicKey` (not `name`), signing `""` versus a name for the same `publicKey` is the same board to the tally; the `name` in the signature is just the voter's display claim.
- **`blockNumber` is `uint256`.**
- The freeze is pinned by a fixed conformance vector (known key → known hash, signature, recovered signer) in `src/signer/eip712.test.ts`. Those literals are the cross-client spec: an independent implementation must reproduce them byte-for-byte.

### Cancelling a vote

There is no delete; the union only grows. A vote is removed two ways, both consistent with the monotonic union:

- **Active withdrawal.** Publish a newer bundle (higher `blockNumber`) with `votes: []`. LWW keyed by wallet picks the newest bundle, which now expresses *no vote*, so the tally drops it. The old bundle bytes may still be served, but `current()` resolves the wallet to the empty one. This is supersession, not deletion — the union still only gains a node.
- **Passive expiry.** Stop republishing. A bundle is valid for `voteExpiryBuckets` after its `blockNumber` (the issue #25 heartbeat), so a wallet that goes silent has its vote decay on its own. Keeping a vote alive means periodically re-signing with a fresh `blockNumber`. Changing a vote is the same mechanism: a newer bundle naming a different board supersedes the old one.

### Identity: the voting wallet, nothing else (net-new; pkc-js has no signer for this)

There is no pkc-js author and no author→wallet binding. The thing that holds the Pass is an eligibility-chain wallet, and that wallet signs each vote directly (see "Votes wire"), so the only identity is the address recovered from the bundle's EIP-712 signature. Collapsing the old two-key model (ed25519 author + a secp256k1 binding vouching for it) into one wallet signature removes an entire verification layer — there is no binding to forge, and no separate binding timestamp to keep monotonic.

The old "sign once, delegate to a cheap key" rationale does not apply here: the client holds the wallet key and signs programmatically, so there is no per-vote human wallet prompt to avoid — paying one secp256k1 signature per bundle is free. Wallet-key compromise is a wallet-level concern outside the protocol (the same as for any on-chain asset); there is no protocol-level binding-revocation step because there is no binding. Supersession and replay are handled entirely by `blockNumber` LWW + bucket expiry (see "CRDT" and "Cancelling a vote").

### CRDT

Last-write-wins element-set keyed by the voting wallet address (recovered from the bundle's EIP-712 signature); value is the bundle; conflict resolution is highest `blockNumber`, tiebreak lowest bundle CID (for determinism across clients). Each bundle is a dag-cbor DAG node linking the heads known at signing, stored in the host's Helia blockstore. Only head CIDs go over pubsub; missing ancestors are fetched by CID. Prune bundles older than `voteExpiryBuckets` and those superseded per wallet.

### Transport: gossipsub topic + validation

The transport is the only module that touches libp2p/helia. The host injects its running **Helia node** directly (the value `createHelia` returns) — no host-written adapter — and the transport drives that node's libp2p pubsub and blockstore itself. The node MUST carry a gossipsub service at `libp2p.services.pubsub` and a usable `blockstore`; `PubsubVoter`'s constructor validates both once via `requireHeliaServices` and throws `MissingPubsubError` / `MissingBlockstoreError` if either is absent or malformed (Helia's default services do not include pubsub), so the failure surfaces at construction rather than on the first `publish`/`subscribe`/`fetch`. (Bitswap itself is not a separately introspectable property — it is a block broker wired beneath `blockstore` — so the checkable guarantee is a well-formed blockstore, the surface bitswap retrieves through.) Over that node the transport does two things: **broadcast and receive head CIDs** on a gossipsub topic, and **fetch state** — bundles by CID through the blockstore, heads from peers on cold start. The topic is `"bitsocial-votes/" + CID(dag-cbor(criteria))` (see "Criteria document"), so subscribing to it is itself the proof that two peers ran identical rules.

Two fetch paths, by data kind:

- **Heads are a mutable pointer** (the current DAG tips for the topic). On cold start they are pulled from up to `k` peers via the libp2p **fetch protocol**, keyed by topic, then unioned (a single liar cannot hide a vote — see "Can always-online peers drop votes?").
- **Bundles are immutable, content-addressed blocks.** A head CID resolves to a `DagNode { value: VotesBundle, parents: CID[] }` — the actual signed votes plus the heads linked at signing — fetched **by CID via bitswap** through the injected Helia node's `blockstore`. The client then walks `parents`, fetching each unknown CID, back to ancestors it already has. Open choice: also serve whole DAG subtrees over the fetch responder so a seeder can answer "everything under this head" in one round trip instead of one bitswap fetch per node.

**Custom validation is a gossipsub topic validator.** When the transport subscribes, it installs a validator for the topic — a function returning `accept | reject | ignore` that gossipsub runs on every received message *before re-forwarding it*. `reject` and `ignore` stop a message from propagating, and `reject` also lowers the sender's gossipsub peer score (with StrictSign message signing, the penalty lands on the real origin peer). This is the standard libp2p / `@chainsafe/libp2p-gossipsub` pattern.

#### What stops someone publishing invalid head CIDs?

Nothing stops *publishing* them — and nothing needs to, because a head CID carries **no authority**. It is only a pointer; all trust comes from locally re-verifying the self-authenticating bundle behind it. (Same principle as snapshots above: a publisher has zero authority because state only ever joins by union.) Every way a message can be bad is caught somewhere:

| Published thing | Caught by | Outcome |
|---|---|---|
| Malformed bytes / not a bounded list of CIDs | topic validator (layer 1) | `reject` — not forwarded, sender scored down |
| Well-formed CID that resolves to nothing (or the sender won't serve it) | fetch-on-demand | fetch fails → no-op; state never changes |
| Resolves to a bundle that fails verification (bad signature, `address` ≠ recovered signer, vote out of range, expired bucket, over `maxVotesPerAddress`) | offline verify (layer 2) + chain (layer 3) | dropped — never stored, re-served, or counted |
| Resolves to a valid, eligible, signed bundle | — | a legitimate vote: counted once per Pass-gated wallet (the NFT gate bounds Sybils), LWW makes it deterministic, union makes it un-removable |
| Replayed/old bundle, or two conflicting bundles from one signer (equivocation) | LWW (higher `blockNumber`, tiebreak lower CID) + bucket expiry; the signature binds `blockNumber` so an old bundle cannot be re-stamped | resolves to one vote every client agrees on; a replayed older bundle is inert |
| Heads that omit known votes, or a peer that withholds | monotonic union + multi-peer cold-start fetch | cannot subtract a vote an honest peer serves (see "Can always-online peers drop votes?") |

The validator cannot fully verify a vote at gossip time: the message is only head CIDs, the referenced bundle has not been fetched, and full verification needs async chain reads done lazily by the tally. So validation is **layered**:

1. **Topic validator** (cheap, pre-flood): the message decodes to a bounded list of well-formed CIDs, within a size cap, within a per-peer rate. Pure and unit-testable; no network or chain.
2. **CRDT merge** (after fetching a bundle by CID): run offline verification — recover the EIP-712 vote signature and check it matches `address` — before admitting the node to the set or re-serving it. Invalid → drop.
3. **Tally** (lazy, on-chain): eligibility and weight reads, only for the votes that can still change the visible ranking.

The one residual is **resource exhaustion, not incorrectness**: a flood of plausible-looking but unresolvable CIDs costs wasted fetch attempts. It is bounded by the per-message CID cap and size cap, per-peer rate limiting, gossipsub peer scoring (which prunes persistently-bad senders), and a bounded fetch policy — fetch only unknown CIDs, cap concurrent and total fetches, and stop walking an ancestor chain the moment a node fails to verify.

### Tally

Deterministic per-contest aggregation with **bound-based lazy verification**: only verify the votes (signature, chain reads) that can still change the visible ranking, stopping once the remaining unverified weight cannot flip the order. Render provisional immediately and refine.

The lever is that **verification only ever subtracts weight** — a vote is either valid (keeps its weight) or invalid/ineligible (drops to `0`), never more. So each board has a **ceiling** (sum of its unverified claimed weight) and a **floor** (sum of its verified-valid weight); verifying raises the floor toward the ceiling, or drops the ceiling when a vote is rejected. The winner is locked the moment the leader's floor ≥ every other board's ceiling — no outcome of the unverified remainder can catch it. A full ranking locks pairwise top-down (`floor_i ≥ ceiling_{i+1}` for each adjacent pair); since 5chan only seats #1 per slot, the common case stops as soon as the leader is locked and never ranks the also-rans.

**Ties.** An exact tie of verified weight is possible, so `floor_i ≥ ceiling_{i+1}` locks a rank only when strict *or* when board *i* also wins the tiebreak. Two tied boards are ordered by lowest `sha256(bucketBlockHash ‖ publicKey)` (byte comparison of digests; `bucketBlockHash` is the hash of the current bucket boundary block — head rounded down to `blocksPerBucket` — on the criteria's chain, read via `eth_getBlockByNumber` on the same `PublicClient` the tally already holds; `publicKey` is the board identity's raw bytes). The seed is deliberately **rolling**: any tie rule derived from values known at board creation is grindable, because keygen is free — a bare lowest-`publicKey` rule (or a fixed seed named in the criteria) lets a creator grind leading key bytes at creation time and buy every future tie — whereas a future bucket block hash cannot be predicted, so there is nothing to grind. Bundle-CID-based tiebreaks are rejected outright: secp256k1 signature nonces make a bundle's CID freely re-rollable by its own signer mid-contest, and heartbeat re-signing churns every CID once per bucket anyway. Accepted costs: one extra RPC read per tally that actually hits a tie; a *persistent* tie re-rolls its winner each bucket (daily, at the example 43200-block Base buckets); and a transient disagreement window of seconds once per bucket, where two clients tallying right at the boundary disagree on which bucket is current until both have observed the boundary block — the same eventual consistency the CRDT accepts everywhere else. The boundary block lags the head by up to a full bucket, which also puts its hash past any realistic reorg depth. If multi-chain eligibility ever lands (see "Future improvements"), the seed chain must be picked deterministically — simplest is the first eligibility gate's chain; decide then.

Order the work cheap-first: the EIP-712 signature check is local and fast, the chain read is the costly part, so prune with the free check before spending a read — a bad signature (or `address` that does not match the recovered signer) drops a vote for zero chain reads. This is also a DoS lever: a board whose ceiling is already below the leader's floor is never touched, so padding a losing board costs nothing. The residual is padding a board to *look* like a contender to force disproving reads — the resource-exhaustion residual from "What stops someone publishing invalid head CIDs?" — bounded by the per-message and per-peer fetch caps.

The clean wire-derived ceiling is a v1 (`constant` weight) property: every vote's ceiling is trivially `1`, so claimed count *is* the ceiling. The reserved `erc20-balance` path derives magnitude *from* the chain read, so it has no free upper bound; lazy tally there needs a separate bounding scheme (see "Open questions").

## Interpreters

Mirror the pkc-js challenge registry ([src/runtime/node/community/challenges/index.ts:94](https://github.com/pkcprotocol/pkc-js/blob/master/src/runtime/node/community/challenges/index.ts#L94)): a `Record<string, interpreter>` where user entries shadow builtins. Each interpreter owns its option schema and is evaluated at the bundle's bucket block via a `ChainClient`.

One flat registry, one file per `type` directly under `interpreters/`, each co-locating its option schema with its evaluation function — the pkc-js `{ type, options-validation, verify }` shape. `registry.ts` holds `builtinRegistry`, `resolveRegistry` (host overrides shadow built-ins by `type`), and `validateCriteriaInterpreters` (the `eligibility`/`weight` refs must resolve and their options must parse, and every `requires.interpreters` name must resolve — else `UnknownInterpreterError` and the client recuses itself). `CriteriaSchema` stays loose (`{ type, ...options }`); the registry is the single source of truth for which `type`s are valid and how their options parse. Leaf interpreters depend only on the injected viem `PublicClient`, so they are unit-testable by stubbing its `readContract` (no network).

**One kind, one return type: a non-negative `number`.** There is a single interpreter kind; `evaluate` returns a score where `0` means "does not qualify". The criteria keeps two *slots* that draw from the one registry: the **eligibility** slot treats the score as a gate (`> 0` admits, `0` rejects), the **weight** slot treats it as the vote's magnitude. Final vote value = `evaluate(eligibility) === 0 ? 0 : evaluate(weight)`. A separate boolean eligibility kind was considered and rejected for the simplicity of one kind/one registry: an interpreter that needs a threshold (min Passes, min balance) bakes it in by returning `0` below the threshold (`erc721-min-balance` returns the holding or 0; `erc20-balance` takes an optional `min`). The same interpreter can therefore serve either slot — e.g. `erc721-min-balance` is a Pass gate in eligibility and "1 vote per Pass" in weight. Each slot holds exactly one interpreter; combining several — an AND of gates, or an additive weight — is a deferred *structural* extension, not a combinator interpreter (see "Future improvements").

| type | typical slot | v1 | Purpose |
|---|---|---|---|
| `erc721-min-balance` | eligibility | yes | Hold at least N of an ERC-721 (5chan Pass); scores the holding or 0 |
| `constant` | weight | yes | Fixed score per wallet (1 pass = 1 vote) |
| `erc20-balance` | weight (or eligibility with `min`) | reserved | Score by ERC-20 balance (BSO) for the combo path (the README's weighted example) |

## Dependencies

Match pkc-js exact versions so DAG nodes interop with the shared Helia 6 node: `zod 4.3.6`, `multiformats 13.4.2`, plus (added by the implementation later) `cborg 4.5.8`, `@ipld/dag-cbor`, `uint8arrays 5.1.0`. `viem 2.54.0` is a direct dependency: it is the chain client interpreters read through (`ctx.chain` is a viem `PublicClient`) and provides EIP-712 vote signing/verification (`signTypedData`, `verifyTypedData`, `recoverTypedDataAddress` — pkc-js has none of these). With the pkc-js author dropped, voting no longer needs ed25519 primitives. `@pkcprotocol/pkc-js`, `helia`, and `@libp2p/interface` are peer dependencies so libp2p is not double-bundled.

## Deferred pkc-js work

This library takes the host's Helia node directly and drives its gossipsub service and blockstore itself, so there is no host-written adapter to maintain — and the injected seam is exactly what pkc-js already holds, since `pkc.clients.libp2pJsClients[key]._helia` ([src/helia/libp2pjsClient.ts:20](https://github.com/pkcprotocol/pkc-js/blob/master/src/helia/libp2pjsClient.ts#L20)) *is* the Helia instance. It is private-by-convention and typed as raw Helia internals, though. Once this library's needs are firm, add a documented, version-stable accessor on pkc-js that returns that Helia node (carrying its gossipsub `libp2p.services.pubsub`, `blockstore`, and the registered-but-unexposed `fetch` service), rather than forcing consumers to reach through the churning `._helia` private field (for example the multiformats 13/14 split). pkc-js must register a gossipsub service on the node; without one, `PubsubVoter` construction throws `MissingPubsubError`. Track as a pkc-js issue and reference it here.

## Future improvements

Combining several interpreters into one criteria slot is decided in principle but deferred: v1 (Pass gate + `constant` weight) and the weighted example (Pass gate + single-asset weight) each use exactly one interpreter per slot, so nothing ships a combinator yet. The direction is *structural* — mirroring pkc-js `settings.challenges`, a list the runtime iterates — not a general recursive combinator interpreter.

- **Eligibility combining — a `challenges`-style AND-array.** Make the eligibility slot `InterpreterRef[]`, every term required (each scores `> 0`), iterated by the runtime exactly as pkc-js ANDs its `challenges`. This expresses "hold a Pass **and** ≥ N BSO" with no combinator and no recursion. Building it: `CriteriaSchema.eligibility` becomes a non-empty array (normalized before canonical encoding, so one logical rule stays one topic), `validateCriteriaInterpreters` iterates it, and `ChainReadContext` evolves from a single pre-resolved `chain` to a `chainFor(ticker)` resolver so each gate can name its own chain. An **OR**/nested gate, if ever needed, is a small *eligibility-only* `any` grouping decided then — still not a general combinator. (pkc-js also ORs via `exclude` indices, but every `exclude` dimension — `role`, `postScore`, `rateLimit`, account age — is a social/author signal absent for a bare voting wallet, so only the flat AND-array transfers.)
- **Weight combining — a weight-only, non-recursive reduction.** For multi-asset additive weight (e.g. `#Passes + BSO/1000`) add a reduction over weight-slot terms (a `sum`; `min`/`max` only if a real criteria needs them). It is weight-only — eligibility has the canonical AND reduction, weight has none, which is exactly why weight must *name* its operator — and non-recursive (a flat list of leaves, not a tree of combinators). It also requires resolving the lazy-tally upper bound for balance-derived weight (see "Open questions"), since a summed balance carries no free wire-side ceiling.

Neither introduces a single "combinator" abstraction into the core: eligibility composes by AND-listing, weight by a named reduction, and no interpreter recurses into the registry.

## Open questions

- **Combinator interpreter protocol — resolved: no general combinator.** Composition is not an interpreter concern. Each criteria slot holds exactly one interpreter; combining several is a *structural* matter deferred to "Future improvements" above (eligibility as a pkc-js-`challenges`-style AND-array; weight as a weight-only reduction). A general recursive combinator — a `sum`/`product`/`min`/`and`/`or` interpreter that resolves and invokes *others*, each naming its own `chain` — is rejected: in the numeric model `and` ≡ `min` and `or` ≡ `max`, and only additive *weight* ever motivated `sum`, none of which any shipped criteria uses. `erc20-balance` and `constant` are leaves and work today.
- **ERC-20 weight precision.** `erc20-balance` divides raw units by `decimals` to a JS `number` so the tally sorts as plain numbers; balances above ~2^53 base units after scaling lose precision. If exact large-balance weighting is needed, switch to `bigint` end-to-end (interpreter return + tally sort).
- **Lazy-tally upper bounds for non-constant weight.** The bound-based early stop in "Tally" assumes each unverified vote has a cheap ceiling — trivially `1` for `constant`. A balance-derived weight like `erc20-balance` (the README's weighted example) derives magnitude *from* the chain read, so it carries no free wire-side bound; lazy tally there needs a self-declared, verify-down balance, or it degrades to verifying every ranking-relevant vote. Decide when the first weighted contest ships — and, if a weight reduction ever lands, alongside it (see "Future improvements").
- **Snapshot/compaction format** for fast cold start. Can land after the live path works.
- **Application-level peer reputation for layer-2 invalidity.** Gossipsub `reject` scoring only punishes layer-1 badness (malformed bytes / not a bounded CID list), because that is all the topic validator sees. A well-formed head CID that later resolves to an *invalid bundle* (bad signature, `address` mismatch, vote out of range) was already accepted and re-forwarded at gossip time, so gossipsub cannot retroactively score the sender. Penalizing peers that repeatedly serve unverifiable bundles needs a separate reputation in the fetch/serve path. Open: whether v1 needs it, or whether the bounded-fetch policy + per-message caps suffice.
