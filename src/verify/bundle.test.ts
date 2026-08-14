import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { makeBundleVerifier } from "./bundle.js";
import { makeMemoryRuleCache, type RuleCache } from "../rules/cache.js";
import { ballotTypedData } from "../signer/eip712.js";
import { VotesBundleSchema, type Vote, type VotesBundle } from "../schema/votes.js";
import { builtinRegistry } from "../rules/registry.js";
import { erc721MinBalance } from "../rules/erc721-min-balance.js";
import { makeBucketMath } from "../chain/bucket.js";
import { bizCriteria, bizGateRef } from "../test-fixtures.js";
import type { ChainClient, NameResolver } from "../chain/types.js";

// The anvil/hardhat test account #1 (holds no funds) — signs test bundles reproducibly.
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PRIVATE_KEY);

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

function hexToBytes(hex: `0x${string}`): Uint8Array {
    const body = hex.slice(2);
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    return out;
}

const CRITERIA_CID = hexToBytes("0x0171122069ed193edc1ad0d931d7c6ceafeb8ba40ff1ca1a65cb0a6493e04c96483320c1");
const CHAIN_ID = 8453;
const BLOCK = 1000;

/** Build a validly-signed bundle for the given votes (so the verifier's step 1 passes). */
async function signedBundle(votes: Vote[]): Promise<VotesBundle> {
    const typedData = ballotTypedData({ criteriaCid: CRITERIA_CID, chainId: CHAIN_ID, votes, blockNumber: BLOCK });
    const signature = await account.signTypedData(typedData);
    return VotesBundleSchema.parse({ address: account.address, votes, blockNumber: BLOCK, signature: { signature, type: "eip712" } });
}

/**
 * A fake viem client for the gate's reads, counting every `readContract`. The v1 gate
 * (`erc5192-min-balance`) makes TWO per uncached wallet: the ERC-5192 declaration probe and
 * `balanceOf`, so the stub dispatches on `functionName`.
 */
function fakeChain(balance: bigint, onRead?: () => void, declares = true): ChainClient {
    return {
        async readContract({ functionName }: { functionName?: string } = {}) {
            onRead?.();
            return functionName === "supportsInterface" ? declares : balance;
        },
        // The v1 gate declares a LIVE evaluation view, so the verifier reads the head to know
        // which block to score at (rules/types.ts, ChainReadContext.head). Kept a few blocks past the
        // bundle's own `blockNumber`, as a real head is.
        async getBlockNumber() {
            return BigInt(BLOCK + 5);
        }
    } as unknown as ChainClient;
}

/** A resolver over a fixed name -> publicKey map, handling `.bso` names. */
function resolver(map: Record<string, string>): NameResolver {
    return {
        key: "test",
        provider: "test",
        canResolve: ({ name }) => name.endsWith(".bso"),
        resolve: async ({ name }) => (name in map ? { publicKey: map[name] } : undefined)
    };
}

function verifier(over: { balance?: bigint; onRead?: () => void; names?: Record<string, string>; ruleCaches?: readonly RuleCache[] } = {}) {
    return makeBundleVerifier({
        criteria: bizCriteria(),
        criteriaCid: CRITERIA_CID,
        chainId: CHAIN_ID,
        registry: builtinRegistry,
        chainFor: () => fakeChain(over.balance ?? 1n, over.onRead),
        bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
        nameResolvers: [resolver(over.names ?? {})],
        ruleCaches: over.ruleCaches
    });
}

describe("makeBundleVerifier", () => {
    it("accepts a validly-signed, eligible, unnamed vote", async () => {
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n }).verify(bundle);
        expect(verdict.valid).toBe(true);
        if (verdict.valid) expect(verdict.ruleScore).toBe(1n);
    });

    it("drops a wallet the gate does not admit (rule score 0n) as ignore, not reject", async () => {
        // The v1 gate scores at the verifier's head, and heads differ
        // between peers: a wallet that acquired the Pass three blocks ago is `0n` here and
        // `> 0n` for whoever forwarded the bundle. Penalizing that relayer would punish it for
        // being ahead, so an unprovable gate miss drops the bundle `ignore`-class and uncached.
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 0n }).verify(bundle);
        expect(verdict.valid).toBe(false);
        if (!verdict.valid) expect(verdict.disposition).toBe("ignore");
    });

    it("rejects a pinned rule's gate miss (an attributable 0n IS penalizable)", async () => {
        // The counterpart to the case above, and the reason the disposition comes from the rule's
        // own answer rather than being hardcoded: a score pinned to a historical block is
        // identical on every verifier forever, so its `0n` is a `reject` the sender earns.
        const criteria = { ...bizCriteria(), gate: { rule: { ...bizGateRef(), type: erc721MinBalance.type } } };
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        const verdict = await makeBundleVerifier({
            criteria,
            criteriaCid: CRITERIA_CID,
            chainId: CHAIN_ID,
            registry: { ...builtinRegistry, [erc721MinBalance.type]: erc721MinBalance },
            chainFor: () => fakeChain(0n),
            bucketMath: makeBucketMath(criteria.blocksPerBucket),
            nameResolvers: []
        }).verify(bundle);
        expect(verdict.valid).toBe(false);
        if (!verdict.valid) expect(verdict.disposition).toBe("reject");
    });

    it("scores the v1 gate at the verifier's head, not at the bundle's bucket block", async () => {
        // The point of reading the head: a wallet whose Pass is invisible at the bundle's bucket
        // boundary (a day old, at 5chan's bounds) but present at the head is admitted NOW. The
        // stub reads `blockNumber` back so the assertion is about which block was asked for.
        const blocks: number[] = [];
        const chain = {
            async readContract({ functionName, blockNumber }: { functionName?: string; blockNumber?: bigint } = {}) {
                blocks.push(Number(blockNumber));
                return functionName === "supportsInterface" ? true : 1n;
            },
            async getBlockNumber() {
                return BigInt(BLOCK + 5);
            }
        } as unknown as ChainClient;
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        const verdict = await makeBundleVerifier({
            criteria: bizCriteria(),
            criteriaCid: CRITERIA_CID,
            chainId: CHAIN_ID,
            registry: builtinRegistry,
            chainFor: () => chain,
            bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
            nameResolvers: []
        }).verify(bundle);
        expect(verdict.valid).toBe(true);
        expect(new Set(blocks)).toEqual(new Set([BLOCK + 5]));
        // ...and emphatically NOT the bundle's bucket sample block, which is 0 here.
        expect(blocks).not.toContain(0);
    });

    it("drops every wallet when the gate contract does not declare ERC-5192", async () => {
        // The gate would otherwise be a bare `balanceOf` on a transferable asset, which one holder
        // can walk through several wallets for several concurrent votes (issue #27, vector in
        // crdt/amplification.test.ts). A contract that does not claim its tokens are locked is a
        // chain fact — but this rule refuses to blame a `0n` on the sender either way
            // (`penalize: false`), so it drops `ignore`-class rather than penalizing.
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        const verdict = await makeBundleVerifier({
            criteria: bizCriteria(),
            criteriaCid: CRITERIA_CID,
            chainId: CHAIN_ID,
            registry: builtinRegistry,
            chainFor: () => fakeChain(1000n, undefined, false),
            bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
            nameResolvers: []
        }).verify(bundle);
        expect(verdict.valid).toBe(false);
        if (!verdict.valid) expect(verdict.disposition).toBe("ignore");
    });

    it("memoizes a gate miss through the rule's cache, so a second bundle skips the chain read", async () => {
        let reads = 0;
        const ruleCache = makeMemoryRuleCache();
        const v = verifier({ balance: 0n, onRead: () => reads++, ruleCaches: [ruleCache] });
        // Two DISTINCT bundles (different community) from the same wallet at the same block: the
        // first pays the reads, the second short-circuits entirely on the rule's memo.
        const first = await v.verify(await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]));
        const reveal = reads;
        const second = await v.verify(await signedBundle([{ community: { publicKey: KEY_B }, vote: 1 }]));
        expect(first.valid).toBe(false);
        expect(second.valid).toBe(false);
        // Four reads for the first bundle: the head leg (lock probe + balanceOf) refuses, then the
        // pinned fallback repeats both at the ballot's own block (erc5192-min-balance.ts).
        expect(reveal).toBe(4);
        expect(reads).toBe(reveal); // ...and the second bundle read nothing at all
    });

    it("memoizes a gate HIT so an eligible wallet's re-vote skips the read", async () => {
        let reads = 0;
        const ruleCache = makeMemoryRuleCache();
        const v = verifier({ balance: 1n, onRead: () => reads++, ruleCaches: [ruleCache] });
        // An eligible wallet cycling choices in the same bucket must not re-read the chain per
        // fresh bundle — the `> 0n` score is memoized just like the `0n` miss.
        const first = await v.verify(await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]));
        const second = await v.verify(await signedBundle([{ community: { publicKey: KEY_B }, vote: 1 }]));
        expect(first.valid).toBe(true);
        expect(second.valid).toBe(true);
        expect(reads).toBe(2); // the eligible score was read once (lock probe + balanceOf) and reused
    });

    it("rejects a bad signature BEFORE any chain read (cheap-first ordering)", async () => {
        let reads = 0;
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        // Corrupt the signature after signing; verifier must drop it at step 1.
        const forged: VotesBundle = { ...bundle, address: "0x0000000000000000000000000000000000000009" };
        const verdict = await verifier({ balance: 1n, onRead: () => reads++ }).verify(forged);
        expect(verdict.valid).toBe(false);
        expect(reads).toBe(0);
    });

    it("accepts a named vote whose name resolves to the claimed key", async () => {
        const bundle = await signedBundle([{ community: { name: "memes.bso", publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n, names: { "memes.bso": KEY_A } }).verify(bundle);
        expect(verdict.valid).toBe(true);
        if (verdict.valid) expect(verdict.resolvedNames).toEqual({ "memes.bso": KEY_A });
    });

    it("drops a squatted name that resolves to a different key (ignore, not reject — resolved at head)", async () => {
        // memes.bso genuinely belongs to KEY_A, but this bundle claims it for KEY_B.
        const bundle = await signedBundle([{ community: { name: "memes.bso", publicKey: KEY_B }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n, names: { "memes.bso": KEY_A } }).verify(bundle);
        expect(verdict.valid).toBe(false);
        if (!verdict.valid) expect(verdict.disposition).toBe("ignore");
    });

    it("drops a name that does not resolve (ignore, not reject)", async () => {
        const bundle = await signedBundle([{ community: { name: "ghost.bso", publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n, names: {} }).verify(bundle);
        expect(verdict.valid).toBe(false);
        if (!verdict.valid) expect(verdict.disposition).toBe("ignore");
    });

    it("accepts an empty withdrawal bundle from an eligible wallet", async () => {
        const bundle = await signedBundle([]);
        const verdict = await verifier({ balance: 1n }).verify(bundle);
        expect(verdict.valid).toBe(true);
    });
});
