import { describe, it, expect } from "vitest";
import { makeTally, type TallyDeps } from "./tally.js";
import { builtinRegistry } from "../rules/registry.js";
import { makeBucketMath } from "../chain/bucket.js";
import { bizCriteria } from "../test-fixtures.js";
import type { ChainClient } from "../chain/types.js";
import type { BundleChecks } from "../verify/types.js";
import type { Vote, VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

/** A fully settled entry: gate confirmed, name (when carried) registry-resolved. */
function entry(address: string, votes: Vote[], checks?: Partial<BundleChecks>) {
    const carriesName = votes.some((v) => v.community.name !== undefined);
    return {
        bundle: { address, votes, blockNumber: 43200, signature: { signature: "0xsig", type: "eip712" } } as VotesBundle,
        checks: {
            chainVerified: true,
            ...(carriesName ? { nameResolved: true } : {}),
            ...checks
        } as BundleChecks
    };
}

/** A viem client whose reads are counted; constant weight must never touch it. */
function countingChain(onRead: () => void): ChainClient {
    return {
        async readContract() {
            onRead();
            return 0n;
        }
    } as unknown as ChainClient;
}

function makeDeps(
    entries: ReturnType<typeof entry>[],
    spies: { onRead?: () => void; onBlockHash?: () => void } = {}
): TallyDeps {
    return {
        criteria: bizCriteria(),
        registry: builtinRegistry,
        chainFor: () => countingChain(spies.onRead ?? (() => {})),
        bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
        current: () => entries,
        bucketBlockHash: async () => {
            spies.onBlockHash?.();
            return new Uint8Array([1, 2, 3, 4]);
        }
    };
}

describe("makeTally", () => {
    it("sums constant weight and folds different names with the same key into one row", async () => {
        const entries = [
            entry("0xaaa", [{ community: { name: "memes.bso", publicKey: KEY_A }, vote: 1 }]),
            entry("0xbbb", [{ community: { name: "funny.bso", publicKey: KEY_A }, vote: 1 }])
        ];
        const tally = await makeTally(makeDeps(entries)).compute();

        expect(tally.contestId).toBe("biz");
        expect(tally.ranking).toHaveLength(1);
        expect(tally.ranking[0].community.publicKey).toBe(KEY_A);
        expect(tally.ranking[0].weight).toBe(2n);
    });

    it("ranks communities by weight, highest first", async () => {
        const entries = [
            entry("0xaaa", [{ community: { publicKey: KEY_A }, vote: 1 }]),
            entry("0xbbb", [{ community: { publicKey: KEY_A }, vote: 1 }]),
            entry("0xccc", [{ community: { publicKey: KEY_B }, vote: 1 }])
        ];
        const tally = await makeTally(makeDeps(entries)).compute();

        expect(tally.ranking.map((r) => [r.community.publicKey, r.weight])).toEqual([
            [KEY_A, 2n],
            [KEY_B, 1n]
        ]);
    });

    it("marks a row chainVerified only when EVERY contributing bundle's gate read confirmed", async () => {
        const entries = [
            entry("0xaaa", [{ community: { publicKey: KEY_A }, vote: 1 }]),
            entry("0xbbb", [{ community: { publicKey: KEY_A }, vote: 1 }], { chainVerified: false }),
            entry("0xccc", [{ community: { publicKey: KEY_B }, vote: 1 }])
        ];
        const tally = await makeTally(makeDeps(entries)).compute();

        const rowA = tally.ranking.find((r) => r.community.publicKey === KEY_A)!;
        const rowB = tally.ranking.find((r) => r.community.publicKey === KEY_B)!;
        // The pending contribution still counts (weight 2) but withholds the row's flag.
        expect(rowA.weight).toBe(2n);
        expect(rowA.chainVerified).toBe(false);
        expect(rowB.chainVerified).toBe(true);
    });

    it("reports nameResolved per row, preferring a resolved name over a pending one", async () => {
        const entries = [
            // Pending name for KEY_A, resolved name for KEY_A from another voter, no name for KEY_B.
            entry("0xaaa", [{ community: { name: "memes.bso", publicKey: KEY_A }, vote: 1 }], { nameResolved: false }),
            entry("0xbbb", [{ community: { name: "funny.bso", publicKey: KEY_A }, vote: 1 }]),
            entry("0xccc", [{ community: { publicKey: KEY_B }, vote: 1 }])
        ];
        const tally = await makeTally(makeDeps(entries)).compute();

        const rowA = tally.ranking.find((r) => r.community.publicKey === KEY_A)!;
        const rowB = tally.ranking.find((r) => r.community.publicKey === KEY_B)!;
        // The resolved name wins the row's display slot and flags it resolved.
        expect(rowA.community.name).toBe("funny.bso");
        expect(rowA.nameResolved).toBe(true);
        // A row with no carried name has no nameResolved field at all (nothing to resolve).
        expect(rowB.community.name).toBeUndefined();
        expect("nameResolved" in rowB).toBe(false);
    });

    it("flags a row's name unresolved while its only carried name is still pending", async () => {
        const entries = [entry("0xaaa", [{ community: { name: "memes.bso", publicKey: KEY_A }, vote: 1 }], { nameResolved: false })];
        const tally = await makeTally(makeDeps(entries)).compute();
        expect(tally.ranking[0].community.name).toBe("memes.bso");
        expect(tally.ranking[0].nameResolved).toBe(false);
    });

    it("does zero chain reads for constant weight, and reads no block hash absent a tie", async () => {
        let reads = 0;
        let blockHashReads = 0;
        const entries = [
            entry("0xaaa", [{ community: { publicKey: KEY_A }, vote: 1 }]),
            entry("0xbbb", [{ community: { publicKey: KEY_A }, vote: 1 }]),
            entry("0xccc", [{ community: { publicKey: KEY_B }, vote: 1 }])
        ];
        await makeTally(makeDeps(entries, { onRead: () => reads++, onBlockHash: () => blockHashReads++ })).compute();

        expect(reads).toBe(0);
        expect(blockHashReads).toBe(0);
    });

    it("skips withdrawal (empty-votes) bundles", async () => {
        const entries = [
            entry("0xaaa", [{ community: { publicKey: KEY_A }, vote: 1 }]),
            entry("0xbbb", []) // withdrawal — contributes nothing
        ];
        const tally = await makeTally(makeDeps(entries)).compute();
        expect(tally.ranking).toHaveLength(1);
        expect(tally.ranking[0].weight).toBe(1n);
    });

    it("breaks a weight tie via the rolling block-hash seed, deterministically", async () => {
        let blockHashReads = 0;
        const entries = [
            entry("0xaaa", [{ community: { publicKey: KEY_A }, vote: 1 }]),
            entry("0xbbb", [{ community: { publicKey: KEY_B }, vote: 1 }])
        ];
        const deps = makeDeps(entries, { onBlockHash: () => blockHashReads++ });

        const first = await makeTally(deps).compute();
        const second = await makeTally(deps).compute();

        // Both communities tie at weight 1, so the block hash is read to break it.
        expect(blockHashReads).toBeGreaterThan(0);
        expect(first.ranking.map((r) => r.community.publicKey)).toEqual(second.ranking.map((r) => r.community.publicKey));
        expect(new Set(first.ranking.map((r) => r.community.publicKey))).toEqual(new Set([KEY_A, KEY_B]));
    });
});
