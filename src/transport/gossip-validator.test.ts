import { describe, it, expect } from "vitest";
import pLimit from "p-limit";
import type { CID } from "multiformats/cid";
import { makeGossipGate, type GossipGateDeps } from "./gossip-validator.js";
import { encodeWinnerCids, decodeWinnerCids } from "./winner-cids.js";
import { makeVerdictCache } from "../verify/cache.js";
import { makeAcceptedDedup } from "./accepted-dedup.js";
import { makeBucketMath } from "../chain/bucket.js";
import { bundleCid } from "../crdt/codec.js";
import type { BundleVerifier } from "../verify/types.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

function bundle(address: string, blockNumber = 1, sig = "0x"): VotesBundle {
    return { address, votes: [{ community: { publicKey: KEY_A }, vote: 1 }], blockNumber, signature: { signature: sig, type: "eip712" } };
}

async function makeNode(address: string, blockNumber = 1, sig = "0x"): Promise<{ cid: CID; node: VotesBundle }> {
    const node = bundle(address, blockNumber, sig);
    return { cid: await bundleCid(node), node };
}

const okVerifier: BundleVerifier = { verify: async () => ({ valid: true, ruleScore: 1n, resolvedNames: {} }) };
const badVerifier: BundleVerifier = { verify: async () => ({ valid: false, disposition: "reject", reason: "invalid" }) };
/** A verifier whose failure is transient (view-/clock-dependent), e.g. a name resolved at head. */
const ignoreVerifier: BundleVerifier = { verify: async () => ({ valid: false, disposition: "ignore", reason: "name at head" }) };

const DEFAULT_BOUNDS = { maxWinnerCidsPerMessage: 16, maxMessageBytes: 1 << 20 };

function gate(over: Partial<GossipGateDeps> & { fetchNode: GossipGateDeps["fetchNode"] }) {
    return makeGossipGate({
        decodeWinnerCids,
        verifier: okVerifier,
        cache: makeVerdictCache(),
        merge: async () => {},
        limit: (fn) => fn(),
        allowPeer: () => true,
        bounds: DEFAULT_BOUNDS,
        timeoutMs: 5000,
        fetchTimeoutMs: 5000,
        ...over
    });
}

const fetcher =
    (nodes: Map<string, VotesBundle>) =>
    async (cid: CID): Promise<VotesBundle | undefined> =>
        nodes.get(cid.toString());

describe("makeGossipGate", () => {
    it("accepts a valid single-CID message and merges it", async () => {
        const { cid, node } = await makeNode("0x1");
        let merged: CID[] | undefined;
        const accepted: Array<[CID[], string]> = [];
        const g = gate({
            fetchNode: fetcher(new Map([[cid.toString(), node]])),
            merge: async (h) => {
                merged = h;
            },
            onAccept: (h, from) => accepted.push([h, from])
        });

        expect(await g.validate(encodeWinnerCids([cid]), "peer1")).toBe("accept");
        expect(merged?.[0].equals(cid)).toBe(true);
        expect(accepted[0][1]).toBe("peer1");
    });

    it("rejects malformed bytes (layer-1)", async () => {
        const g = gate({ fetchNode: async () => undefined });
        expect(await g.validate(new Uint8Array([0xff, 0xff]), "p")).toBe("reject");
    });

    it("rejects an oversized message", async () => {
        const { cid, node } = await makeNode("0x1");
        const g = gate({ fetchNode: fetcher(new Map([[cid.toString(), node]])), bounds: { ...DEFAULT_BOUNDS, maxMessageBytes: 5 } });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
    });

    it("rejects too many CIDs", async () => {
        const { cid, node } = await makeNode("0x1");
        const g = gate({ fetchNode: fetcher(new Map([[cid.toString(), node]])), bounds: { ...DEFAULT_BOUNDS, maxWinnerCidsPerMessage: 0 } });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
    });

    it("ignores a peer over its rate limit (no penalty)", async () => {
        const { cid, node } = await makeNode("0x1");
        const g = gate({ fetchNode: fetcher(new Map([[cid.toString(), node]])), allowPeer: () => false });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
    });

    it("ignores an empty CID announcement", async () => {
        const g = gate({ fetchNode: async () => undefined });
        expect(await g.validate(encodeWinnerCids([]), "p")).toBe("ignore");
    });

    it("ignores an unfetchable CID (not the sender's provable fault)", async () => {
        const { cid } = await makeNode("0x1");
        const g = gate({ fetchNode: async () => undefined }); // never resolves to a node
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
    });

    it("rejects a bundle that fails verification", async () => {
        const { cid, node } = await makeNode("0xbad");
        const g = gate({ fetchNode: fetcher(new Map([[cid.toString(), node]])), verifier: badVerifier });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
    });

    it("short-circuits to accept on a verdict-cache hit without fetching", async () => {
        const { cid } = await makeNode("0x1");
        const cache = makeVerdictCache();
        cache.set(cid, { valid: true, ruleScore: 1n, resolvedNames: {} });
        let fetches = 0;
        const g = gate({
            fetchNode: async () => {
                fetches++;
                return undefined;
            },
            cache
        });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("accept");
        expect(fetches).toBe(0);
    });

    it("rejects on a cached-invalid CID without fetching", async () => {
        const { cid } = await makeNode("0x1");
        const cache = makeVerdictCache();
        cache.set(cid, { valid: false, disposition: "reject", reason: "known bad" });
        let fetches = 0;
        const g = gate({
            fetchNode: async () => {
                fetches++;
                return undefined;
            },
            cache
        });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
        expect(fetches).toBe(0);
    });

    it("rejects when more CIDs than maxWinnerCidsPerMessage are announced", async () => {
        const a = await makeNode("0x1");
        const b = await makeNode("0x2");
        const nodes = new Map([
            [a.cid.toString(), a.node],
            [b.cid.toString(), b.node]
        ]);
        const g = gate({ fetchNode: fetcher(nodes), bounds: { ...DEFAULT_BOUNDS, maxWinnerCidsPerMessage: 1 } });
        expect(await g.validate(encodeWinnerCids([a.cid, b.cid]), "p")).toBe("reject");
    });

    it("wraps every fetch through the concurrency limiter", async () => {
        const a = await makeNode("0x1");
        const b = await makeNode("0x2");
        const nodes = new Map([
            [a.cid.toString(), a.node],
            [b.cid.toString(), b.node]
        ]);
        let limited = 0;
        const g = gate({
            fetchNode: fetcher(nodes),
            limit: (fn) => {
                limited++;
                return fn();
            }
        });
        expect(await g.validate(encodeWinnerCids([a.cid, b.cid]), "p")).toBe("accept");
        expect(limited).toBe(2); // one per fetched bundle in the message
    });

    it("ignores (no penalty) a transient-invalid bundle and does NOT cache the verdict", async () => {
        const { cid, node } = await makeNode("0x1");
        const cache = makeVerdictCache();
        let verifies = 0;
        const g = gate({
            fetchNode: fetcher(new Map([[cid.toString(), node]])),
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: false, disposition: "ignore", reason: "name at head" };
                }
            },
            cache
        });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
        // A re-announce re-verifies (verdict not pinned) — the condition can resolve later.
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
        expect(verifies).toBe(2);
        expect(cache.has(cid)).toBe(false);
    });

    it("caches a provable reject so a re-announce is not re-verified", async () => {
        const { cid, node } = await makeNode("0xbad");
        const cache = makeVerdictCache();
        let verifies = 0;
        const g = gate({
            fetchNode: fetcher(new Map([[cid.toString(), node]])),
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: false, disposition: "reject", reason: "bad sig" };
                }
            },
            cache
        });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
        expect(verifies).toBe(1); // second announce short-circuits on the cached reject
        expect(cache.has(cid)).toBe(true);
    });

    it("ignores a bundle bucketed ahead of head (future-head guard) without verifying or caching", async () => {
        const { cid, node } = await makeNode("0x1");
        const cache = makeVerdictCache();
        let verifies = 0;
        const g = gate({
            fetchNode: fetcher(new Map([[cid.toString(), node]])),
            isEvaluableNow: async () => false, // its sample block is ahead of our head
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            },
            cache
        });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
        expect(verifies).toBe(0); // dropped before the (chain-touching) verifier runs
        expect(cache.has(cid)).toBe(false);
    });

    it("verifies normally once the bundle is evaluable (future-head guard passes)", async () => {
        const { cid, node } = await makeNode("0x1");
        const g = gate({
            fetchNode: fetcher(new Map([[cid.toString(), node]])),
            isEvaluableNow: async () => true
        });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("accept");
    });

    it("ignores (does not hang) when a fetch exceeds the timeout", async () => {
        const { cid } = await makeNode("0x1");
        const g = gate({ fetchNode: () => new Promise<undefined>(() => {}), timeoutMs: 50 });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
    });

    it("aborts a hung fetch at fetchTimeoutMs and frees the p-limit slot for later fetches", async () => {
        const hung = await makeNode("0x1");
        const good = await makeNode("0x2");
        const goodNodes = new Map([[good.cid.toString(), good.node]]);
        let aborted = false;
        const limit = pLimit(1); // one slot: a leak here would starve the second fetch
        const g = gate({
            fetchNode: (cid, signal) => {
                if (cid.toString() === hung.cid.toString()) {
                    // Never settles on its own; the gate's per-fetch deadline must abort + free the slot.
                    return new Promise<VotesBundle | undefined>((resolve) => {
                        signal?.addEventListener("abort", () => {
                            aborted = true;
                            resolve(undefined);
                        });
                    });
                }
                return Promise.resolve(goodNodes.get(cid.toString()));
            },
            limit: (fn) => limit(fn),
            fetchTimeoutMs: 20,
            timeoutMs: 10_000 // message budget far exceeds the per-fetch deadline
        });

        const start = Date.now();
        expect(await g.validate(encodeWinnerCids([hung.cid]), "p")).toBe("ignore");
        expect(aborted).toBe(true); // the hung fetch was aborted, not left dangling
        expect(Date.now() - start).toBeLessThan(2000); // resolved at the per-fetch deadline, not the 10s message budget
        // The single slot was released, so a subsequent fetchable CID still validates.
        expect(await g.validate(encodeWinnerCids([good.cid]), "p")).toBe("accept");
    });

    // blocksPerBucket large enough that blockNumbers 1 and 2 share bucket 0 — a same-bucket re-sign.
    const bucketMath = () => makeBucketMath(1000);

    it("ignores a lone same-bucket, same-choice re-sign without a second verify (no re-flood)", async () => {
        const first = await makeNode("0x1", 1, "0xaa");
        const resign = await makeNode("0x1", 2, "0xbb"); // same wallet+votes+bucket, fresh CID
        expect(first.cid.equals(resign.cid)).toBe(false);
        const acceptedDedup = makeAcceptedDedup(bucketMath());
        let verifies = 0;
        const g = gate({
            fetchNode: fetcher(
                new Map([
                    [first.cid.toString(), first.node],
                    [resign.cid.toString(), resign.node]
                ])
            ),
            acceptedDedup,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            }
        });
        expect(await g.validate(encodeWinnerCids([first.cid]), "p")).toBe("accept"); // records the vote
        expect(await g.validate(encodeWinnerCids([resign.cid]), "p")).toBe("ignore"); // re-sign dropped
        expect(verifies).toBe(1); // the re-sign never reached the (chain-touching) verifier
    });

    it("still accepts a message carrying a genuinely-new vote alongside a re-sign duplicate", async () => {
        const first = await makeNode("0x1", 1, "0xaa");
        const resign = await makeNode("0x1", 2, "0xbb"); // dup of first
        const fresh = await makeNode("0x2", 1, "0xcc"); // a different wallet's genuinely-new vote
        const acceptedDedup = makeAcceptedDedup(bucketMath());
        let merged: CID[] | undefined;
        const g = gate({
            fetchNode: fetcher(
                new Map([
                    [first.cid.toString(), first.node],
                    [resign.cid.toString(), resign.node],
                    [fresh.cid.toString(), fresh.node]
                ])
            ),
            acceptedDedup,
            merge: async (h) => {
                merged = h;
            }
        });
        expect(await g.validate(encodeWinnerCids([first.cid]), "p")).toBe("accept");
        expect(await g.validate(encodeWinnerCids([resign.cid, fresh.cid]), "p")).toBe("accept");
        // Only the genuinely-new CID is merged/forwarded; the re-sign duplicate is excluded.
        expect(merged?.length).toBe(1);
        expect(merged?.[0].equals(fresh.cid)).toBe(true);
    });

    it("cannot be poisoned: a matching-key bundle is dropped (ignore) even if it would 'verify'", async () => {
        const real = await makeNode("0x1", 1, "0xaa");
        // Attacker reuses the victim's (wallet, votes) at another same-bucket block with garbage —
        // a matching dedup key. It must never be accepted or merged, regardless of the verifier.
        const forged = await makeNode("0x1", 2, "0xdeadbeef");
        const acceptedDedup = makeAcceptedDedup(bucketMath());
        let mergedForged = false;
        let verifies = 0;
        const g = gate({
            fetchNode: fetcher(
                new Map([
                    [real.cid.toString(), real.node],
                    [forged.cid.toString(), forged.node]
                ])
            ),
            acceptedDedup,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} }; // would "pass" if ever run
                }
            },
            merge: async (h) => {
                if (h.some((c) => c.equals(forged.cid))) mergedForged = true;
            }
        });
        expect(await g.validate(encodeWinnerCids([real.cid]), "p")).toBe("accept");
        expect(await g.validate(encodeWinnerCids([forged.cid]), "p")).toBe("ignore");
        expect(verifies).toBe(1); // forged bundle never verified (short-circuited as redundant)
        expect(mergedForged).toBe(false); // and never merged/stored
    });
});
