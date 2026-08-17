import { describe, it, expect, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { encodeBundle, bundleCidForBytes } from "../../crdt/codec.js";
import type { BundleVerdict, BundleVerifier } from "../../verify/types.js";
import { makeBundleVerifier } from "../../verify/bundle.js";
import { builtinRegistry } from "../../rules/registry.js";
import { erc721MinBalance } from "../../rules/erc721-min-balance.js";
import { makeBucketMath } from "../../chain/bucket.js";
import { ballotTypedData, EIP712_SIGNATURE_TYPE } from "../../signer/eip712.js";
import { criteriaCid } from "../../topic.js";
import { bizCriteria, bizGateRef } from "../../test-fixtures.js";
import type { Criteria } from "../../schema/criteria.js";
import type { ChainClient, NameResolver } from "../../chain/types.js";
import type { Vote, VotesBundle } from "../../schema/votes.js";
import { makeVoteNode, connectNodes, waitFor, delay, sampleBundle, type VoteNode, type VoteNodeOptions } from "./harness.js";

/**
 * Two real libp2p + Helia nodes running `@libp2p/gossipsub` (>= 15.0.23, the CVE-2026-46679
 * floor). These pin what the pure unit tests (`gossip-validator.test.ts`, `chase.test.ts`)
 * cannot: real gossipsub forwarding, real peer scoring on a `reject`, a rejection produced by
 * the REAL verify pipeline (EIP-712 recover → constraints → the erc5192-min-balance "5chan Pass"
 * gate → name resolution, only the chain read and registry stubbed) — including a byzantine
 * bundle claiming a community name mapped to a different key, dropped with `ignore` (no
 * penalty, uncached) — the real validation deadline, heartbeat-suppression quiet, and a real
 * directed-bitswap chase across a live connection. Slow by design — gated out of
 * `npm test`, run via `npm run test:integration`.
 *
 * The divergent-root chase is driven from a **heartbeat** root record (no chunk index), so it
 * exercises the manifest-fetch **fallback** path; the name-mismatch test drives a cold-start
 * fetch pull (real `@libp2p/fetch` → `FetchRootRecord.chunks` → chase), covering the
 * **piggyback fast-path** that skips the root-manifest round-trip (see DESIGN.md "Block pull").
 */

const TOPIC = "bitsocial-votes/integration-test";
const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12D3KooWQYV9dGMFoRzNStwpXztXaBUjtPqi6aU76ZgUriHhKust";
const ADDR = "0x1111111111111111111111111111111111111111";

const reject = (): BundleVerdict => ({ valid: false, disposition: "reject", reason: "test reject" });
const accept = (): BundleVerdict => ({ valid: true, resolvedNames: {} });

// --- Real-verifier fixtures (the soulbound ERC-5192 "5chan Pass" gate over bizCriteria) ---------

// The chain the contest counts in, as bizCriteria() pins it (bucketChainId).
const BIZ_CHAIN_ID = 8453;
// The anvil/hardhat test account #1 — signs real EIP-712 ballots reproducibly (as in verify/bundle.test.ts).
const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

/** A genuinely-signed one-vote bundle for `bizCriteria()`: only steps ≥ 2 of the pipeline can fail it. */
async function passSignedBundle(blockNumber: number, communityName?: string): Promise<VotesBundle> {
    const community = { publicKey: KEY_A, ...(communityName !== undefined ? { name: communityName } : {}) };
    const votes: Vote[] = [{ community, vote: 1 }];
    const cid = await criteriaCid(bizCriteria());
    const typedData = ballotTypedData({ criteriaCid: cid.bytes, chainId: BIZ_CHAIN_ID, votes, blockNumber });
    const signature = await wallet.signTypedData(typedData);
    return { address: wallet.address, votes, blockNumber, signature: { signature, type: EIP712_SIGNATURE_TYPE } };
}

/**
 * The REAL verify pipeline over bizCriteria; only the chain reads are stubbed. The v1 gate
 * (`erc5192-min-balance`) makes two: the contract's ERC-5192 declaration (always true here — the
 * Pass is soulbound) and the wallet's `balanceOf`, which is what these tests vary.
 */
async function realVerifier(passBalance: bigint, nameResolvers: NameResolver[] = []): Promise<BundleVerifier> {
    const criteria = bizCriteria();
    return makeBundleVerifier({
        criteria,
        criteriaCid: (await criteriaCid(criteria)).bytes,
        chainId: BIZ_CHAIN_ID,
        registry: builtinRegistry,
        chain:
            ({
                readContract: async ({ functionName }: { functionName?: string } = {}) => (functionName === "supportsInterface" ? true : passBalance),
                // The v1 gate reads the head first and only falls back to the ballot's pinned
                // block, so this stub serves the live head read (rules/types.ts,
                // ChainReadContext.head).
                getBlockNumber: async () => BigInt(criteria.blocksPerBucket * 2 + 7)
            }) as unknown as ChainClient,
        bucketMath: makeBucketMath(criteria.blocksPerBucket),
        nameResolvers
    });
}

// --- Composite-gate fixtures (a tree, not one rule) ---------------------------------------------

/**
 * A second gate rule, on its own contract, whose failure IS attributable: `erc721-min-balance`
 * reads the ballot's pinned block, so its `0n` is identical on every honest verifier and it leaves
 * `penalize` at the default. Pairing it with the head-reading (unattributable) Pass rule is what
 * makes the `all`/`any` asymmetry observable in gossipsub's scoring rather than only in a fold.
 */
const MOD_CONTRACT = `0x${"ab".repeat(20)}`;
const MOD_RULE = { type: "erc721-min-balance", contract: MOD_CONTRACT, min: 1 };

const compositeCriteria = (gate: unknown): Criteria => ({ ...bizCriteria(), gate }) as Criteria;

/** The real pipeline over a composite gate; each rule's contract gets its own stubbed balance. */
async function compositeVerifier(criteria: Criteria, balances: { pass: bigint; mod: bigint }): Promise<BundleVerifier> {
    return makeBundleVerifier({
        criteria,
        criteriaCid: (await criteriaCid(criteria)).bytes,
        chainId: BIZ_CHAIN_ID,
        // `erc721-min-balance` is deliberately not a builtin (issue #27); a host opts in explicitly.
        registry: { ...builtinRegistry, "erc721-min-balance": erc721MinBalance },
        chain:
            ({
                readContract: async ({ address, functionName }: { address?: string; functionName?: string } = {}) => {
                    if (functionName === "supportsInterface") return true;
                    return address?.toLowerCase() === MOD_CONTRACT ? balances.mod : balances.pass;
                },
                getBlockNumber: async () => BigInt(criteria.blocksPerBucket * 2 + 7)
            }) as unknown as ChainClient,
        bucketMath: makeBucketMath(criteria.blocksPerBucket),
        nameResolvers: []
    });
}

/** A genuinely-signed ballot for an arbitrary criteria document (its CID is bound into the domain). */
async function signedFor(criteria: Criteria, blockNumber: number): Promise<VotesBundle> {
    const votes: Vote[] = [{ community: { publicKey: KEY_A }, vote: 1 }];
    const cid = await criteriaCid(criteria);
    const typedData = ballotTypedData({ criteriaCid: cid.bytes, chainId: BIZ_CHAIN_ID, votes, blockNumber });
    const signature = await wallet.signTypedData(typedData);
    return { address: wallet.address, votes, blockNumber, signature: { signature, type: EIP712_SIGNATURE_TYPE } };
}

/** A `.bso` registry that instantly maps every name to `publicKey` (as in client/voter.test.ts). */
function bsoResolver(publicKey: string): NameResolver {
    return {
        key: "instant",
        provider: "test",
        canResolve: ({ name }) => name.endsWith(".bso"),
        resolve: async () => ({ publicKey })
    };
}

let live: VoteNode[] = [];

afterEach(async () => {
    await Promise.all(live.map((n) => n.stop()));
    live = [];
});

/** Build two connected nodes; `bOptions` tunes the receiver (e.g. a short validation deadline). */
async function connectedPair(bOptions?: VoteNodeOptions): Promise<{ a: VoteNode; b: VoteNode }> {
    const a = await makeVoteNode(TOPIC);
    const b = await makeVoteNode(TOPIC, bOptions);
    live.push(a, b);
    await connectNodes(a, b);
    return { a, b };
}

describe("two-node gossipsub (real @libp2p/gossipsub)", () => {
    it("rejects an invalid inline bundle: not forwarded and the sender is reject-scored (P4)", async () => {
        const { a, b } = await connectedPair();
        b.setVerifier(async () => reject());

        await a.transport.publishBundle(encodeBundle(sampleBundle(ADDR, KEY_A)));

        // A `reject` verdict must move the sender's score negative on the receiver (P4).
        await waitFor(() => b.pubsub.getScore(a.peerId) < 0, 15_000, "B to penalize A's peer score");
        // Rejected ⇒ never delivered to the app (so never forwarded to the mesh) and never merged.
        expect(b.acceptedBundles).toHaveLength(0);
        expect(b.crdt.current(0)).toHaveLength(0);
    });

    it("the REAL rule gate (soulbound ERC-5192 5chan Pass, balance 0) drops a gossiped bundle: not forwarded, sender NOT penalized", async () => {
        const { a, b } = await connectedPair();
        // B runs the real pipeline (EIP-712 recover → constraints → erc5192-min-balance gate); the
        // stubbed chain says the wallet holds no Pass, so step 3 fails with the gate reason.
        const gated = await realVerifier(0n);
        const verdicts: BundleVerdict[] = [];
        b.setVerifier(async (bundle) => {
            const verdict = await gated.verify(bundle);
            verdicts.push(verdict);
            return verdict;
        });

        const bytes = encodeBundle(await passSignedBundle(10));
        const cid = await bundleCidForBytes(bytes);
        await a.transport.publishBundle(bytes);

        await waitFor(() => verdicts.length > 0, 15_000, "B to verify the gate-failing bundle");
        // The rule's own wording, carried through the real pipeline rather than a generic reason.
        expect(verdicts[0]).toMatchObject({
            valid: false,
            disposition: "ignore",
            reason: expect.stringContaining("holds none of the gate token")
        });
        await delay(500); // let the gate's verdict reach gossipsub before the negative assertions

        expect(b.acceptedBundles).toHaveLength(0); // never delivered ⇒ never forwarded
        expect(b.crdt.current(0)).toHaveLength(0); // and never merged
        // `ignore`, not `reject`: the v1 gate scores at the verifier's head and declines to blame
        // a `0n` on anyone (rules/types.ts, RuleResult.penalize), and A's head may legitimately be
        // ahead of B's — a wallet that acquired the Pass moments ago reads 0n here and >0n there.
        // So the sender keeps its score and the verdict stays uncached, leaving the bundle
        // re-evaluable once B's own view catches up.
        expect(b.pubsub.getScore(a.peerId)).toBeGreaterThanOrEqual(0);
        expect(b.cache.has(cid)).toBe(false);

        // Positive control through the SAME real pipeline, in the clean direction (B→A): with the
        // Pass held, a fresh bundle (different block ⇒ different CID, no cached verdict) verifies
        // and merges — proving the drop above was the rule gate, not the signature or constraints.
        const admitted = await realVerifier(1n);
        a.setVerifier((bundle) => admitted.verify(bundle));
        await b.transport.publishBundle(encodeBundle(await passSignedBundle(11)));
        await waitFor(() => a.crdt.current(0).length === 1, 15_000, "A to merge the Pass-holder's bundle");
        // The binary bundle codec round-trips the address lowercased (EIP-55 casing is display-only).
        expect(a.crdt.current(0)[0]?.address).toBe(wallet.address.toLowerCase());
    });

    it("an `any` refusal blames nobody when ONE alternative is unprovable: dropped, sender unpenalized, uncached", async () => {
        // The fold's most consequential claim, on real gossipsub scoring rather than in a unit
        // test: `erc721-min-balance` alone would earn the sender a `reject` (its `0n` is pinned to
        // the ballot's block, so every honest verifier computes it). Inside an `any` whose other
        // alternative is the head-reading Pass rule, it must NOT — a peer with a fresher view may
        // be looking at a wallet this gate admits, and penalizing it would punish honest relaying.
        const { a, b } = await connectedPair();
        const criteria = compositeCriteria({ any: [{ rule: bizGateRef() }, { rule: MOD_RULE }] });
        const gated = await compositeVerifier(criteria, { pass: 0n, mod: 0n });
        const verdicts: BundleVerdict[] = [];
        b.setVerifier(async (bundle) => {
            const verdict = await gated.verify(bundle);
            verdicts.push(verdict);
            return verdict;
        });

        const bytes = encodeBundle(await signedFor(criteria, 10));
        const cid = await bundleCidForBytes(bytes);
        await a.transport.publishBundle(bytes);

        await waitFor(() => verdicts.length > 0, 15_000, "B to verify the composite-gate bundle");
        expect(verdicts[0]).toMatchObject({ valid: false, disposition: "ignore" });
        // Both alternatives are named: each is a road this wallet could have taken and did not.
        expect((verdicts[0] as { failures?: { type: string }[] }).failures?.map((f) => f.type)).toEqual([
            "erc5192-min-balance",
            "erc721-min-balance"
        ]);
        await delay(500); // let the verdict reach gossipsub before the negative assertions

        expect(b.acceptedBundles).toHaveLength(0); // never delivered ⇒ never forwarded
        expect(b.crdt.current(0)).toHaveLength(0);
        expect(b.pubsub.getScore(a.peerId)).toBeGreaterThanOrEqual(0); // NOT reject-scored
        expect(b.cache.has(cid)).toBe(false); // uncached ⇒ re-evaluable once a view catches up

        // Positive control through the same tree: the wallet qualifies the OTHER way (no Pass, but
        // it holds the moderator token), so the `any` admits and the vote merges.
        const admitted = await compositeVerifier(criteria, { pass: 0n, mod: 1n });
        a.setVerifier((bundle) => admitted.verify(bundle));
        await b.transport.publishBundle(encodeBundle(await signedFor(criteria, 11)));
        await waitFor(() => a.crdt.current(0).length === 1, 15_000, "A to merge the moderator's bundle");
    });

    it("an `all` closed by an attributable failure IS reject-scored, and names only the rule that closed it", async () => {
        // The other half of the asymmetry: one attributable failure is enough for an `all`, since
        // that rule alone shuts the gate identically everywhere. The Pass leaf passes here, so the
        // blame set must name the moderator rule and nothing else — a wallet is never told to go
        // and acquire something it already has.
        const { a, b } = await connectedPair();
        const criteria = compositeCriteria({ all: [{ rule: bizGateRef() }, { rule: MOD_RULE }] });
        const gated = await compositeVerifier(criteria, { pass: 1n, mod: 0n });
        const verdicts: BundleVerdict[] = [];
        b.setVerifier(async (bundle) => {
            const verdict = await gated.verify(bundle);
            verdicts.push(verdict);
            return verdict;
        });

        await a.transport.publishBundle(encodeBundle(await signedFor(criteria, 10)));

        await waitFor(() => verdicts.length > 0, 15_000, "B to verify the composite-gate bundle");
        expect(verdicts[0]).toMatchObject({ valid: false, disposition: "reject" });
        expect((verdicts[0] as { failures?: { type: string }[] }).failures?.map((f) => f.type)).toEqual(["erc721-min-balance"]);
        // ...and the reason is that rule's own sentence, naming ITS contract, not the Pass's.
        expect((verdicts[0] as { reason: string }).reason.toLowerCase()).toContain(MOD_CONTRACT);
        // A `reject` must move the sender's score negative on the receiver (P4) — the folded
        // disposition, not any single rule's, is what gossipsub acts on.
        await waitFor(() => b.pubsub.getScore(a.peerId) < 0, 15_000, "B to penalize A's peer score");
        expect(b.acceptedBundles).toHaveLength(0);
        expect(b.crdt.current(0)).toHaveLength(0);
    });

    it("a name mapped to a DIFFERENT key is dropped at the relay: not forwarded, uncached, absent from the served checkpoint", async () => {
        const { a, b } = await connectedPair();
        // B's fully verified view holds one valid (unnamed) board vote from another wallet, so
        // the fetch assertion below distinguishes "bad board excluded" from "nothing served".
        await b.admitBundle(sampleBundle(ADDR, KEY_A));
        // B runs the real pipeline with the Pass held and a live registry, so ONLY the name stage
        // (step 4) can fail: the registry maps "memes.bso" to KEY_B, not the claimed KEY_A.
        const gated = await realVerifier(1n, [bsoResolver(KEY_B)]);
        const verdicts: BundleVerdict[] = [];
        b.setVerifier(async (bundle) => {
            const verdict = await gated.verify(bundle);
            verdicts.push(verdict);
            return verdict;
        });

        // A byzantine publish: genuinely signed, but claiming a name the wallet does not own. An
        // honest node cannot emit this — its own preflight refuses before signing (client/
        // voter.test.ts) — so the relay-side refusal needs the raw bundle pushed onto the wire.
        const bytes = encodeBundle(await passSignedBundle(10, "memes.bso"));
        const cid = await bundleCidForBytes(bytes);
        await a.transport.publishBundle(bytes);

        await waitFor(() => verdicts.length > 0, 15_000, "B to verify the name-mismatch bundle");
        expect(verdicts[0]).toMatchObject({
            valid: false,
            disposition: "ignore",
            reason: expect.stringContaining(`resolves to ${KEY_B}`)
        });
        await delay(500); // let the gate's verdict reach gossipsub before the negative assertions

        expect(b.acceptedBundles).toHaveLength(0); // never delivered ⇒ never forwarded
        expect(b.crdt.current(0)).toHaveLength(1); // only the pre-admitted valid board — never merged
        // `ignore`, not `reject`: names resolve at head, so today's mismatch may be a re-point in
        // flight — the sender is not penalized and the verdict stays uncached (re-evaluable).
        expect(b.pubsub.getScore(a.peerId)).toBeGreaterThanOrEqual(0);
        expect(b.cache.has(cid)).toBe(false);

        // The cold-start pull against the node that ignored the bundle: fetch B's root record
        // over the real libp2p fetch protocol, then chase it through the chunk-index fast-path
        // (`FetchRootRecord.chunks`, session seeded with B). What B serves is its fully verified
        // winner-set: the valid board arrives, the invalid-name board is NOT in it.
        const record = await a.fetchRootRecord(b);
        if (record === undefined) throw new Error("B served no root record over the fetch protocol");
        expect(record.count).toBe(1);
        a.chaser.chase(record.root, record.chunks, [b.libp2p.peerId]);
        await waitFor(() => a.crdt.current(0).length === 1, 15_000, "A to pull B's checkpoint over bitswap");
        const pulled = a.crdt.current(0);
        expect(pulled[0]?.address).toBe(ADDR); // the valid board's wallet
        expect(pulled.some((winner) => winner.address === wallet.address.toLowerCase())).toBe(false);
        expect(pulled.some((winner) => winner.votes.some((v) => v.community.name === "memes.bso"))).toBe(false);
        // ...and the blocks came through a bitswap session seeded with B, the fetched-from peer.
        expect(a.openedSessions).toEqual([{ root: record.root.toString(), providers: [b.peerId] }]);

        // Positive control through the SAME pipeline, in the clean direction (B→A): with the
        // registry mapping the name to the claimed key, a fresh bundle (different block ⇒
        // different CID) verifies and merges — proving the drop above was the name stage, not
        // the signature, constraints, or gate.
        const admitted = await realVerifier(1n, [bsoResolver(KEY_A)]);
        a.setVerifier((bundle) => admitted.verify(bundle));
        await b.transport.publishBundle(encodeBundle(await passSignedBundle(11, "memes.bso")));
        await waitFor(() => a.crdt.current(0).length === 2, 15_000, "A to merge the correctly-named bundle");
        const named = a.crdt.current(0).find((winner) => winner.address === wallet.address.toLowerCase());
        expect(named?.votes[0]?.community.name).toBe("memes.bso");
    });

    it("accepts a valid inline bundle: forwarded and LWW-merged on the peer", async () => {
        const { a, b } = await connectedPair();

        await a.transport.publishBundle(encodeBundle(sampleBundle(ADDR, KEY_A)));

        await waitFor(() => b.crdt.current(0).length === 1, 15_000, "B to merge the valid bundle");
        expect(b.acceptedBundles).toHaveLength(1); // delivered post-validation ⇒ forwarded
        expect(b.crdt.current(0)[0]?.address).toBe(ADDR);
        expect(b.pubsub.getScore(a.peerId)).toBeGreaterThanOrEqual(0); // a valid delivery is no penalty
    });

    it("a verify past the deadline yields ignore: no penalty, uncached, and re-evaluable later", async () => {
        const { a, b } = await connectedPair({ timeoutMs: 300 });

        // A verify that does not settle before the 300ms deadline. Held open so the gate must
        // fall back to the deadline path; released in cleanup so nothing dangles.
        let started = 0;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        b.setVerifier(async () => {
            started++;
            await held;
            return reject();
        });

        const bytes = encodeBundle(sampleBundle(ADDR, KEY_A));
        const cid = await bundleCidForBytes(bytes);
        await a.transport.publishBundle(bytes);

        // Confirm B actually received it and began verifying, then let the deadline elapse.
        await waitFor(() => started > 0, 15_000, "B to start verifying the delivered bundle");
        await delay(700); // > the 300ms deadline: the gate has settled to `ignore`

        expect(b.crdt.current(0)).toHaveLength(0); // deadline ⇒ not merged
        expect(b.cache.has(cid)).toBe(false); // transient ⇒ not cached (must be re-evaluable)
        expect(b.pubsub.getScore(a.peerId)).toBeGreaterThanOrEqual(0); // ignore ⇒ no penalty

        // Re-evaluable: with a fast verifier, the SAME bundle re-published now merges — proving the
        // deadline did not poison the verdict cache.
        b.setVerifier(async () => accept());
        await waitFor(
            async () => {
                await a.transport.publishBundle(bytes);
                return b.crdt.current(0).length === 1;
            },
            15_000,
            "the re-published bundle to merge once verification is fast"
        );

        release();
    });

    it("a converged pair stays quiet: a matching root triggers no chase", async () => {
        const { a, b } = await connectedPair();
        const bundle = sampleBundle(ADDR, KEY_A);
        // Both hold the same single winner ⇒ identical checkpoint root.
        await a.admitBundle(bundle);
        await b.admitBundle(bundle);

        await a.publishOwnRoot();

        await waitFor(() => b.heardMatchingRoot(), 15_000, "B to hear A's matching root record");
        expect(b.chaser.inFlight()).toBe(0); // a matching root is not chased — the topic stays quiet
        expect(b.openedSessions).toHaveLength(0); // and no chase means no session either
    });

    it("a divergent root triggers a chase through a bitswap session seeded with the advertiser", async () => {
        const { a, b } = await connectedPair();
        // A holds a winner; B is empty ⇒ their checkpoint roots differ.
        await a.admitBundle(sampleBundle(ADDR, KEY_A));

        // Advertise A's root (its checkpoint blocks are now in A's blockstore). B hears the divergent
        // root and chases it: decode the checkpoint, pull the blocks over a real bitswap session
        // seeded with A (the advertiser), verify each bundle, and merge — converging to A's
        // winner-set. The session recorder is the positive control that the pull went through the
        // seeded path — convergence alone cannot tell it from the broadcast fallback.
        await a.publishOwnRoot();

        await waitFor(() => b.crdt.current(0).length === 1, 20_000, "B to chase A's root over bitswap and converge");
        expect(b.crdt.current(0)[0]?.address).toBe(ADDR);
        const ownRoot = (await a.checkpointRootRecord()).root.toString();
        expect(b.openedSessions).toEqual([{ root: ownRoot, providers: [a.peerId] }]);
    });
});
