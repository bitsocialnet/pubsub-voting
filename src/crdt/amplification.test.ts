import { describe, it, expect } from "vitest";
import { makeVoteCrdt } from "./crdt.js";
import { makeMemoryBundleStore } from "./store.js";
import { makeBucketMath } from "../chain/bucket.js";
import { erc721MinBalance } from "../rules/erc721-min-balance.js";
import { erc5192MinBalance } from "../rules/erc5192-min-balance.js";
import { erc20Balance } from "../rules/erc20-balance.js";
import type { ChainClient } from "../chain/types.js";
import type { Vote, VotesBundle } from "../schema/votes.js";

/**
 * **The amplification the two unregistered rules permit** — the test vector behind issues #27
 * and #28, and the reason `builtinRegistry` ships only `erc5192-min-balance` + `constant`.
 *
 * Three properties compose into it, each individually correct:
 *
 *   1. every bundle is verified at its OWN pinned `blockNumber` (a bucket boundary), because the
 *      heartbeat/expiry model re-proves each live vote at a recent block;
 *   2. a bundle stays live for `voteExpiryBuckets` measured from its own bucket (`isExpired`);
 *   3. the winner set is LWW-keyed per **wallet** (`winnersByWallet`).
 *
 * So one *transferable* gating asset walked through N wallets inside a single expiry window backs
 * N concurrent live votes: every gate read is true at its own pinned block, and LWW never
 * collapses them because the wallets differ. No forgery, no back-dating, no invalid ballot —
 * which is exactly why nothing in the verify pipeline can catch it. The ceiling is the number of
 * transfers inside one expiry window, not the number of assets.
 *
 * The fix is a property of the ASSET, asserted by the gate rule: `erc5192-min-balance` refuses a
 * contract that does not declare its tokens locked (#27). For a fungible balance that fix does
 * not exist — a balance cannot be soulbound and has no token id to key LWW by — so
 * `erc20-balance` stays unregistered until a hold-duration guard ships (#28); the last test here
 * pins that the guard's predicate is what closes it.
 *
 * These vectors describe behaviour that is CORRECT for the CRDT (it is trust-neutral storage,
 * and each bundle is valid). They exist so that registering a transferable gate breaks a test
 * that says why, rather than shipping quietly.
 */

// The live 5chan manifest's bounds: 1800 blocks/bucket × 720 buckets ≈ 30 days of expiry.
const BLOCKS_PER_BUCKET = 1800;
const VOTE_EXPIRY_BUCKETS = 720;
const bucketMath = makeBucketMath(BLOCKS_PER_BUCKET);
const sampleBlock = (bucket: number): number => bucketMath.sampleBlockForBucket(bucket);

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const WALLET_C = "0x3333333333333333333333333333333333333333";
const TARGET = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const CONTRACT = "0x00000000000000000000000000000000000000fa";

/** One upvote for the same community from `address`, stamped at `bucket`'s boundary block. */
function ballot(address: string, bucket: number): VotesBundle {
    const votes: Vote[] = [{ community: { publicKey: TARGET }, vote: 1 }];
    return { address, votes, blockNumber: sampleBlock(bucket), signature: { signature: `0x${"11".repeat(65)}`, type: "eip712" } };
}

/**
 * A chain where ONE asset moves: `holderAt(block)` names the single wallet holding it. Answers
 * `balanceOf` from that, and `supportsInterface` from `declaresErc5192` — a contract that permits
 * these transfers by construction does NOT declare its tokens locked, which is the whole point.
 */
function movingAssetChain(holderAt: (block: number) => string, options: { amount?: bigint; declaresErc5192?: boolean } = {}): ChainClient {
    return {
        readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: readonly unknown[]; blockNumber: bigint }) => {
            if (functionName === "supportsInterface") return options.declaresErc5192 ?? false;
            const wallet = String(args[0]).toLowerCase();
            return holderAt(Number(blockNumber)).toLowerCase() === wallet ? (options.amount ?? 1n) : 0n;
        }
    } as unknown as ChainClient;
}

/**
 * The transfer schedule: A holds everything up to and including bucket `FIRST`, B holds bucket
 * `FIRST + 1`, C from `FIRST + 2` on. `FIRST` sits well past one expiry window so a read a full
 * window before it is real history, not a clamp at block 0.
 */
const FIRST = 1000;
function holderAt(block: number): string {
    const bucket = bucketMath.bucketForBlock(block);
    if (bucket <= FIRST) return WALLET_A;
    if (bucket === FIRST + 1) return WALLET_B;
    return WALLET_C;
}

/** A CRDT with the live manifest's expiry window. */
function crdt() {
    return makeVoteCrdt({ store: makeMemoryBundleStore(), bucketMath, voteExpiryBuckets: VOTE_EXPIRY_BUCKETS });
}

describe("Sybil amplification: one transferable asset, N concurrent votes (#27)", () => {
    const options = { type: "erc721-min-balance" as const, chain: "base", contract: CONTRACT, min: 1 };
    const chain = movingAssetChain(holderAt);
    const chain5192 = movingAssetChain(holderAt, { declaresErc5192: true });

    it("admits each holder in the transfer chain at its OWN pinned block (every ballot is valid)", async () => {
        for (const [bucket, wallet] of [
            [FIRST, WALLET_A],
            [FIRST + 1, WALLET_B],
            [FIRST + 2, WALLET_C]
        ] as const) {
            const { score } = await erc721MinBalance.evaluate({ options, walletAddress: wallet, ctx: { chain, blockNumber: sampleBlock(bucket) } });
            expect(score).toBe(1n); // the gate is satisfied — the wallet really did hold the token then
        }
        // ...and each is a stranger at the others' blocks, so nothing about the sequence looks odd.
        const { score } = await erc721MinBalance.evaluate({ options, walletAddress: WALLET_A, ctx: { chain, blockNumber: sampleBlock(FIRST + 2) } });
        expect(score).toBe(0n);
    });

    it("THE HAZARD: one token walked A → B → C inside one expiry window = three live winner-set entries", async () => {
        const c = crdt();
        await c.add(ballot(WALLET_A, FIRST));
        await c.add(ballot(WALLET_B, FIRST + 1));
        await c.add(ballot(WALLET_C, FIRST + 2));

        // Read the set at the last bucket where even the OLDEST of the three is still live.
        const live = c.current(FIRST + VOTE_EXPIRY_BUCKETS);
        expect(live).toHaveLength(3); // ONE token, THREE concurrent votes for the same community
        expect(new Set(live.map((b) => b.address))).toEqual(new Set([WALLET_A, WALLET_B, WALLET_C]));
        // Not back-dating: every ballot is stamped at the bucket that was current when it was cast.
        expect(live.map((b) => b.blockNumber).sort((x, y) => x - y)).toEqual([sampleBlock(FIRST), sampleBlock(FIRST + 1), sampleBlock(FIRST + 2)]);
    });

    it("the ex-holder's vote is what keeps it alive: it only decays on its own expiry clock", async () => {
        const c = crdt();
        await c.add(ballot(WALLET_A, FIRST));
        await c.add(ballot(WALLET_C, FIRST + 2));
        // A's vote survives long past the transfer — expiry counts from A's OWN bucket.
        expect(c.current(FIRST + VOTE_EXPIRY_BUCKETS)).toHaveLength(2);
        expect(c.current(FIRST + VOTE_EXPIRY_BUCKETS + 1).map((b) => b.address)).toEqual([WALLET_C]);
    });

    it("THE FIX: the v1 gate admits nobody on a contract that does not declare its tokens locked", async () => {
        const gate = { type: "erc5192-min-balance" as const, chain: "base", contract: CONTRACT, min: 1 };
        const scores = await Promise.all(
            [
                [FIRST, WALLET_A],
                [FIRST + 1, WALLET_B],
                [FIRST + 2, WALLET_C]
            ].map(([bucket, wallet]) =>
                erc5192MinBalance.evaluate({ options: gate, walletAddress: String(wallet), ctx: { chain, blockNumber: sampleBlock(Number(bucket)) } })
            )
        );
        expect(scores.map((s) => s.score)).toEqual([0n, 0n, 0n]);
        // The assertion is about the CONTRACT, not the wallet: declare the lock and the same
        // holders are admitted again (a locked contract cannot produce the transfers above).
        const { score } = await erc5192MinBalance.evaluate({ options: gate, walletAddress: WALLET_A, ctx: { chain: chain5192, blockNumber: sampleBlock(FIRST) } });
        expect(score).toBe(1n);
    });
});

describe("Sybil amplification: one fungible balance, N concurrent votes (#28)", () => {
    // A gate on 100 tokens; the same 100 tokens walk A → B → C, one wallet per bucket.
    const options = { type: "erc20-balance" as const, chain: "base", contract: CONTRACT, decimals: 18, min: 100 };
    const chain = movingAssetChain(holderAt, { amount: 100n * 10n ** 18n });

    it("THE HAZARD: one balance walked through three wallets inside one expiry window = three live votes", async () => {
        const wallets = [
            [FIRST, WALLET_A],
            [FIRST + 1, WALLET_B],
            [FIRST + 2, WALLET_C]
        ] as const;
        for (const [bucket, wallet] of wallets) {
            const { score } = await erc20Balance.evaluate({ options, walletAddress: wallet, ctx: { chain, blockNumber: sampleBlock(bucket) } });
            expect(score).toBeGreaterThan(0n); // each read is true at its own pinned block
        }

        const c = crdt();
        for (const [bucket, wallet] of wallets) await c.add(ballot(wallet, bucket));
        expect(c.current(FIRST + VOTE_EXPIRY_BUCKETS)).toHaveLength(3);
    });

    it("neither ERC-5192 fix applies: a balance cannot be soulbound, and has no token id to key LWW by", async () => {
        // The NFT fix is an assertion on the CONTRACT — there is no equivalent for a fungible
        // balance, so nothing in `erc20-balance`'s option surface can express it. What closes it
        // is a HOLD-DURATION guard, evaluated here as the two reads it would make: `min` at the
        // pinned block AND at `pinned − voteExpiryBuckets × blocksPerBucket`. With hold window
        // H >= expiry window E, two live votes would require both wallets to have held the
        // balance at the earlier block simultaneously — i.e. actually owning 2×.
        const holdWindowBlocks = VOTE_EXPIRY_BUCKETS * BLOCKS_PER_BUCKET;
        const meetsGuard = async (wallet: string, bucket: number): Promise<boolean> => {
            const pinned = sampleBlock(bucket);
            const now = await erc20Balance.evaluate({ options, walletAddress: wallet, ctx: { chain, blockNumber: pinned } });
            const then = await erc20Balance.evaluate({ options, walletAddress: wallet, ctx: { chain, blockNumber: Math.max(0, pinned - holdWindowBlocks) } });
            return now.score > 0n && then.score > 0n;
        };
        // A held the balance for the whole window; B and C acquired it inside the window and fail
        // their own `pinned − H` read — which is what collapses three votes back to one.
        expect(await meetsGuard(WALLET_A, FIRST)).toBe(true);
        expect(await meetsGuard(WALLET_B, FIRST + 1)).toBe(false);
        expect(await meetsGuard(WALLET_C, FIRST + 2)).toBe(false);
    });
});
