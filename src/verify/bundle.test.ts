import { describe, it, expect } from "vitest";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { makeBundleVerifier } from "./bundle.js";
import { makeMemoryRuleCache, type RuleCache } from "../rules/cache.js";
import { ballotTypedData } from "../signer/eip712.js";
import { VotesBundleSchema, type Vote, type VotesBundle } from "../schema/votes.js";
import { builtinRegistry } from "../rules/registry.js";
import type { Rule, RuleResult } from "../rules/types.js";
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
        resolve: async ({ name }) => {
            const publicKey = map[name];
            return publicKey === undefined ? undefined : { publicKey };
        }
    };
}

function verifier(over: { balance?: bigint; onRead?: () => void; names?: Record<string, string>; ruleCaches?: readonly RuleCache[] } = {}) {
    return makeBundleVerifier({
        criteria: bizCriteria(),
        criteriaCid: CRITERIA_CID,
        chainId: CHAIN_ID,
        registry: builtinRegistry,
        chain: fakeChain(over.balance ?? 1n, over.onRead),
        bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
        nameResolvers: [resolver(over.names ?? {})],
        // Omitted rather than passed as undefined: `ruleCaches` is optional and the deps type is
        // exact, so an explicit undefined is not the same as "the caller said nothing".
        ...(over.ruleCaches === undefined ? {} : { ruleCaches: over.ruleCaches })
    });
}

describe("makeBundleVerifier", () => {
    it("accepts a validly-signed, eligible, unnamed vote", async () => {
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        const verdict = await verifier({ balance: 1n }).verify(bundle);
        expect(verdict.valid).toBe(true);
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
            chain: fakeChain(0n),
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
            chain: chain,
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
            chain: fakeChain(1000n, undefined, false),
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

/**
 * A composite gate through the INLINE forward-gate path — the one gossipsub runs before
 * re-forwarding. It differs from the background verifier's in that it evaluates LAZILY, so both
 * the fold's output and what it declined to read are properties worth pinning here.
 */
describe("composite gates on the forward-gate path", () => {
    /** A one-answer rule under an arbitrary `type`, recording every wallet it was asked about. */
    function fixedRule(type: string, answer: RuleResult, asked: string[]): Rule {
        return {
            type,
            optionsSchema: z.looseObject({ type: z.string() }),
            evaluate: async ({ wallet }) => {
                asked.push(type);
                void wallet;
                return answer;
            }
        };
    }
    const ok: RuleResult = { success: true, score: 3n };
    const compositeVerifier = (kind: "all" | "any", rules: Record<string, RuleResult>, asked: string[]) =>
        makeBundleVerifier({
            criteria: { ...bizCriteria(), gate: { [kind]: Object.keys(rules).map((type) => ({ rule: { type } })) } as never },
            criteriaCid: CRITERIA_CID,
            chainId: CHAIN_ID,
            registry: Object.fromEntries(Object.entries(rules).map(([type, answer]) => [type, fixedRule(type, answer, asked)])),
            chain: fakeChain(1n),
            bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
            nameResolvers: []
        });

    it("admits only when the whole tree does, and folds the score", async () => {
        const asked: string[] = [];
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        // `all` scores the binding constraint...
        const both = await compositeVerifier("all", { a: ok, b: { success: true, score: 9n } }, asked).verify(bundle);
        expect(both).toMatchObject({ valid: true });
        // ...and `any` the best route, admitting despite a failed alternative.
        const either = await compositeVerifier("any", { a: { success: false, error: "no" }, b: { success: true, score: 9n } }, asked).verify(
            bundle
        );
        expect(either).toMatchObject({ valid: true });
    });

    it("stops at the deciding leaf, so a composite gate costs only the rules it needed", async () => {
        // The forward gate runs once per incoming vote and every leaf is a chain read, which is
        // why this path is lazy where the batched background verifier is not.
        const asked: string[] = [];
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        await compositeVerifier("all", { a: { success: false, error: "no" }, b: ok }, asked).verify(bundle);
        expect(asked).toEqual(["a"]); // `b` was never read
    });

    it("carries the blame set and the folded disposition into the verdict", async () => {
        const asked: string[] = [];
        const bundle = await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]);
        // Both alternatives of an `any` fail; one blames nobody, so the whole refusal blames
        // nobody — `ignore`, not `reject` (rules/gate.ts `gatePenalize`).
        const verdict = await compositeVerifier(
            "any",
            { a: { success: false, error: "wallet is banned" }, b: { success: false, error: "holds no Pass", penalize: false } },
            asked
        ).verify(bundle);

        expect(verdict.valid).toBe(false);
        if (verdict.valid) throw new Error("expected a refusal");
        expect(verdict.disposition).toBe("ignore");
        // Both alternatives are named: each is a road this wallet could have taken and did not.
        expect(verdict.failures?.map((f) => f.type)).toEqual(["a", "b"]);
        expect(verdict.reason).toContain("wallet is banned");
        expect(verdict.reason).toContain("holds no Pass");
    });

    it("gives each leaf its own memo, so same-type leaves cannot read each other's answers", async () => {
        // Two leaves of ONE rule type on different options are different questions. Sharing a
        // keyspace would let a `min: 1` leaf answer for a `min: 5` one — silently, and only for
        // rules that key their memo by wallet alone.
        let reads = 0;
        const criteria = {
            ...bizCriteria(),
            gate: { all: [{ rule: { ...bizGateRef(), min: 1 } }, { rule: { ...bizGateRef(), min: 5 } }] }
        };
        const verdict = await makeBundleVerifier({
            criteria,
            criteriaCid: CRITERIA_CID,
            chainId: CHAIN_ID,
            registry: builtinRegistry,
            chain: fakeChain(3n, () => reads++),
            bucketMath: makeBucketMath(criteria.blocksPerBucket),
            nameResolvers: []
        }).verify(await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]));

        // Holding 3 satisfies `min: 1` but not `min: 5`, so the gate must refuse. If the two
        // leaves shared a memo the second would never have run its own reads at all.
        expect(verdict.valid).toBe(false);
        if (!verdict.valid) expect(verdict.failures?.[0]?.error).toContain("5 are required");
        expect(reads).toBeGreaterThan(2); // both leaves paid for their own reads
    });

    it("evaluates a rule named in two branches once per wallet", async () => {
        // The inline path's half of the same contract: "any two of these three" has six positions
        // and three questions, and the forward gate runs per incoming vote, so asking a question
        // twice would double this path's chain reads for every message.
        const asked: string[] = [];
        const verifier = makeBundleVerifier({
            criteria: {
                ...bizCriteria(),
                gate: {
                    any: [
                        { all: [{ rule: { type: "a" } }, { rule: { type: "b" } }] },
                        { all: [{ rule: { type: "a" } }, { rule: { type: "c" } }] },
                        { all: [{ rule: { type: "b" } }, { rule: { type: "c" } }] }
                    ]
                }
            } as never,
            criteriaCid: CRITERIA_CID,
            chainId: CHAIN_ID,
            registry: {
                a: fixedRule("a", ok, asked),
                b: fixedRule("b", ok, asked),
                c: fixedRule("c", { success: false, error: "no" }, asked)
            },
            chain: fakeChain(1n),
            bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
            nameResolvers: []
        });

        const verdict = await verifier.verify(await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]));
        expect(verdict.valid).toBe(true); // the first alternative (a AND b) admits
        // `a` and `b` answered once each; `c` was never needed, since the first branch decided it.
        expect(asked).toEqual(["a", "b"]);
    });

    it("lets a failed chain read fail the VERIFY, rather than folding it into a refusal", async () => {
        // The counterpart to `checkGates`, which tolerates an unreadable leaf. On this path it
        // must not: a verdict is a statement to the network, and one reached because a read never
        // happened would evict a vote (or penalize its sender) over an outage. The caller treats
        // a throw as infra and re-queues the bundle instead.
        const asked: string[] = [];
        const failing: Rule = {
            type: "flaky",
            optionsSchema: z.looseObject({ type: z.string() }),
            evaluate: async () => {
                throw new Error("rpc: 429 too many requests");
            }
        };
        const verifier = makeBundleVerifier({
            criteria: { ...bizCriteria(), gate: { any: [{ rule: { type: "flaky" } }, { rule: { type: "b" } }] } as never },
            criteriaCid: CRITERIA_CID,
            chainId: CHAIN_ID,
            registry: { flaky: failing, b: fixedRule("b", ok, asked) },
            chain: fakeChain(1n),
            bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
            nameResolvers: []
        });

        await expect(verifier.verify(await signedBundle([{ community: { publicKey: KEY_A }, vote: 1 }]))).rejects.toThrow(
            "rpc: 429 too many requests"
        );
    });

    it("answers checkGates from the branches that DID read, when a leaf's read fails", async () => {
        // Same gate, same outage, different question. `checkGates` answers a person rather than
        // the network, so a wallet admitted by an alternative that answered is told so instead of
        // being handed an error it cannot act on.
        const asked: string[] = [];
        const failing: Rule = {
            type: "flaky",
            optionsSchema: z.looseObject({ type: z.string() }),
            evaluate: async () => {
                throw new Error("rpc: 429 too many requests");
            }
        };
        const verifier = makeBundleVerifier({
            criteria: { ...bizCriteria(), gate: { any: [{ rule: { type: "flaky" } }, { rule: { type: "b" } }] } as never },
            criteriaCid: CRITERIA_CID,
            chainId: CHAIN_ID,
            registry: { flaky: failing, b: fixedRule("b", ok, asked) },
            chain: fakeChain(1n),
            bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
            nameResolvers: []
        });

        const gate = await verifier.checkGates({ address: account.address, sampleBlock: 43200 });
        expect(gate.satisfied).toBe(true);
        if (gate.kind === "leaf") throw new Error("expected a branch");
        expect(gate.children[0]).toMatchObject({ satisfied: undefined }); // unknown, never `false`
    });
});
