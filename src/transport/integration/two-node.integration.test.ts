import { describe, it, expect, afterEach } from "vitest";
import { encodeBundle, bundleCidForBytes } from "../../crdt/codec.js";
import type { BundleVerdict } from "../../verify/types.js";
import { makeVoteNode, connectNodes, waitFor, delay, sampleBundle, type VoteNode, type VoteNodeOptions } from "./harness.js";

/**
 * Two real libp2p + Helia nodes running `@libp2p/gossipsub` (>= 15.0.23, the CVE-2026-46679
 * floor). These pin what the pure unit tests (`gossip-validator.test.ts`, `chase.test.ts`)
 * cannot: real gossipsub forwarding, real peer scoring on a `reject`, the real validation
 * deadline, heartbeat-suppression quiet, and a real directed-bitswap chase across a live
 * connection. Slow by design — gated out of `npm test`, run via `npm run test:integration`.
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
