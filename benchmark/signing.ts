import { createPublicClient, decodeFunctionData, http, multicall3Abi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { ChainClient, ChainClientFactory } from "../dist/chain/types.js";
import type { Rule, RuleRegistry } from "../dist/rules/types.js";
import { erc721MinBalance, type Erc721MinBalanceOptions } from "../dist/rules/erc721-min-balance.js";
import type { GatewayOp, GatewayRequest } from "./rpc-gateway.js";
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
 *
 * REAL-CHAIN MODE (`BENCH_RPC_URL=<real Base RPC>`): every fixture in this module consults
 * {@link benchRpcUrl} so the seeder and the joiner derive the SAME criteria (hence the same
 * topic) with no call-site changes. In this mode the joiner's gate reads go against the REAL
 * chain — real head, real bucket sample block (up to `blocksPerBucket` behind head, so the
 * endpoint must serve historical state at that depth), real multicall3 — instead of the mock
 * gateway. The bench wallets are freshly generated and hold nothing on any real chain, so the
 * joiner shadows `erc721-min-balance` with {@link benchRules}'s PROBE rule: it performs the
 * builtin's exact reads (same single `balanceOf`, same multicall3 `aggregate3`, same pinned
 * block) and only then admits the wallet unconditionally — the measured RPC cost is real, the
 * threshold alone is bench-local. The criteria pin a real deployed ERC-721
 * ({@link REAL_PROBE_CONTRACT}) so the reads execute real contract code. The seeder keeps its
 * instant fake chain (seeding is setup, not the join under test) but reports the REAL head, so
 * ballots are signed at the real bucket's sample block and verify identically on both sides.
 */

/** A single valid base58btc IPNS community key — every seeded vote is for this one community. */
export const BENCH_COMMUNITY_KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

/** The gating chain head the fake chain reports (bizCriteria: blocksPerBucket 43200 ⇒ bucket 1). */
const BENCH_HEAD_BLOCK = 43_200n;

/**
 * The real deployed ERC-721 the REAL-CHAIN mode reads: "Base Day One" on Base mainnet — a
 * high-holder-count commemorative NFT, so `balanceOf` executes real (proxied) contract code
 * against real state. It stands in for the 5chan Pass, which is not deployed yet (the mock-mode
 * criteria's `0x13d4…91b9` has no code on Base).
 */
export const REAL_PROBE_CONTRACT = "0x7d5861cfe1c74aaa0999b7e2651bf2ebd2a62d89";

/**
 * The single switch for REAL-CHAIN mode: the Base-mainnet JSON-RPC endpoint from
 * `BENCH_RPC_URL`, or `undefined` for the default mock-gateway mode. It must serve historical
 * state up to `blocksPerBucket` (43,200 blocks ≈ 24h) behind head — `https://mainnet.base.org`
 * does; publicnode's free tier does not.
 */
export function benchRpcUrl(): string | undefined {
    return process.env.BENCH_RPC_URL || undefined;
}

/** The real head, fetched once per process (seeder chunks and joiner milestones share one view). */
let realHeadPromise: Promise<bigint> | undefined;
export function fetchRealHead(rpcUrl: string): Promise<bigint> {
    realHeadPromise ??= createPublicClient({ chain: base, transport: http(rpcUrl) }).getBlockNumber();
    return realHeadPromise;
}

/**
 * The /biz/ criteria document the benchmark runs (kept in sync with the shared test fixture).
 * In REAL-CHAIN mode the gate contract and RPC URL are real ({@link REAL_PROBE_CONTRACT},
 * `BENCH_RPC_URL`); both sides derive it from the same env var, so the topics match.
 */
export function benchCriteria(): Criteria {
    const rpcUrl = benchRpcUrl();
    return {
        name: "/biz/ - Business & Finance",
        contestId: "biz",
        voteSchema: { min: 1, max: 1 },
        maxVotesPerAddress: 1,
        blocksPerBucket: 43200,
        voteExpiryBuckets: 30,
        rule: {
            type: "erc721-min-balance",
            chain: "base",
            contract: rpcUrl ? REAL_PROBE_CONTRACT : "0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9",
            min: 1
        },
        weight: { type: "constant", value: 1 },
        requires: {
            rules: ["erc721-min-balance", "constant"],
            chains: { base: { chainId: 8453, rpcUrls: [rpcUrl ?? "https://mainnet.base.org"] } }
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
 * returns `min` so the `erc721-min-balance` gate passes for every wallet.
 *
 * Used only where chain latency is SETUP, not the measurement: the seeder (its 1000 gate reads
 * while seeding are not the cold join under test). The measured COLD JOINER instead talks to the
 * mock ETH gateway through a real viem client — see {@link benchGatewayChains} — so its gate
 * reads cost realistic RPC round trips.
 *
 * In REAL-CHAIN mode the fake client reports the REAL head (fetched once), so the seeder signs
 * and verifies at the real bucket's sample block — the block the measured joiner will re-read
 * against the real chain.
 */
export function benchChains(): ChainClientFactory {
    const rpcUrl = benchRpcUrl();
    const client = {
        getBlockNumber: async (): Promise<bigint> => (rpcUrl ? fetchRealHead(rpcUrl) : BENCH_HEAD_BLOCK),
        getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
        readContract: async () => 1n
    };
    return () => client as unknown as ChainClient;
}

/**
 * REAL-CHAIN mode's registry override for the joiner (and, harmlessly, the seeder):
 * `undefined` in mock mode; in real mode a PROBE rule shadowing `erc721-min-balance` that
 * delegates every read to the builtin — byte-identical single `balanceOf` and multicall3
 * `aggregate3` calls at the same pinned block — then admits the wallet unconditionally
 * (bench wallets are freshly generated and hold 0 of any real token; the read cost is the
 * measurement, the threshold is not).
 */
export function benchRules(): RuleRegistry | undefined {
    if (!benchRpcUrl()) return undefined;
    const probe: Rule<Erc721MinBalanceOptions> = {
        type: erc721MinBalance.type,
        optionsSchema: erc721MinBalance.optionsSchema,
        async evaluate(args) {
            const { score } = await erc721MinBalance.evaluate(args);
            return { score: score > 0n ? score : 1n };
        },
        async evaluateMany(args) {
            const results = await erc721MinBalance.evaluateMany!(args);
            return results.map(({ score }) => ({ score: score > 0n ? score : 1n }));
        }
    };
    return { [probe.type]: probe as Rule };
}

/**
 * REAL-CHAIN mode's measured-joiner chain factory: a real default-config viem client (one POST
 * per read, `retryCount: 3`, no transport batching — same shape as {@link benchGatewayChains})
 * against the real endpoint, with a wrapping `fetchFn` that logs every JSON-RPC request into
 * `requests` in the mock gateway's `GatewayRequest` shape (method, inner multicall read count,
 * arrival time, measured duration) so the joiner's gate-RPC metrics work identically in both
 * modes.
 */
export function realJoinerChains(rpcUrl: string, requests: GatewayRequest[]): ChainClientFactory {
    const multicall3 = base.contracts.multicall3.address.toLowerCase();
    const classify = (rpc: { method?: string; params?: unknown[] }): { method: string; op: GatewayOp; reads: number } => {
        const method = rpc.method ?? "unknown";
        if (method === "eth_chainId") return { method, op: "chainId", reads: 0 };
        if (method === "eth_blockNumber") return { method, op: "head", reads: 0 };
        if (method === "eth_getBlockByNumber") return { method, op: "block", reads: 0 };
        if (method !== "eth_call") return { method, op: "other", reads: 0 };
        const call = rpc.params?.[0] as { to?: string; data?: `0x${string}` } | undefined;
        if (call?.to?.toLowerCase() === multicall3 && call.data) {
            try {
                const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: call.data });
                if (functionName === "aggregate3") {
                    return { method, op: "gate-multicall", reads: (args[0] as readonly unknown[]).length };
                }
            } catch {
                // not an aggregate3 payload — fall through and count it as one direct read
            }
        }
        return { method, op: "gate-direct", reads: 1 };
    };
    const fetchFn: typeof fetch = async (input, init) => {
        const atMs = performance.now();
        const response = await fetch(input, init);
        const durMs = performance.now() - atMs;
        const entries: GatewayRequest[] = [];
        try {
            const body: unknown = JSON.parse(String(init?.body));
            for (const rpc of Array.isArray(body) ? body : [body]) {
                entries.push({ ...classify(rpc as { method?: string; params?: unknown[] }), atMs, durMs, status: response.status });
            }
        } catch {
            entries.push({ method: "unknown", op: "other", reads: 0, atMs, durMs, status: response.status });
        }
        requests.push(...entries);
        // A 200 can still carry a JSON-RPC `error` body (rate limit, archive-depth refusal, revert)
        // that viem will retry or surface — capture it off a clone, asynchronously, so the measured
        // path is not delayed. Consumers read the log after the join settles, so the late fill lands.
        if (response.headers.get("content-type")?.includes("json")) {
            void response
                .clone()
                .json()
                .then((payload: unknown) => {
                    const errors = (Array.isArray(payload) ? payload : [payload]) as Array<{ error?: { code?: number; message?: string } }>;
                    for (let i = 0; i < entries.length; i++) {
                        const error = errors[i]?.error ?? (entries.length === 1 ? errors.find((e) => e?.error)?.error : undefined);
                        if (error) entries[i]!.rpcError = `${error.code ?? "?"}: ${error.message ?? "unknown"}`;
                    }
                })
                .catch(() => {});
        }
        return response;
    };
    const client = createPublicClient({ chain: base, transport: http(rpcUrl, { fetchFn }) });
    return () => client as unknown as ChainClient;
}

/**
 * The measured joiner's chain factory: a REAL `createPublicClient` with viem's default `http`
 * transport (one POST per read, `retryCount: 3`, no transport batching) pointed at the mock ETH
 * gateway (`benchmark/rpc-gateway.ts`). `chain: base` matches the bench criteria's chainId 8453
 * and — crucially — carries base's multicall3 deployment, so `erc721-min-balance.evaluateMany`
 * takes the one-aggregate3-per-batch path exactly as it would against the real chain.
 */
export function benchGatewayChains(gatewayUrl: string): ChainClientFactory {
    const client = createPublicClient({ chain: base, transport: http(gatewayUrl) });
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

/**
 * Resolve the signing context for `criteria` at the fake chain's fixed head — or, in
 * REAL-CHAIN mode, at the real chain's current head, so every ballot's `blockNumber` is the
 * real bucket's sample block (the block the joiner's real gate reads pin to).
 */
export async function makeSigningContext(criteria: Criteria): Promise<SigningContext> {
    const rpcUrl = benchRpcUrl();
    const head = rpcUrl ? await fetchRealHead(rpcUrl) : BENCH_HEAD_BLOCK;
    const cid = await criteriaCid(criteria);
    const bucketMath = makeBucketMath(criteria.blocksPerBucket);
    const bucket = bucketMath.bucketForBlock(Number(head));
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
