import { describe, it, expect, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { encodeBundle, bundleCidForBytes } from "../../crdt/codec.js";
import type { BundleVerdict, BundleVerifier } from "../../verify/types.js";
import { makeBundleVerifier } from "../../verify/bundle.js";
import { builtinRegistry } from "../../rules/registry.js";
import { makeBucketMath } from "../../chain/bucket.js";
import { ballotTypedData, EIP712_SIGNATURE_TYPE } from "../../signer/eip712.js";
import { criteriaCid } from "../../topic.js";
import { bizCriteria } from "../../test-fixtures.js";
import type { ChainClient } from "../../chain/types.js";
import type { Vote, VotesBundle } from "../../schema/votes.js";
import { makeVoteNode, connectNodes, waitFor, delay, sampleBundle, type VoteNode, type VoteNodeOptions } from "./harness.js";

/**
 * Two real libp2p + Helia nodes running `@libp2p/gossipsub` (>= 15.0.23, the CVE-2026-46679
 * floor). These pin what the pure unit tests (`gossip-validator.test.ts`, `chase.test.ts`)
 * cannot: real gossipsub forwarding, real peer scoring on a `reject`, a rejection produced by
 * the REAL verify pipeline (EIP-712 recover → constraints → the erc721-min-balance "5chan Pass"
 * gate, only the chain read stubbed), the real validation deadline, heartbeat-suppression quiet,
 * and a real directed-bitswap chase across a live connection. Slow by design — gated out of
 * `npm test`, run via `npm run test:integration`.
 *
 * KNOWN GAP: the directed-bitswap chase here is driven from a **heartbeat** root record (no chunk
 * index), so it exercises the manifest-fetch **fallback** path. The cold-start **piggyback
 * fast-path** (a fetch-protocol `FetchRootRecord.chunks` verified against the root, skipping the
 * root-manifest round-trip — see DESIGN.md "Block pull") is covered only by the codec/chaser unit
 * tests (`checkpoint/codec.test.ts`, `chase.test.ts`) and the WAN benchmark, NOT here. Pinning it
 * over real gossipsub+bitswap needs the harness to drive a cold-start fetch pull (deferred).
 */

const TOPIC = "bitsocial-votes/integration-test";
const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const ADDR = "0x1111111111111111111111111111111111111111";

const reject = (): BundleVerdict => ({ valid: false, disposition: "reject", reason: "test reject" });
const accept = (): BundleVerdict => ({ valid: true, ruleScore: 1n, resolvedNames: {} });

// --- Real-verifier fixtures (the ERC-721 "5chan Pass" gate over bizCriteria) ---------------------

// The gating chain's chainId, as bizCriteria() pins it (requires.chains.base.chainId).
const BIZ_CHAIN_ID = 8453;
// The anvil/hardhat test account #1 — signs real EIP-712 ballots reproducibly (as in verify/bundle.test.ts).
const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

/** A genuinely-signed one-vote bundle for `bizCriteria()`: only steps ≥ 2 of the pipeline can fail it. */
async function passSignedBundle(blockNumber: number): Promise<VotesBundle> {
    const votes: Vote[] = [{ community: { publicKey: KEY_A }, vote: 1 }];
    const cid = await criteriaCid(bizCriteria());
    const typedData = ballotTypedData({ criteriaCid: cid.bytes, chainId: BIZ_CHAIN_ID, votes, blockNumber });
    const signature = await wallet.signTypedData(typedData);
    return { address: wallet.address, votes, blockNumber, signature: { signature, type: EIP712_SIGNATURE_TYPE } };
}

/** The REAL verify pipeline over bizCriteria; only the chain read is stubbed to a fixed Pass balance. */
async function realVerifier(passBalance: bigint): Promise<BundleVerifier> {
    const criteria = bizCriteria();
    return makeBundleVerifier({
        criteria,
        criteriaCid: (await criteriaCid(criteria)).bytes,
        chainId: BIZ_CHAIN_ID,
        registry: builtinRegistry,
        chainFor: () => ({ readContract: async () => passBalance }) as unknown as ChainClient,
        bucketMath: makeBucketMath(criteria.blocksPerBucket),
        nameResolvers: []
    });
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

    it("the REAL rule gate (ERC-721 5chan Pass, balance 0) rejects a gossiped bundle: not forwarded, sender penalized", async () => {
        const { a, b } = await connectedPair();
        // B runs the real pipeline (EIP-712 recover → constraints → erc721-min-balance gate); the
        // stubbed chain says the wallet holds no Pass, so step 3 rejects with the gate reason.
        const gated = await realVerifier(0n);
        b.setVerifier((bundle) => gated.verify(bundle));

        await a.transport.publishBundle(encodeBundle(await passSignedBundle(10)));

        await waitFor(() => b.pubsub.getScore(a.peerId) < 0, 15_000, "B to penalize A for the gate-rejected bundle");
        expect(b.acceptedBundles).toHaveLength(0); // never delivered ⇒ never forwarded
        expect(b.crdt.current(0)).toHaveLength(0); // and never merged

        // Positive control through the SAME real pipeline, in the clean direction (B→A, so the
        // penalty above cannot interfere): with the Pass held, a fresh bundle (different block ⇒
        // different CID, no cached verdict) verifies and merges — proving the rejection above was
        // the rule gate, not the signature or constraints.
        const admitted = await realVerifier(1n);
        a.setVerifier((bundle) => admitted.verify(bundle));
        await b.transport.publishBundle(encodeBundle(await passSignedBundle(11)));
        await waitFor(() => a.crdt.current(0).length === 1, 15_000, "A to merge the Pass-holder's bundle");
        // The binary bundle codec round-trips the address lowercased (EIP-55 casing is display-only).
        expect(a.crdt.current(0)[0]?.address).toBe(wallet.address.toLowerCase());
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
    });

    it("a divergent root triggers a directed-bitswap chase that converges the pair", async () => {
        const { a, b } = await connectedPair();
        // A holds a winner; B is empty ⇒ their checkpoint roots differ.
        await a.admitBundle(sampleBundle(ADDR, KEY_A));

        // Advertise A's root (its checkpoint blocks are now in A's blockstore). B hears the divergent
        // root and chases it: decode the checkpoint, pull the blocks over directed bitswap from A,
        // verify each bundle, and merge — converging to A's winner-set.
        await a.publishOwnRoot();

        await waitFor(() => b.crdt.current(0).length === 1, 20_000, "B to chase A's root over bitswap and converge");
        expect(b.crdt.current(0)[0]?.address).toBe(ADDR);
    });
});
