import { describe, it, expect } from "vitest";
import pLimit from "p-limit";
import type { CID } from "multiformats/cid";
import { makeGossipGate, type GossipGateDeps } from "./gossip-validator.js";
import {
    decodeVoteMessage,
    encodeBundleMessage,
    encodeRootMessage,
    MAX_ROOT_MESSAGE_BYTES,
    ROOT_RECORD_VERSION,
    type RootRecord
} from "./messages.js";
import { makeVerdictCache } from "../verify/cache.js";
import { makeAcceptedDedup } from "./accepted-dedup.js";
import { makeBucketMath } from "../chain/bucket.js";
import { encodeBundle, decodeBundle, bundleCid, bundleCidForBytes } from "../crdt/codec.js";
import type { BundleVerifier } from "../verify/types.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

// The binary codec requires well-formed field sizes (20-byte address, 65-byte signature), so
// short hex tags are padded here; validity is still the verifier's concern, not the codec's.
const padAddress = (tag: string) => `0x${tag.replace(/^0x/, "").padStart(40, "0")}`;
const padSig = (tag: string) => `0x${tag.replace(/^0x/, "").padEnd(130, "0")}`;

function bundle(address: string, blockNumber = 1, sig = "0x"): VotesBundle {
    return {
        address: padAddress(address),
        votes: [{ community: { publicKey: KEY_A }, vote: 1 }],
        blockNumber,
        signature: { signature: padSig(sig), type: "eip712" }
    };
}

/** An inline live-delta message for a bundle, plus its CID (the verdict-cache key). */
async function makeDelta(address: string, blockNumber = 1, sig = "0x"): Promise<{ cid: CID; node: VotesBundle; message: Uint8Array }> {
    const node = bundle(address, blockNumber, sig);
    return { cid: await bundleCid(node), node, message: encodeBundleMessage(encodeBundle(node)) };
}

async function makeRootRecord(): Promise<RootRecord> {
    return { version: ROOT_RECORD_VERSION, root: await bundleCid(bundle("0xcc")), count: 3, sizeBytes: 700 };
}

const okVerifier: BundleVerifier = { verify: async () => ({ valid: true, ruleScore: 1n, resolvedNames: {} }) };
const badVerifier: BundleVerifier = { verify: async () => ({ valid: false, disposition: "reject", reason: "invalid" }) };

function gate(over: Partial<GossipGateDeps> = {}) {
    return makeGossipGate({
        decodeMessage: decodeVoteMessage,
        parseBundle: async (blockBytes) => ({ cid: await bundleCidForBytes(blockBytes), bundle: decodeBundle(blockBytes) }),
        verifier: okVerifier,
        cache: makeVerdictCache(),
        admit: async () => {},
        limit: (fn) => fn(),
        allowBundlePeer: () => true,
        allowRootPeer: () => true,
        maxBundleMessageBytes: 4096,
        maxRootMessageBytes: MAX_ROOT_MESSAGE_BYTES,
        timeoutMs: 5000,
        ...over
    });
}

describe("makeGossipGate — bundle deltas", () => {
    it("accepts a valid inline bundle, admits its exact bytes, and notifies", async () => {
        const { cid, message } = await makeDelta("0x1");
        let admitted: { cid: CID; bytes: Uint8Array } | undefined;
        const accepted: Array<[CID, string]> = [];
        const g = gate({
            admit: async ({ cid: c, bytes }) => {
                admitted = { cid: c, bytes };
            },
            onAccept: (c, _bundle, from) => accepted.push([c, from])
        });

        expect(await g.validate(message, "peer1")).toBe("accept");
        expect(admitted?.cid.equals(cid)).toBe(true);
        // Byte-identity: the stored block is the sender's exact bytes, so its hash IS the CID.
        expect((await bundleCidForBytes(admitted!.bytes)).equals(cid)).toBe(true);
        expect(accepted[0][0].equals(cid)).toBe(true);
        expect(accepted[0][1]).toBe("peer1");
    });

    it("rejects malformed bytes (layer-1)", async () => {
        const g = gate();
        expect(await g.validate(new Uint8Array([0xff, 0xff]), "p")).toBe("reject");
    });

    it("rejects a bundle message over the derived cap", async () => {
        const { message } = await makeDelta("0x1");
        const g = gate({ maxBundleMessageBytes: 5 });
        expect(await g.validate(message, "p")).toBe("reject");
    });

    it("rejects an envelope whose bundle bytes are garbage", async () => {
        const g = gate();
        expect(await g.validate(encodeBundleMessage(new Uint8Array([1, 2, 3])), "p")).toBe("reject");
    });

    it("ignores a peer over its bundle rate limit (no penalty)", async () => {
        const { message } = await makeDelta("0x1");
        const g = gate({ allowBundlePeer: () => false });
        expect(await g.validate(message, "p")).toBe("ignore");
    });

    it("rejects a bundle that fails verification", async () => {
        const { message } = await makeDelta("0xbad");
        const g = gate({ verifier: badVerifier });
        expect(await g.validate(message, "p")).toBe("reject");
    });

    it("accepts a re-published known-valid bundle for one hash — no re-verify, no re-admit", async () => {
        const { cid, message } = await makeDelta("0x1");
        const cache = makeVerdictCache();
        cache.set(cid, { valid: true, ruleScore: 1n, resolvedNames: {} });
        let verifies = 0;
        let admits = 0;
        const g = gate({
            cache,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            },
            admit: async () => {
                admits++;
            }
        });
        // Forwarded (a client re-publish must reach late peers) but not re-worked.
        expect(await g.validate(message, "p")).toBe("accept");
        expect(verifies).toBe(0);
        expect(admits).toBe(0);
    });

    it("rejects a cached-invalid bundle without re-verifying", async () => {
        const { cid, message } = await makeDelta("0x1");
        const cache = makeVerdictCache();
        cache.set(cid, { valid: false, disposition: "reject", reason: "known bad" });
        let verifies = 0;
        const g = gate({
            cache,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            }
        });
        expect(await g.validate(message, "p")).toBe("reject");
        expect(verifies).toBe(0);
    });

    it("ignores (no penalty) a transient-invalid bundle and does NOT cache the verdict", async () => {
        const { cid, message } = await makeDelta("0x1");
        const cache = makeVerdictCache();
        let verifies = 0;
        const g = gate({
            cache,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: false, disposition: "ignore", reason: "name at head" };
                }
            }
        });
        expect(await g.validate(message, "p")).toBe("ignore");
        // A re-publish re-verifies (verdict not pinned) — the condition can resolve later.
        expect(await g.validate(message, "p")).toBe("ignore");
        expect(verifies).toBe(2);
        expect(cache.has(cid)).toBe(false);
    });

    it("ignores (no penalty, uncached) a verify that THROWS — an RPC failure is infra, not the sender's fault", async () => {
        const { cid, message } = await makeDelta("0x1");
        const cache = makeVerdictCache();
        let verifies = 0;
        const g = gate({
            cache,
            verifier: {
                verify: async () => {
                    verifies++;
                    throw new Error("RPC endpoint down"); // the gate chain read failed outright
                }
            }
        });
        expect(await g.validate(message, "p")).toBe("ignore");
        // Uncached and re-evaluable: once the RPC recovers, a re-publish verifies for real.
        expect(await g.validate(message, "p")).toBe("ignore");
        expect(verifies).toBe(2);
        expect(cache.has(cid)).toBe(false);
    });

    it("caches a provable reject so a re-publish is not re-verified", async () => {
        const { cid, message } = await makeDelta("0xbad");
        const cache = makeVerdictCache();
        let verifies = 0;
        const g = gate({
            cache,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: false, disposition: "reject", reason: "bad sig" };
                }
            }
        });
        expect(await g.validate(message, "p")).toBe("reject");
        expect(await g.validate(message, "p")).toBe("reject");
        expect(verifies).toBe(1); // second publish short-circuits on the cached reject
        expect(cache.has(cid)).toBe(true);
    });

    it("ignores a bundle bucketed ahead of head (future-head guard) without verifying or caching", async () => {
        const { cid, message } = await makeDelta("0x1");
        const cache = makeVerdictCache();
        let verifies = 0;
        const g = gate({
            cache,
            isEvaluableNow: async () => false, // its sample block is ahead of our head
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            }
        });
        expect(await g.validate(message, "p")).toBe("ignore");
        expect(verifies).toBe(0); // dropped before the (chain-touching) verifier runs
        expect(cache.has(cid)).toBe(false);
    });

    it("verifies normally once the bundle is evaluable (future-head guard passes)", async () => {
        const { message } = await makeDelta("0x1");
        const g = gate({ isEvaluableNow: async () => true });
        expect(await g.validate(message, "p")).toBe("accept");
    });

    it("wraps the verify through the concurrency limiter", async () => {
        const { message } = await makeDelta("0x1");
        let limited = 0;
        const limit = pLimit(1);
        const g = gate({
            limit: (fn) => {
                limited++;
                return limit(fn);
            }
        });
        expect(await g.validate(message, "p")).toBe("accept");
        expect(limited).toBe(1);
    });

    it("ignores (does not hang) when the verify exceeds the message deadline", async () => {
        const { message } = await makeDelta("0x1");
        const g = gate({
            verifier: { verify: () => new Promise(() => {}) }, // a hung RPC / name resolution
            timeoutMs: 50
        });
        expect(await g.validate(message, "p")).toBe("ignore");
    });

    // blocksPerBucket large enough that blockNumbers 1 and 2 share bucket 0 — a same-bucket re-sign.
    const bucketMath = () => makeBucketMath(1000);

    it("ignores a same-bucket, same-choice re-sign without a second verify (no re-flood)", async () => {
        const first = await makeDelta("0x1", 1, "0xaa");
        const resign = await makeDelta("0x1", 2, "0xbb"); // same wallet+votes+bucket, fresh bytes
        expect(first.cid.equals(resign.cid)).toBe(false);
        const acceptedDedup = makeAcceptedDedup(bucketMath());
        let verifies = 0;
        const g = gate({
            acceptedDedup,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            }
        });
        expect(await g.validate(first.message, "p")).toBe("accept"); // records the vote
        expect(await g.validate(resign.message, "p")).toBe("ignore"); // re-sign dropped, not forwarded
        expect(verifies).toBe(1); // the re-sign never reached the (chain-touching) verifier
    });

    it("cannot be poisoned: a matching-key bundle is dropped (ignore) even if it would 'verify'", async () => {
        const real = await makeDelta("0x1", 1, "0xaa");
        // Attacker reuses the victim's (wallet, votes) at another same-bucket block with garbage —
        // a matching dedup key. It must never be accepted or admitted, regardless of the verifier.
        const forged = await makeDelta("0x1", 2, "0xdeadbeef");
        const acceptedDedup = makeAcceptedDedup(bucketMath());
        let admittedForged = false;
        let verifies = 0;
        const g = gate({
            acceptedDedup,
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} }; // would "pass" if ever run
                }
            },
            admit: async ({ cid }) => {
                if (cid.equals(forged.cid)) admittedForged = true;
            }
        });
        expect(await g.validate(real.message, "p")).toBe("accept");
        expect(await g.validate(forged.message, "p")).toBe("ignore");
        expect(verifies).toBe(1); // forged bundle never verified (short-circuited as redundant)
        expect(admittedForged).toBe(false); // and never admitted/stored
    });
});

describe("makeGossipGate — root records", () => {
    it("accepts a well-formed root record and surfaces it as a hint", async () => {
        const record = await makeRootRecord();
        const heard: Array<[RootRecord, string]> = [];
        const g = gate({ onRootRecord: (r, from) => heard.push([r, from]) });
        expect(await g.validate(encodeRootMessage(record), "peer1")).toBe("accept");
        expect(heard).toHaveLength(1);
        expect(heard[0][0].root.equals(record.root)).toBe(true);
        expect(heard[0][1]).toBe("peer1");
    });

    it("never verifies or admits on a root record (it is only a hint)", async () => {
        const record = await makeRootRecord();
        let verifies = 0;
        let admits = 0;
        const g = gate({
            verifier: {
                verify: async () => {
                    verifies++;
                    return { valid: true, ruleScore: 1n, resolvedNames: {} };
                }
            },
            admit: async () => {
                admits++;
            }
        });
        expect(await g.validate(encodeRootMessage(record), "p")).toBe("accept");
        expect(verifies).toBe(0);
        expect(admits).toBe(0);
    });

    it("ignores a peer over its root rate limit (no penalty, hint not surfaced)", async () => {
        const record = await makeRootRecord();
        const heard: RootRecord[] = [];
        const g = gate({ allowRootPeer: () => false, onRootRecord: (r) => heard.push(r) });
        expect(await g.validate(encodeRootMessage(record), "p")).toBe("ignore");
        expect(heard).toHaveLength(0);
    });

    it("rejects a root message over the fixed root cap", async () => {
        const record = await makeRootRecord();
        const g = gate({ maxRootMessageBytes: 5, maxBundleMessageBytes: 4096 });
        expect(await g.validate(encodeRootMessage(record), "p")).toBe("reject");
    });
});
