import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { makeBundleVerifier } from "./bundle.js";
import { ballotTypedData } from "../signer/eip712.js";
import { VotesBundleSchema, type Vote, type VotesBundle } from "../schema/votes.js";
import { builtinRegistry } from "../rules/registry.js";
import { makeBucketMath } from "../chain/bucket.js";
import { bizCriteria } from "../test-fixtures.js";
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

/** A fake viem client whose ERC-721 `balanceOf` returns a fixed balance; counts reads. */
function fakeChain(balance: bigint, onRead?: () => void): ChainClient {
    return {
        async readContract() {
            onRead?.();
            return balance;
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

function verifier(over: { balance?: bigint; onRead?: () => void; names?: Record<string, string> } = {}) {
    return makeBundleVerifier({
        criteria: bizCriteria(),
        criteriaCid: CRITERIA_CID,
        chainId: CHAIN_ID,
        registry: builtinRegistry,
        chainFor: () => fakeChain(over.balance ?? 1n, over.onRead),
        bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
        nameResolvers: [resolver(over.names ?? {})]
    });
}

describe("makeBundleVerifier", () => {
    it("accepts a validly-signed, eligible, unnamed vote", async () => {
        const bundle = await signedBundle([{ board: { publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n }).verify(bundle);
        expect(verdict.valid).toBe(true);
        if (verdict.valid) expect(verdict.ruleScore).toBe(1n);
    });

    it("rejects a wallet the gate does not admit (rule score 0n)", async () => {
        const bundle = await signedBundle([{ board: { publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 0n }).verify(bundle);
        expect(verdict.valid).toBe(false);
    });

    it("rejects a bad signature BEFORE any chain read (cheap-first ordering)", async () => {
        let reads = 0;
        const bundle = await signedBundle([{ board: { publicKey: KEY_A }, vote: 1 }]);
        // Corrupt the signature after signing; verifier must drop it at step 1.
        const forged: VotesBundle = { ...bundle, address: "0x0000000000000000000000000000000000000009" };
        const verdict = await verifier({ balance: 1n, onRead: () => reads++ }).verify(forged);
        expect(verdict.valid).toBe(false);
        expect(reads).toBe(0);
    });

    it("accepts a named vote whose name resolves to the claimed key", async () => {
        const bundle = await signedBundle([{ board: { name: "memes.bso", publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n, names: { "memes.bso": KEY_A } }).verify(bundle);
        expect(verdict.valid).toBe(true);
        if (verdict.valid) expect(verdict.resolvedNames).toEqual({ "memes.bso": KEY_A });
    });

    it("drops a squatted name that resolves to a different key", async () => {
        // memes.bso genuinely belongs to KEY_A, but this bundle claims it for KEY_B.
        const bundle = await signedBundle([{ board: { name: "memes.bso", publicKey: KEY_B }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n, names: { "memes.bso": KEY_A } }).verify(bundle);
        expect(verdict.valid).toBe(false);
    });

    it("drops a name that does not resolve", async () => {
        const bundle = await signedBundle([{ board: { name: "ghost.bso", publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n, names: {} }).verify(bundle);
        expect(verdict.valid).toBe(false);
    });

    it("accepts an empty withdrawal bundle from an eligible wallet", async () => {
        const bundle = await signedBundle([]);
        const verdict = await verifier({ balance: 1n }).verify(bundle);
        expect(verdict.valid).toBe(true);
    });
});
