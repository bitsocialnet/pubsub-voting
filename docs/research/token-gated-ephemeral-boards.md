# Token-gated ephemeral boards

> **Status:** Exploratory research, not a committed roadmap item or protocol specification.
>
> **Implementation status:** No implementation exists in this repository. Any prototype should
> begin as a separate package and must not change the frozen `@bitsocial/pubsub-voting` wire
> formats.

## Summary

An **ephemeral token board** is a public, ownerless discussion room derived deterministically
from an on-chain asset and a complete rules document. Nobody creates or administers the room.
A compatible client can open an asset identifier and join the same room as every other client
running the same rules.

The product hypothesis is simple:

> Every token can have a live, ownerless town hall with no setup.

Token ownership would authorize publishing and reacting. Peers would retain only a bounded,
recent window of signed posts and reactions. Optional stores could preserve history without
becoming authorities over the live room. A client such as Seedit could expose a route like
`/t/<asset>` while keeping its existing `/s/<community>` routes for durable, independently owned
Bitsocial communities.

This is a plausible adjacent protocol, but it is **not "pubsub voting with text in the vote
field."** It needs a different state model, wire format, security analysis, and product contract.
The current voting engine supplies useful lessons and possible future extraction seams, not a
ready-made message database.

### Working conclusions

- Preserve the idea as public research now; do not put it on the committed voting roadmap yet.
- Treat it as a separate room protocol and eventual package, not a new voting payload.
- Start with public reading and holder-gated writing, not private token chat.
- Use a common eligibility snapshot per fixed epoch as the leading defence against transferring
  one fungible balance through several live identities.
- Bound valid state with a fixed number of LWW post slots and one bounded reaction bundle per
  wallet; a token threshold alone is not a spam bound.
- Keep archives optional and non-authoritative, with visible provenance.
- Do not prototype until the existing pubsub-voting integrations have validated the shared node,
  browser, wallet-signing, and checkpoint paths end to end.

## Why this is interesting

### Product properties

- **Zero setup.** A room can be derived for every supported asset without an owner deploying a
  community node, registering a name, or configuring moderators.
- **No authoritative room server.** Live state converges from signed peer messages and
  independently verified eligibility.
- **A credible fallback channel.** Token holders gain a communication path outside the
  administrators of Telegram, Discord, X, or a project-controlled forum.
- **Ephemerality as a feature.** A room can feel like a live town hall rather than another
  permanent content archive.
- **Permissionless client support.** Seedit, 5chan, a token explorer, or a dedicated application
  could render the same protocol state.
- **A new primitive, not a replacement.** Durable discussions, stable permalinks, configurable
  moderation, and long-lived communities still belong in normal Bitsocial communities.

### Possible early uses

- live discussion around a token launch, governance vote, market event, or release;
- a holder-only posting surface that remains publicly readable;
- a censorship-resistant emergency channel when an official community is compromised;
- an ownerless comment layer beside a token page or explorer;
- time-boxed holder polls and proposal threads;
- NFT collection rooms; and
- later, rooms whose policy requires an intersection of holdings, such as asset A **and** asset B.

Product-market fit is unproven. The zero-setup property is the experiment: does an immediately
available room create coordination that would not justify setting up a conventional community?

## Relationship to `@bitsocial/pubsub-voting`

The voting design has already solved or explored several problems this research must inherit:

| Voting lesson | Possible room analogue |
|---|---|
| Criteria are canonically encoded and content-address the topic | A complete room policy content-addresses the room |
| Inline deltas are validated before forwarding | Posts and reactions are validated before forwarding |
| LWW state bounds one wallet's live voting state | Slot-keyed LWW state bounds one wallet's live posts and reactions |
| Checkpoints provide cold start and gap filling | Recent-room checkpoints restore bounded live state |
| Multi-peer union prevents one seeder from subtracting valid state | Stores and seeders provide availability without authority |
| Expiry removes silent voters | Epoch expiry removes old posts and reactions |
| Rule caches bound repeated chain reads | Eligibility caches amortize repeated room messages |
| Transferable holdings amplify wallet-keyed state | Fungible-token room eligibility needs an explicit transfer-safe design |

The important boundary is just as strong:

- Voting stores one current ballot bundle per wallet and aggregates numeric choices about
  communities.
- A room stores several independently addressable posts, references between posts, edits or
  tombstones, and reactions keyed by both voter and post.
- The voting signature, bundle codec, criteria schema, topic prefix, checkpoint vectors, and LWW
  key are frozen voting-specific wire contracts.

Forcing messages into those contracts would either make the room unsafe or destabilize the
voting protocol. A room prototype should live in a separate package, tentatively
`@bitsocial/pubsub-rooms`. Generic code should be extracted from voting only after both packages
demonstrate an identical abstraction.

## The central security finding

### A token threshold is not a rate limit

Requiring a wallet to hold 0.1% of a token may bound the number of simultaneously eligible
wallets, but it does not bound what an eligible wallet can publish. One valid holder can create an
unlimited number of unique signed posts unless the state model gives that holder a deterministic
capacity.

It also does not protect the first peer from malformed traffic. A peer still pays some cost to
decode, recover a signature, identify the policy, and possibly consult chain state before it knows
whether a message is valid. Validate-before-forward contains propagation; message-size limits,
per-peer transport limits, bounded validation concurrency, verdict caches, and peer scoring still
matter at the first hop.

The room therefore needs two separate controls:

1. **Consensus state bounds:** what one eligible identity is allowed to keep live under the shared
   policy.
2. **Local transport bounds:** what one peer connection is allowed to make this node inspect at
   once.

A temporal local rate such as "five messages per minute" cannot safely be a consensus `reject`:
two honest peers observe different subsets and timings. It can only be a local `ignore` heuristic.
A fixed number of signed LWW slots, by contrast, is deterministic and independently replayable.

### Transferable balances amplify live identities

Suppose posts remain live for three days and eligibility is checked when each post is first
received. One balance can move A → B → C during that window. A, B, and C can each leave posts that
remain valid in different peers' state, because every individual historical balance check was
correct and the state is keyed by wallet.

This is the same amplification that keeps `erc20-balance` and transferable `erc721-min-balance`
out of the voting library's built-in registry. A room for arbitrary tokens cannot treat it as an
edge case.

## Candidate v1 model

This section is a research direction, not a settled specification.

### 1. Chain-qualified asset identity

A contract address alone is ambiguous across chains. Use a chain-qualified identifier compatible
with [CAIP-19](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-19.md), for example:

```text
eip155:8453/erc20:0x1234...
```

The canonical identifier belongs in the policy bytes. Token symbol, name, logo, and decimals are
display metadata and must not identify the room.

### 2. Content-addressed policy

The full canonical policy, not a human label such as `ruleset-standard-1`, should derive a policy
CID. A short standard name may select those bytes in a client, but it is not sufficient protocol
identity: implementations can disagree about what the name means.

Illustrative, incomplete policy:

```text
RoomPolicy {
  protocol: "bitsocial-token-room"
  version: 1
  asset: "eip155:8453/erc20:0x1234..."
  epochBlocks: 43200
  snapshotOffsetBlocks: 12
  minimumBalance: "1000000000000000000"
  postSlotsPerWallet: 5
  maxPostBytes: 4096
  maxReactionsPerWallet: 100
  requires: { rules: [...], chains: {...} }
}
```

Every field that changes validity or deterministic state belongs in the canonical policy. RPC
URLs, bootstrap peers, store endpoints, UI sorting preferences, and local content filters are
client settings and must not fork the room.

Conceptually:

```text
policyCid = CID(dag-cbor(RoomPolicy))
epoch     = floor(finalizedHead / epochBlocks)
topic     = "bitsocial-rooms/" + policyCid + "/" + epoch
```

An explicit policy-CID URL is the unambiguous share link. A clean `/t/<asset>` route still embeds
a client decision about which policy version to select. The UI should disclose that selection and
make other active policy forks discoverable rather than implying that one client default is a law
of nature.

### 3. Fixed eligibility epochs

The strongest candidate for transferable assets is a common eligibility snapshot per epoch:

- derive one finalized snapshot block for the whole epoch;
- evaluate every wallet's minimum balance at that block;
- admit only messages for that same epoch; and
- expire the epoch's active state as the next epoch takes over.

Within an epoch, moving the token after the snapshot cannot create another eligible wallet because
the receiver had no balance at the common snapshot. The seller may remain eligible until the epoch
ends. That staleness is an explicit bounded tradeoff rather than unbounded identity amplification.

The snapshot should trail the apparent epoch boundary by a chain-specific finality margin. Every
client must derive the same block after a reorganization; "the latest block I saw" is not a
consensus rule.

Two alternatives remain worth comparing:

- **Hold-duration rule:** require the threshold both at the message's pinned block and one live
  window earlier. This fits a rolling window, but imposes a waiting period and requires archive RPC
  depth.
- **Asset-keyed state:** key state by the scarce asset rather than the wallet. This can work for
  NFTs if the token ID is declared and signed, but it does not generalize naturally to fungible
  balances.

The fixed snapshot is the best starting hypothesis for a fungible-token room because it gives one
deterministic eligibility set and aligns naturally with ephemeral state.

### 4. Bounded post state

Give each eligible wallet `K` post slots per epoch. Key a post by:

```text
(epoch, wallet, slot)
```

The highest sequence or version for that key wins; a deterministic CID tie-break resolves equal
versions. Creating a sixth live post with five slots must replace one of the wallet's own slots.
It must not add a sixth state entry.

An illustrative post payload:

```text
Post {
  epoch
  slot
  sequence
  parentCid?
  content
  sessionPublicKey
  walletAuthorization
  signature
}
```

Open questions include whether `parentCid` references the immutable post version or the mutable
slot identity, how an edit affects reactions, and how long a tombstone must remain to prevent a
stale checkpoint from resurrecting replaced content.

The first experiment should avoid edits and use each slot only once. That proves the bound before
adding lifecycle semantics.

### 5. Bounded reaction state

Do not create an unbounded `(wallet, postCid)` CRDT entry for every reaction. Give each wallet one
current reaction bundle per epoch:

```text
ReactionBundle {
  epoch
  reactions: [{ postCid, value }]
  sequence
  signature
}
```

The policy caps `reactions.length`. LWW keyed by `(epoch, wallet)` means a wallet always occupies
one reaction-state entry, regardless of how often it changes its choices. The active post set is
already bounded, so reaction references can be pruned with the epoch.

An initial protocol should support `+1` only. Negative reactions turn sorting into a suppression
weapon and still do not provide moderation or deletion.

### 6. Wallet authorization and session keys

Prompting a browser wallet for every post would make chat unusable. A wallet should sign one
EIP-712 authorization binding a temporary session key to:

- the exact policy CID;
- one epoch;
- the wallet address;
- the allowed action types; and
- an expiry or epoch identifier.

Posts and reaction bundles are then signed by the session key. Every verifier checks the wallet
authorization, session signature, epoch, and on-chain eligibility.

This improves safety and UX but not privacy: the authorization still links the session to the
holding wallet. Private membership would need a later anonymous-proof design. Waku's
[RLN Relay](https://rfc.vac.dev/waku/standards/core/17/rln-relay/) is a useful precedent for
anonymous membership credentials with an enforceable per-epoch message allowance, but applying
that model to arbitrary, changing token-holder sets would require a trustworthy or independently
reproducible membership-root pipeline.

Smart-contract holders also need an explicit decision. Supporting
[ERC-1271](https://eips.ethereum.org/EIPS/eip-1271) would allow contract wallets, multisigs, and
DAOs to authorize sessions, but it adds a chain read and more cache semantics to signature
verification. An EOA-only prototype should disclose that exclusion.

### 7. Validate before forward

The live path should preserve the voting transport's cheap-to-expensive ordering:

1. enforce a hard transport size ceiling;
2. decode a fixed message union and enforce the policy-derived semantic size cap;
3. check epoch, slot, sequence, references, and other offline constraints;
4. verify the session signature and wallet authorization;
5. consult a cached snapshot-eligibility result; and
6. accept and merge only after full validation.

Malformed or provably invalid messages can be rejected and peer-scored. Local over-rate,
validation timeouts, RPC failures, and other view-dependent conditions should be ignored without
blaming the sender.

As with voting, validity caching is required but not sufficient. A fresh peer ID can still submit
a novel wallet or signature, so host-owned gossipsub scoring, IP-colocation penalties, newcomer
budgets, validation concurrency, and maximum transmit size remain part of deployment security.

### 8. Checkpoints, stores, and archives

Peers need recent history when they were offline. Reuse the checkpoint trust model, not
necessarily its implementation:

- each checkpoint commits to the current bounded post slots, tombstones, and reaction bundles;
- clients pull several independent roots and union self-verifying entries;
- a store may omit data but cannot forge a wallet or session signature;
- a client never treats root agreement as an acceptance quorum; and
- only fully verified entries are re-served.

An ephemeral room still needs availability infrastructure. "No authoritative node" does not mean
"no nodes." Live peers, seeders, or store services must remain online long enough for users to
recover recent messages. The Waku protocol family similarly separates live relay from optional
[store retrieval](https://docs.waku.org/learn/concepts/protocols/) and does not claim that a store
guarantees availability.

Long-term archives are a different product:

- archived messages remain cryptographically attributable;
- an archive can selectively omit history and must not be presented as complete;
- clients should show archive provenance and query more than one source where practical;
- archives do not participate in deciding current live state; and
- a room policy's expiry remains valid even if a third party preserves the bytes forever.

Nostr's distinction between
[ephemeral and replaceable events](https://github.com/nostr-protocol/nips/blob/master/01.md) is a
useful product and storage reference, although Nostr relay trust and synchronization differ from
the model explored here.

## Product and UX contract

### Route namespace

Do not overload Seedit's `/s/:communityAddress` route. `/s/` already identifies durable Bitsocial
communities and competitive directory routes. An ownerless token room is a different primitive
with different guarantees.

Candidate routes:

```text
/t/eip155:8453/erc20:0x1234...
/token/eip155:8453/erc20:0x1234...
```

The human route may omit the policy CID for convenience. Share links should be able to pin it:

```text
/t/<asset>?policy=<cid>
```

### Suggested views

- **Live:** current epoch, synced from peers and recent stores.
- **Top:** deterministic ranking within the current epoch.
- **Archive:** optional third-party history with explicit source and completeness warnings.

The client should display:

- asset identifier, chain, and contract;
- the active policy and version;
- minimum balance and snapshot block;
- when the epoch expires;
- verification/synchronization state;
- whether the view came from live peers, stores, archives, or a combination; and
- concentrated or administrator-controlled token properties when known.

### "Official" without ownership

A token issuer or DAO may sign descriptive metadata or recommend a policy CID. That endorsement
must not grant deletion, ranking, or message-admission powers. The UI can distinguish:

- **deterministic room:** exists for the asset under a known policy;
- **issuer-endorsed metadata:** descriptive signal only; and
- **client-selected default:** the policy this client opens for a clean route.

This prevents "ownerless" from quietly becoming "the issuer is the room administrator."

### Empty-room behavior

A protocol-level room can exist for every asset while having no peers, no recent posts, no store,
or no compatible RPC. The client should say which condition it observed rather than promising that
"automatic" means "available and populated."

## Moderation and safety

Token gating is admission control, not moderation.

An ownerless v1 cannot globally remove scams, harassment, illegal media, wallet-address doxxing,
or coordinated low-quality content. Minimum client safeguards are:

- local wallet/session mute and block;
- local word, media, and content-label filters;
- strict text and link size limits;
- no inline media in the first version;
- optional user-selected shared filter lists whose provenance is visible;
- safe link handling and clear wallet-signature prompts; and
- no claim that upvotes or token balance establish truth.

Shared filters could later be signed and themselves selected by holder voting, but that is another
protocol surface. It should not block the text-only experiment.

## Token-specific limits

"Any token" is an aspiration, not a safe v1 promise. A robust client must account for:

- mutable or upgradeable token contracts;
- issuer-controlled minting, burning, pausing, or blacklisting;
- rebasing or elastic supply;
- tokens that lie about standard interfaces or revert on historical reads;
- proxy implementations changing across the live window;
- bridges representing the same economic asset on several chains;
- treasuries, exchanges, liquidity pools, and smart wallets holding large balances;
- unreliable `totalSupply`, decimals, symbols, or metadata; and
- RPC endpoints without the required historical state.

A room can be ownerless while its gating asset remains centrally controlled. The UI and research
must not collapse those two claims.

### Why 0.1% should not be the universal default

A 0.1% threshold theoretically allows at most 1,000 threshold-sized balances, but real holder
distributions may leave only a handful eligible. `totalSupply` may include burned, locked,
treasury, bridged, or not-yet-circulating units, and it may change.

Candidates to test include:

- a fixed raw minimum encoded in the policy;
- a basis-point share of supply at the epoch snapshot;
- several named standard tiers, such as open-holder, broad-holder, and major-holder rooms; or
- discovery that shows several active policy forks rather than declaring one universal threshold.

Deriving a threshold from holder percentiles would require an indexer or reproducible holder-set
snapshot and is not a simple on-chain rule.

## What not to do

### Do not reuse the voting wire

Posts are not numeric votes for a community key. Reusing `VotesBundle` would destroy type meaning,
make checkpoints and constraints misleading, and turn any future room change into a voting wire
change.

### Do not put a temporal rate in consensus criteria

Honest peers do not observe an identical message timeline. A per-minute rate can be a local
transport guard; deterministic post slots and epoch eligibility are the shared state bound.

### Do not make the token address the whole topic string

The chain, policy bytes, protocol version, and room kind all affect validity. Content-address the
complete policy so peers on one topic provably interpret the same state.

### Do not promise permanent history from the live protocol

Keeping everything forever destroys the bounded-state property. Archives may preserve signed
history, but they are optional data sources with explicit provenance.

### Do not generalize `pubsub-voting` before a prototype

The correct extraction boundary is unknown. Duplicating a small amount of code in an experiment is
safer than inventing a generic pubsub-state framework that constrains two protocols before the
second protocol exists.

## Suggested experiment

Do not begin the experiment until pubsub voting works end-to-end in its first clients. The voting
integration is the best way to validate the shared host node, browser constraints, wallet signing,
chain clients, and checkpoint behavior before adding another protocol.

When that prerequisite is met, run a short, separate two-peer prototype.

### Included

- one EVM chain;
- one conventional ERC-20 test asset;
- one fixed policy document and one epoch;
- finalized snapshot-block eligibility;
- public reading and holder-gated writing;
- EOA wallet authorization of one session key;
- text-only root posts;
- a small fixed number of post slots per wallet;
- `+1` reactions in one bounded bundle per wallet;
- validate-before-forward live gossip;
- one recent-state checkpoint; and
- process restart with recovery from another peer or store.

### Excluded

- production Seedit or 5chan routes;
- images, video, file attachments, embeds, and link previews;
- private or encrypted rooms;
- replies, editing, and deletion;
- smart-contract wallet signatures;
- cross-chain or bridged assets;
- anonymous holder proofs;
- shared moderation lists;
- long-term archives; and
- automatic policy discovery.

### Success criteria

The experiment should answer these questions with tests or measurements:

1. Do two fresh peers derive the same topic and converge on the same posts and reactions?
2. Is live state strictly bounded by eligible wallets × slots plus one reaction bundle per wallet?
3. Can moving the token after the epoch snapshot create a second eligible identity in that epoch?
4. Does a fresh peer recover recent state after the publishers go offline?
5. Does one malicious but eligible wallet remain bounded to its configured slots?
6. Do duplicate and replaced messages avoid repeat chain reads?
7. Does invalid traffic stop at the first honest forwarding peer?
8. How long do first render and full eligibility verification take from a cold start?
9. What happens when the RPC is unavailable, behind the snapshot block, or returns a reorged view?
10. Do users understand that the room is live and ephemeral rather than incomplete or broken?

A technically successful experiment is still not product validation. The product test is whether
real holders choose this room when an easier centralized chat already exists.

## Open questions

### Protocol

- What exact chain finality rule selects the epoch snapshot block?
- Is the topic per policy with epoch in each message, or per policy-and-epoch as sketched here?
- How many prior epochs should a live node retain to smooth boundary transitions?
- How are slot sequences ordered without letting signers backdate or grind useful state?
- What is the correct checkpoint key and tombstone lifetime once editing exists?
- Can replies reference a stable slot while preserving the integrity of the originally viewed
  parent?
- How are reaction totals treated when a post is replaced or expires?
- Should each policy expose one board, separate chat and board modes, or different protocol kinds?

### Eligibility

- Fixed minimum, supply percentage, or several standard tiers?
- What happens when the token upgrades, rebases, pauses, or changes its supply within an epoch?
- Is endpoint-only balance proof sufficient for the chosen epoch model?
- Are delegated, staked, LP, bridged, and smart-wallet holdings in scope?
- How are contracts using ERC-1271 represented in the state key?
- Can anonymous membership and rate-limit proofs be generated from reproducible holder snapshots
  without introducing an authoritative indexer?

### Network and storage

- How does a seeder discover which of potentially infinite asset rooms have activity without
  joining arbitrary attacker-created topics?
- Should recent stores announce by policy CID, epoch CID, checkpoint CID, or all three?
- What caps bound a store request and stop a small request from reflecting a large checkpoint?
- How does a browser in gateway mode participate when it has no directly usable Helia node?
- Which transport settings must the host expose for message size, peer scoring, and validation
  budgets?

### Product

- Should reading be public by default, or should some policies encrypt content for holders?
- How are policy forks shown without confusing users?
- What makes one clean-route policy the default, and how is that choice upgraded?
- What local moderation defaults are acceptable for a public ownerless surface?
- Should an issuer endorsement affect discovery without granting protocol authority?
- Is a quiet room useful as an emergency channel, or does low activity make it indistinguishable
  from broken synchronization?

## Long-term possibilities

If the bounded text-room experiment works, possible extensions include:

- **Event rooms:** deterministic, short-lived rooms tied to a proposal, token launch, or block
  interval.
- **Proposal mode:** holder-created proposals with a separate snapshot-based voting state.
- **Policy competition:** clients expose several active rule forks and let adoption select among
  them without pretending the clean route is protocol consensus.
- **Intersection rooms:** policies requiring several assets or membership signals.
- **Private rooms:** anonymous membership proofs plus forward-secure group encryption; substantially
  harder than gated public writing.
- **Archive markets:** independent stores compete on availability, retention, and indexing while
  signed data remains portable.
- **Portable moderation:** user-selected signed filter lists or filter-list voting, separate from
  message validity.
- **Token-explorer integration:** an ownerless "holders are discussing" view embedded beside asset
  data.
- **Protocol bridges:** render the same room in Seedit, 5chan, mobile clients, and specialized
  governance applications.

## Implementation boundary

If research progresses:

1. Keep `@bitsocial/pubsub-voting` unchanged while the experiment is built.
2. Create a separate prototype package with its own schemas, signatures, topic prefix, CRDT, and
   vectors.
3. Reuse the host's existing Helia/libp2p node rather than starting a second node.
4. Compare implementations only after the room has real tests.
5. Extract narrowly reusable pieces—canonical criteria addressing, checkpoint primitives, or
   transport guards—only where both consumers need byte-for-byte identical behavior.
6. Preserve separate application semantics even if lower-level machinery eventually shares a
   package.

The likely long-term shape is not "voting becomes a generic database." It is several small,
auditable protocols sharing a conservative pubsub-state toolkit.

## References

- [`@bitsocial/pubsub-voting` design](../../DESIGN.md), especially "Does one Pass mean one vote?",
  "Can valid votes clog the topic?", "Checkpoints", and "Transport."
- [`@bitsocial/pubsub-voting` roadmap](../../ROADMAP.md), especially the intentionally unregistered
  transferable and ERC-20 rules.
- [CAIP-19: Asset Type and Asset ID Specification](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-19.md)
- [ERC-1271: Standard Signature Validation Method for Contracts](https://eips.ethereum.org/EIPS/eip-1271)
- [Waku Network specification](https://rfc.vac.dev/waku/standards/core/64/network/), including RLN
  rate limiting and store-service roles.
- [Waku protocol overview](https://docs.waku.org/learn/concepts/protocols/)
- [Nostr NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), including ephemeral and
  replaceable event conventions.
