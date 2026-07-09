import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { ChainClient, ChainClientFactory } from "../dist/chain/types.js";
import type { VoteSigner } from "../dist/signer/types.js";
import { ballotTypedData, EIP712_SIGNATURE_TYPE } from "../dist/signer/eip712.js";
import { VotesBundleSchema, type VotesBundle } from "../dist/schema/votes.js";
import { makeBucketMath } from "../dist/chain/bucket.js";
import { criteriaCid } from "../dist/topic.js";
import { CriteriaSchema, type Criteria } from "../dist/schema/criteria.js";

/**
 * Real signing + fake-chain fixtures for the cold-join latency benchmark.
 *
 * Why real EIP-712 signatures (not the unit tests' `fakeSigner` placeholder): a cold peer
 * re-verifies EVERY bundle it pulls (signer recovery in `verify/signature.ts` + the rule gate).
 * A placeholder signature would be rejected and the cold node's tally would stay empty, so the
 * benchmark would measure nothing. Each seeded winner is therefore signed by a distinct real viem
 * account. The rule gate (`erc721-min-balance`) passes against an instant fake chain whose
 * `readContract` returns `>= min`, and votes carry only a `publicKey` (no `name`), so no name
 * resolver is needed — chain work is ~0ms, isolating real peer-to-peer latency.
 */

/** A single valid base58btc IPNS community key — every seeded vote is for this one community. */
export const BENCH_COMMUNITY_KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

/** The gating chain head the fake chain reports (bizCriteria: blocksPerBucket 43200 ⇒ bucket 1). */
const BENCH_HEAD_BLOCK = 43_200n;

/** The /biz/ criteria document the benchmark runs (kept in sync with the shared test fixture). */
export function benchCriteria(): Criteria {
    return {
        name: "/biz/ - Business & Finance",
        contestId: "biz",
        voteSchema: { min: 1, max: 1 },
        maxVotesPerAddress: 1,
        blocksPerBucket: 43200,
        voteExpiryBuckets: 30,
        rule: { type: "erc721-min-balance", chain: "base", contract: "0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9", min: 1 },
        weight: { type: "constant", value: 1 },
        requires: {
            rules: ["erc721-min-balance", "constant"],
            chains: { base: { chainId: 8453, rpcUrls: ["https://mainnet.base.org"] } }
        }
    };
}

/**
 * The synthetic contestId for slot `i` in the directory-load benchmark (`c0`, `c1`, …). Kept as a
 * pure function so the seeder and the cold joiner derive the SAME criteria CID (hence the same
 * pubsub topic) for slot `i` without exchanging anything but `M`.
 */
export function benchContestId(i: number): string {
    return `c${i}`;
}

/**
 * The `m` synthetic criteria documents for the directory-load benchmark — a 5chan-style cold load
 * where one shared seeder provides many contest topics at once. Every slot shares the `/biz/`
 * gate/weight/expiry and differs only in `contestId` (`c0`…`c{m-1}`) and `name`, which makes each
 * one a DISTINCT canonical document → distinct CID → distinct topic. This mirrors the real 5chan
 * directory's shape (one topic per contest, shared seeder) without pinning the real 5chan CIDs.
 */
export function benchDirectoryCriteria(m: number): Criteria[] {
    if (!Number.isInteger(m) || m < 1) throw new Error(`bad contest count M: ${m}`);
    return Array.from({ length: m }, (_, i) =>
        CriteriaSchema.parse({ ...benchCriteria(), contestId: benchContestId(i), name: `bench contest ${benchContestId(i)}` })
    );
}

/**
 * A chain factory that answers instantly with no network: `getBlockNumber` fixes the head (so the
 * current bucket is stable), `getBlock` supplies the tie-break block hash, and `readContract`
 * returns `min` so the `erc721-min-balance` gate passes for every wallet. This makes chain reads
 * ~0ms so the benchmark measures p2p latency, not RPC round-trips.
 */
export function benchChains(): ChainClientFactory {
    const client = {
        getBlockNumber: async () => BENCH_HEAD_BLOCK,
        getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
        readContract: async () => 1n
    };
    return () => client as unknown as ChainClient;
}

/** Wrap a viem private key as a `VoteSigner` (real EIP-712 signing). */
export function makeViemSigner(privateKey: `0x${string}`): VoteSigner {
    const account = privateKeyToAccount(privateKey);
    return {
        address: () => account.address,
        signBallot: async (typedData) => ({
            signature: await account.signTypedData({
                domain: typedData.domain,
                types: typedData.types,
                primaryType: typedData.primaryType,
                message: typedData.message
            }),
            type: EIP712_SIGNATURE_TYPE
        })
    };
}

/**
 * Everything a bundle-signing pass needs, resolved once for a whole seed run: the criteria CID the
 * ballot binds, the gating chainId, and the bucket-boundary blockNumber every verifier reads at.
 */
export interface SigningContext {
    criteriaCidBytes: Uint8Array;
    chainId: number;
    blockNumber: number;
}

/** Resolve the signing context for `criteria` at the fake chain's fixed head. */
export async function makeSigningContext(criteria: Criteria): Promise<SigningContext> {
    const cid = await criteriaCid(criteria);
    const bucketMath = makeBucketMath(criteria.blocksPerBucket);
    const bucket = bucketMath.bucketForBlock(Number(BENCH_HEAD_BLOCK));
    // The benchmark criteria gates on a single chain; its chainId is bound into every ballot.
    const chain = Object.values(criteria.requires.chains)[0];
    if (!chain) throw new Error("bench criteria has no gating chain");
    return {
        criteriaCidBytes: cid.bytes,
        chainId: chain.chainId,
        blockNumber: bucketMath.sampleBlockForBucket(bucket)
    };
}

/**
 * Sign one voter's ballot from a fresh random wallet voting for {@link BENCH_COMMUNITY_KEY}. Each
 * call is a distinct address, so `count` voters produce `count` distinct LWW winners (one community,
 * total weight `count`). Returns the schema-validated bundle ready to `encodeBundle`.
 */
export async function signRandomVoter(ctx: SigningContext): Promise<VotesBundle> {
    const signer = makeViemSigner(generatePrivateKey());
    const votes = [{ community: { publicKey: BENCH_COMMUNITY_KEY }, vote: 1 }];
    const typedData = ballotTypedData({
        criteriaCid: ctx.criteriaCidBytes,
        chainId: ctx.chainId,
        votes,
        blockNumber: ctx.blockNumber
    });
    const signature = await signer.signBallot(typedData);
    const address = await signer.address();
    return VotesBundleSchema.parse({ address, votes, blockNumber: ctx.blockNumber, signature });
}
