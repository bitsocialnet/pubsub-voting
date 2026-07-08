import { describe, it, expect } from "vitest";
import type { CID } from "multiformats/cid";
import { makeRootChaser, type RootChaserDeps } from "./chase.js";
import { encodeCheckpoint } from "../checkpoint/codec.js";
import { bundleCid } from "../crdt/codec.js";
import { makeVerdictCache } from "../verify/cache.js";
import type { BundleVerifier } from "../verify/types.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

const padAddress = (tag: string) => `0x${tag.replace(/^0x/, "").padStart(40, "0")}`;

function bundle(address: string, blockNumber = 1): VotesBundle {
    return {
        address: padAddress(address),
        votes: [{ community: { publicKey: KEY_A }, vote: 1 }],
        blockNumber,
        signature: { signature: `0x${"11".repeat(65)}`, type: "eip712" }
    };
}

const okVerifier: BundleVerifier = { verify: async () => ({ valid: true, ruleScore: 1n, resolvedNames: {} }) };
const badVerifier: BundleVerifier = { verify: async () => ({ valid: false, disposition: "reject", reason: "invalid" }) };

/** Encode `winners` into checkpoint blocks and return the root, chunk index, and a block-map getBlock. */
async function checkpointOf(winners: VotesBundle[]) {
    const { root, chunks, blocks } = await encodeCheckpoint(winners);
    const map = new Map(blocks.map((b) => [b.cid.toString(), b.bytes]));
    const fetched: string[] = [];
    const getBlock: RootChaserDeps["getBlock"] = async (cid) => {
        fetched.push(cid.toString());
        return map.get(cid.toString());
    };
    return { root, chunks, getBlock, fetched };
}

/**
 * A chaser whose `limit` captures each chase's completion promise, so a test can await the
 * fire-and-forget run deterministically.
 */
function harness(over: Partial<RootChaserDeps> & Pick<RootChaserDeps, "getBlock">) {
    const admitted: CID[] = [];
    const runs: Promise<unknown>[] = [];
    let mergedCalls = 0;
    const chaser = makeRootChaser({
        verifier: okVerifier,
        cache: makeVerdictCache(),
        hasBundle: async () => false,
        admit: async ({ cid }) => {
            admitted.push(cid);
        },
        onMerged: () => {
            mergedCalls++;
        },
        limit: (fn) => {
            const run = fn();
            runs.push(run);
            return run;
        },
        timeoutMs: 1000,
        ...over
    });
    const settle = async () => {
        // A run may queue further work; settle every captured promise (they never reject upward).
        await Promise.allSettled(runs);
    };
    return { chaser, admitted, settle, merged: () => mergedCalls };
}

describe("makeRootChaser", () => {
    it("pulls a root's blocks, verifies every inlined bundle, and admits the survivors", async () => {
        const winners = [bundle("0x1"), bundle("0x2")];
        const { root, getBlock } = await checkpointOf(winners);
        const h = harness({ getBlock });
        h.chaser.chase(root);
        await h.settle();
        expect(h.admitted).toHaveLength(2);
        expect(h.merged()).toBe(1);
        expect(h.chaser.inFlight()).toBe(0);
    });

    it("skips the root-manifest fetch when handed a verified chunk index (piggyback fast-path)", async () => {
        const winners = [bundle("0x1"), bundle("0x2")];
        const { root, chunks, getBlock, fetched } = await checkpointOf(winners);
        const h = harness({ getBlock });
        // Cold-start hands the chase the chunk index from the fetch response; verified against
        // `root`, it pulls the chunks directly and never fetches the root-manifest block.
        h.chaser.chase(root, chunks);
        await h.settle();
        expect(h.admitted).toHaveLength(2);
        expect(fetched).not.toContain(root.toString());
        expect(fetched).toEqual(chunks.map((c) => c.toString()));
    });

    it("falls back to the manifest fetch when the piggybacked chunk index is wrong", async () => {
        const winners = [bundle("0x1"), bundle("0x2")];
        const { root, getBlock, fetched } = await checkpointOf(winners);
        const bogus = await encodeCheckpoint([bundle("0x9")]); // chunks that do not re-derive to `root`
        const h = harness({ getBlock });
        h.chaser.chase(root, bogus.chunks);
        await h.settle();
        // The lie fails the local check, so the chase fetches the real manifest and still converges.
        expect(h.admitted).toHaveLength(2);
        expect(fetched).toContain(root.toString());
    });

    it("skips bundles we already hold without re-verifying", async () => {
        const winners = [bundle("0x1")];
        const { root, getBlock } = await checkpointOf(winners);
        let verifies = 0;
        const h = harness({
            getBlock,
            hasBundle: async () => true,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            }
        });
        h.chaser.chase(root);
        await h.settle();
        expect(h.admitted).toHaveLength(0);
        expect(verifies).toBe(0);
        expect(h.merged()).toBe(0);
    });

    it("drops a liar's invalid bundle but keeps the honest one (per-bundle trust)", async () => {
        const good = bundle("0x1");
        const forged = bundle("0xbad");
        const { root, getBlock } = await checkpointOf([good, forged]);
        const goodCid = await bundleCid(good);
        const h = harness({
            getBlock,
            verifier: {
                verify: async (b) =>
                    b.address === forged.address
                        ? { valid: false, disposition: "reject", reason: "forged" }
                        : { valid: true, ruleScore: 1n, resolvedNames: {} }
            }
        });
        h.chaser.chase(root);
        await h.settle();
        expect(h.admitted).toHaveLength(1);
        expect(h.admitted[0].equals(goodCid)).toBe(true);
    });

    it("skips a cached-reject bundle without re-verifying, and admits a cached-valid one", async () => {
        const rejected = bundle("0x1");
        const known = bundle("0x2");
        const { root, getBlock } = await checkpointOf([rejected, known]);
        const cache = makeVerdictCache();
        cache.set(await bundleCid(rejected), { valid: false, disposition: "reject", reason: "known bad" });
        cache.set(await bundleCid(known), { valid: true, ruleScore: 1n, resolvedNames: {} });
        let verifies = 0;
        const h = harness({
            getBlock,
            cache,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            }
        });
        h.chaser.chase(root);
        await h.settle();
        expect(verifies).toBe(0);
        expect(h.admitted).toHaveLength(1);
        expect(h.admitted[0].equals(await bundleCid(known))).toBe(true);
    });

    it("skips a not-yet-evaluable bundle (future-head guard) without verifying", async () => {
        const winners = [bundle("0x1")];
        const { root, getBlock } = await checkpointOf(winners);
        let verifies = 0;
        const h = harness({
            getBlock,
            isEvaluableNow: async () => false,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            }
        });
        h.chaser.chase(root);
        await h.settle();
        expect(verifies).toBe(0);
        expect(h.admitted).toHaveLength(0);
    });

    it("yields nothing (and does not throw) when the root's blocks are unavailable", async () => {
        const { root } = await checkpointOf([bundle("0x1")]);
        const h = harness({ getBlock: async () => undefined });
        h.chaser.chase(root);
        await h.settle();
        expect(h.admitted).toHaveLength(0);
        expect(h.chaser.inFlight()).toBe(0);
    });

    it("frees the chase slot at the deadline even when a block pull hangs", async () => {
        const { root } = await checkpointOf([bundle("0x1")]);
        const h = harness({
            // Never settles on its own and ignores the abort signal — the worst case.
            getBlock: () => new Promise<Uint8Array | undefined>(() => {}),
            timeoutMs: 30
        });
        const start = Date.now();
        h.chaser.chase(root);
        await h.settle();
        expect(Date.now() - start).toBeLessThan(1000); // resolved at the deadline, not hung
        expect(h.admitted).toHaveLength(0);
        expect(h.chaser.inFlight()).toBe(0);
    });

    it("dedups an in-flight root: a spray of the same hint queues one chase", async () => {
        const { root, getBlock } = await checkpointOf([bundle("0x1")]);
        let limited = 0;
        const runs: Promise<unknown>[] = [];
        const h = harness({
            getBlock,
            limit: (fn) => {
                limited++;
                const run = fn();
                runs.push(run);
                return run;
            }
        });
        h.chaser.chase(root);
        h.chaser.chase(root);
        h.chaser.chase(root);
        await Promise.allSettled(runs);
        await h.settle();
        expect(limited).toBe(1);
        expect(h.admitted).toHaveLength(1); // chased once, admitted once
    });
});
