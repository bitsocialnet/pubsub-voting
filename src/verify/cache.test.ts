import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { makeVerdictCache, makeCachingVerifier } from "./cache.js";
import type { BundleVerifier } from "./types.js";
import type { VotesBundle } from "../schema/votes.js";

async function cidOf(seed: string): Promise<CID> {
    const digest = await sha256.digest(new TextEncoder().encode(seed));
    return CID.createV1(raw.code, digest);
}

const dummyBundle: VotesBundle = {
    address: "0x0000000000000000000000000000000000000001",
    votes: [],
    blockNumber: 0,
    signature: { signature: "0x", type: "eip712" }
};

/** A verifier that counts how many times it actually runs the pipeline. */
function countingVerifier(): { verifier: BundleVerifier; calls: () => number } {
    let calls = 0;
    return {
        verifier: {
            verify: async () => {
                calls++;
                return { valid: true, ruleScore: 1n, resolvedNames: {} };
            }
        },
        calls: () => calls
    };
}

describe("verdict cache", () => {
    it("verifies a repeated CID only once", async () => {
        const { verifier, calls } = countingVerifier();
        const caching = makeCachingVerifier(verifier, makeVerdictCache());
        const cid = await cidOf("bundle-a");

        await caching.verify(cid, dummyBundle);
        await caching.verify(cid, dummyBundle);
        await caching.verify(cid, dummyBundle);

        expect(calls()).toBe(1);
    });

    it("verifies distinct CIDs independently", async () => {
        const { verifier, calls } = countingVerifier();
        const caching = makeCachingVerifier(verifier, makeVerdictCache());

        await caching.verify(await cidOf("bundle-a"), dummyBundle);
        await caching.verify(await cidOf("bundle-b"), dummyBundle);

        expect(calls()).toBe(2);
    });

    it("caches a provable reject too (a known-bad CID is not re-checked)", async () => {
        let calls = 0;
        const verifier: BundleVerifier = {
            verify: async () => {
                calls++;
                return { valid: false, disposition: "reject", reason: "nope" };
            }
        };
        const caching = makeCachingVerifier(verifier, makeVerdictCache());
        const cid = await cidOf("bad");

        const first = await caching.verify(cid, dummyBundle);
        const second = await caching.verify(cid, dummyBundle);

        expect(first.valid).toBe(false);
        expect(second.valid).toBe(false);
        expect(calls).toBe(1);
    });

    it("evicts oldest entries past the cap (FIFO), bounding memory under a fresh-CID flood", async () => {
        const cache = makeVerdictCache(2); // tiny cap for the test
        const a = await cidOf("a");
        const b = await cidOf("b");
        const c = await cidOf("c");
        const reject = { valid: false as const, disposition: "reject" as const, reason: "x" };

        cache.set(a, reject);
        cache.set(b, reject);
        cache.set(c, reject); // over the cap of 2 -> evicts `a` (oldest)

        expect(cache.has(a)).toBe(false);
        expect(cache.has(b)).toBe(true);
        expect(cache.has(c)).toBe(true);
    });

    it("does NOT cache a transient ignore verdict (it is re-checked as heads/records converge)", async () => {
        let calls = 0;
        const verifier: BundleVerifier = {
            verify: async () => {
                calls++;
                return { valid: false, disposition: "ignore", reason: "name at head" };
            }
        };
        const caching = makeCachingVerifier(verifier, makeVerdictCache());
        const cid = await cidOf("transient");

        await caching.verify(cid, dummyBundle);
        await caching.verify(cid, dummyBundle);

        expect(calls).toBe(2); // re-evaluated each time — the verdict can change
    });
});
