import { describe, it, expect } from "vitest";
import { makeBackgroundVerifier, type BackgroundVerifierDeps } from "./background.js";
import { makeGateResultCache } from "./gate-result-cache.js";
import { makeVerdictCache } from "./cache.js";
import { Erc721MinBalanceOptionsSchema } from "../rules/erc721-min-balance.js";
import type { Rule, RuleRegistry } from "../rules/types.js";
import { makeBucketMath } from "../chain/bucket.js";
import { bundleCid } from "../crdt/codec.js";
import { bizCriteria } from "../test-fixtures.js";
import type { ChainClient, NameResolver } from "../chain/types.js";
import type { VotesBundle } from "../schema/votes.js";
import type { CID } from "multiformats/cid";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

const padAddress = (tag: string) => `0x${tag.replace(/^0x/, "").padStart(40, "0")}`;

function bundle(address: string, opts: { blockNumber?: number; name?: string; publicKey?: string } = {}): VotesBundle {
    return {
        address: padAddress(address),
        votes: [
            {
                community: { publicKey: opts.publicKey ?? KEY_A, ...(opts.name ? { name: opts.name } : {}) },
                vote: 1
            }
        ],
        blockNumber: opts.blockNumber ?? 43200,
        signature: { signature: `0x${"11".repeat(65)}`, type: "eip712" }
    };
}

async function pending(b: VotesBundle): Promise<{ cid: CID; bundle: VotesBundle }> {
    return { cid: await bundleCid(b), bundle: b };
}

/**
 * A stub gate rule shadowing `erc721-min-balance` by type. `scores` maps a LOWERCASE wallet to
 * its gate score (default `1n`); a wallet mapped to an Error makes the read throw (infra).
 * `calls` records every evaluate/evaluateMany invocation for batching assertions.
 */
function stubRule(
    scores: Record<string, bigint | Error>,
    opts: { batched?: boolean } = {}
): { rule: Rule; calls: Array<{ kind: "one" | "many"; wallets: string[]; block: number }> } {
    const calls: Array<{ kind: "one" | "many"; wallets: string[]; block: number }> = [];
    const scoreFor = (wallet: string): bigint => {
        const entry = scores[wallet.toLowerCase()] ?? 1n;
        if (entry instanceof Error) throw entry;
        return entry;
    };
    const rule: Rule = {
        type: "erc721-min-balance",
        optionsSchema: Erc721MinBalanceOptionsSchema,
        async evaluate({ walletAddress, ctx }) {
            calls.push({ kind: "one", wallets: [walletAddress], block: ctx.blockNumber });
            return { score: scoreFor(walletAddress) };
        },
        ...(opts.batched
            ? {
                  async evaluateMany({ walletAddresses, ctx }) {
                      calls.push({ kind: "many", wallets: walletAddresses, block: ctx.blockNumber });
                      return walletAddresses.map((wallet) => ({ score: scoreFor(wallet) }));
                  }
              }
            : {})
    };
    return { rule, calls };
}

/** A resolver over a fixed name -> publicKey map; a value of Error makes resolution throw. */
function resolver(map: Record<string, string | Error>): NameResolver {
    return {
        key: "test",
        provider: "test",
        canResolve: ({ name }) => name.endsWith(".bso"),
        resolve: async ({ name }) => {
            const entry = map[name];
            if (entry instanceof Error) throw entry;
            return entry ? { publicKey: entry } : undefined;
        }
    };
}

function harness(over: Partial<BackgroundVerifierDeps> & { registry?: RuleRegistry } = {}) {
    const gateVerified: string[] = [];
    const nameResolved: string[] = [];
    const evicted: Array<{ cid: string; disposition: string }> = [];
    const errors: unknown[] = [];
    const cache = makeVerdictCache();
    const gateResultCache = makeGateResultCache();
    const verifier = makeBackgroundVerifier({
        criteria: bizCriteria(),
        registry: over.registry ?? { "erc721-min-balance": stubRule({}).rule },
        chainFor: () => ({}) as unknown as ChainClient,
        bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
        nameResolvers: [],
        gateResultCache,
        cache,
        onGateVerified: (cid) => gateVerified.push(cid.toString()),
        onNameResolved: (cid) => nameResolved.push(cid.toString()),
        onEvict: (cid, verdict) => evicted.push({ cid: cid.toString(), disposition: verdict.disposition }),
        onError: (error) => errors.push(error),
        limit: (fn) => fn(),
        retryBaseMs: 5,
        retryCapMs: 10,
        ...over
    });
    return { verifier, gateVerified, nameResolved, evicted, errors, cache, gateResultCache };
}

describe("makeBackgroundVerifier", () => {
    it("batches a round's gate reads into ONE evaluateMany per sample block and settles each bundle", async () => {
        const { rule, calls } = stubRule({}, { batched: true });
        const h = harness({ registry: { "erc721-min-balance": rule } });
        const entries = await Promise.all([pending(bundle("0x1")), pending(bundle("0x2")), pending(bundle("0x3"))]);
        h.verifier.enqueue(entries);
        await h.verifier.idle();

        expect(calls).toEqual([{ kind: "many", wallets: entries.map((e) => e.bundle.address), block: 43200 }]);
        expect(h.gateVerified).toHaveLength(3);
        expect(h.evicted).toHaveLength(0);
        // Terminal valid verdicts are cached so a later re-publish short-circuits at the gate.
        expect(h.cache.get(entries[0]!.cid)).toMatchObject({ valid: true, ruleScore: 1n });
        expect(h.verifier.pendingCount()).toBe(0);
    });

    it("falls back to per-wallet evaluate calls when the rule has no evaluateMany", async () => {
        const { rule, calls } = stubRule({});
        const h = harness({ registry: { "erc721-min-balance": rule } });
        h.verifier.enqueue(await Promise.all([pending(bundle("0x1")), pending(bundle("0x2"))]));
        await h.verifier.idle();
        expect(calls.map((c) => c.kind)).toEqual(["one", "one"]);
        expect(h.gateVerified).toHaveLength(2);
    });

    it("groups gate reads by sample block (bundles from different buckets batch separately)", async () => {
        const { rule, calls } = stubRule({}, { batched: true });
        const h = harness({ registry: { "erc721-min-balance": rule } });
        h.verifier.enqueue(
            await Promise.all([pending(bundle("0x1", { blockNumber: 43200 })), pending(bundle("0x2", { blockNumber: 86400 }))])
        );
        await h.verifier.idle();
        expect(calls.map((c) => c.block).sort()).toEqual([43200, 86400]);
    });

    it("evicts a gate-failed wallet's bundle with a cached provable reject", async () => {
        const bad = bundle("0xbad");
        const { rule } = stubRule({ [bad.address.toLowerCase()]: 0n }, { batched: true });
        const h = harness({ registry: { "erc721-min-balance": rule } });
        const [good, failed] = await Promise.all([pending(bundle("0x1")), pending(bad)]);
        h.verifier.enqueue([good!, failed!]);
        await h.verifier.idle();

        expect(h.gateVerified).toEqual([good!.cid.toString()]);
        expect(h.evicted).toEqual([{ cid: failed!.cid.toString(), disposition: "reject" }]);
        expect(h.cache.get(failed!.cid)).toMatchObject({ valid: false, disposition: "reject" });
    });

    it("skips the chain read entirely on a gate-result cache hit", async () => {
        const { rule, calls } = stubRule({}, { batched: true });
        const h = harness({ registry: { "erc721-min-balance": rule } });
        const b = bundle("0x1");
        h.gateResultCache.set(b.address, 43200, 2n);
        h.verifier.enqueue([await pending(b)]);
        await h.verifier.idle();
        expect(calls).toHaveLength(0);
        expect(h.gateVerified).toHaveLength(1);
        expect(h.cache.get(await bundleCid(b))).toMatchObject({ valid: true, ruleScore: 2n });
    });

    it("verifies each enqueued CID once, even when a bundle is enqueued twice", async () => {
        const { rule, calls } = stubRule({}, { batched: true });
        const h = harness({ registry: { "erc721-min-balance": rule } });
        const entry = await pending(bundle("0x1"));
        h.verifier.enqueue([entry]);
        h.verifier.enqueue([entry]);
        await h.verifier.idle();
        expect(calls).toHaveLength(1);
        expect(h.gateVerified).toHaveLength(1);
    });

    it("resolves carried names, reporting nameResolved and caching resolvedNames", async () => {
        const named = bundle("0x1", { name: "memes.bso" });
        const h = harness({ nameResolvers: [resolver({ "memes.bso": KEY_A })] });
        const entry = await pending(named);
        h.verifier.enqueue([entry]);
        await h.verifier.idle();
        expect(h.nameResolved).toEqual([entry.cid.toString()]);
        expect(h.cache.get(entry.cid)).toMatchObject({ valid: true, resolvedNames: { "memes.bso": KEY_A } });
    });

    it("evicts (uncached, ignore-class) a name that resolves to a different key, or has no resolver", async () => {
        const squatted = bundle("0x1", { name: "memes.bso" }); // resolves to KEY_B, claims KEY_A
        const orphan = bundle("0x2", { name: "funny.eth" }); // no resolver handles .eth
        const h = harness({ nameResolvers: [resolver({ "memes.bso": KEY_B })] });
        const [a, b] = await Promise.all([pending(squatted), pending(orphan)]);
        h.verifier.enqueue([a!, b!]);
        await h.verifier.idle();

        expect(h.evicted.map((e) => e.disposition)).toEqual(["ignore", "ignore"]);
        // View-dependent verdicts are never cached — a re-point window must stay re-evaluable.
        expect(h.cache.get(a!.cid)).toBeUndefined();
        expect(h.cache.get(b!.cid)).toBeUndefined();
    });

    it("keeps bundles pending through an infra failure, surfaces onError, and settles on retry", async () => {
        const wallet = padAddress("0x1").toLowerCase();
        let failures = 1;
        const calls: Array<{ kind: string }> = [];
        const rule: Rule = {
            type: "erc721-min-balance",
            optionsSchema: Erc721MinBalanceOptionsSchema,
            async evaluate() {
                throw new Error("unexpected: batched rule");
            },
            async evaluateMany({ walletAddresses }) {
                calls.push({ kind: "many" });
                if (failures > 0) {
                    failures--;
                    throw new Error("RPC down");
                }
                return walletAddresses.map(() => ({ score: 1n }));
            }
        };
        const h = harness({ registry: { "erc721-min-balance": rule } });
        const entry = await pending(bundle(wallet));
        h.verifier.enqueue([entry]);
        await h.verifier.idle();

        expect(h.errors).toHaveLength(1); // the degraded round surfaced
        expect(calls).toHaveLength(2); // failed round + successful retry
        expect(h.gateVerified).toEqual([entry.cid.toString()]);
        expect(h.verifier.pendingCount()).toBe(0);
        expect(h.evicted).toHaveLength(0); // infra is nobody's verdict — never an eviction
    });

    it("retries only the name stage after a resolver infra failure (the gate is not re-read)", async () => {
        const { rule, calls } = stubRule({}, { batched: true });
        let failures = 1;
        const flaky: NameResolver = {
            key: "flaky",
            provider: "test",
            canResolve: ({ name }) => name.endsWith(".bso"),
            resolve: async () => {
                if (failures > 0) {
                    failures--;
                    throw new Error("resolver down");
                }
                return { publicKey: KEY_A };
            }
        };
        const h = harness({ registry: { "erc721-min-balance": rule }, nameResolvers: [flaky] });
        const entry = await pending(bundle("0x1", { name: "memes.bso" }));
        h.verifier.enqueue([entry]);
        await h.verifier.idle();

        expect(calls).toHaveLength(1); // one gate batch; the retry re-ran names only
        expect(h.gateVerified).toEqual([entry.cid.toString()]); // notified once, not per round
        expect(h.nameResolved).toEqual([entry.cid.toString()]);
        expect(h.errors).toHaveLength(1);
    });

    it("stop() pauses the retry loop and resume() drains what was left pending", async () => {
        let failing = true;
        const rule: Rule = {
            type: "erc721-min-balance",
            optionsSchema: Erc721MinBalanceOptionsSchema,
            async evaluate() {
                if (failing) throw new Error("RPC down");
                return { score: 1n };
            }
        };
        const h = harness({ registry: { "erc721-min-balance": rule } });
        const entry = await pending(bundle("0x1"));
        h.verifier.enqueue([entry]);
        // Let the first (failing) round run, then pause while still pending.
        await new Promise((r) => setTimeout(r, 2));
        h.verifier.stop();
        expect(h.verifier.pendingCount()).toBe(1);

        failing = false;
        h.verifier.resume();
        await h.verifier.idle();
        expect(h.gateVerified).toEqual([entry.cid.toString()]);
        expect(h.verifier.pendingCount()).toBe(0);
    });
});
