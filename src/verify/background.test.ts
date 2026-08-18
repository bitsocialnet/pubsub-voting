import { describe, it, expect } from "vitest";
import { z } from "zod";
import { makeBackgroundVerifier, type BackgroundVerifierDeps } from "./background.js";
import { makeMemoryRuleCache } from "../rules/cache.js";
import { makeVerdictCache } from "./cache.js";
import { Erc5192MinBalanceOptionsSchema } from "../rules/erc5192-min-balance.js";
import type { Rule, RuleRegistry, RuleResult } from "../rules/types.js";
import type { VerifyFail } from "./types.js";
import { makeBucketMath } from "../chain/bucket.js";
import { bundleCid } from "../crdt/codec.js";
import { bizCriteria } from "../test-fixtures.js";
import type { ChainClient, NameResolver } from "../chain/types.js";
import type { ChainReadContext } from "../rules/types.js";
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
 * A stub gate rule shadowing `erc5192-min-balance` by type. `scores` maps a LOWERCASE wallet to
 * its gate score (default `1n`); a wallet mapped to an Error makes the read throw (infra).
 * `calls` records every evaluate/evaluateMany invocation for batching assertions.
 */
function stubRule(
    scores: Record<string, bigint | Error>,
    opts: { batched?: boolean; penalize?: boolean; readHead?: boolean } = {}
): { rule: Rule; calls: Array<{ kind: "one" | "many"; wallets: string[]; block: number; sampleBlocks: number[] }> } {
    const calls: Array<{ kind: "one" | "many"; wallets: string[]; block: number; sampleBlocks: number[] }> = [];
    const scoreFor = (wallet: string): bigint => {
        const entry = scores[wallet.toLowerCase()] ?? 1n;
        if (entry instanceof Error) throw entry;
        return entry;
    };
    // A rule reads whichever block it likes now, so the stub mirrors that: `readHead` makes it
    // score at the verifier's head (like the v1 gate), otherwise at each ballot's pinned block.
    const blockFor = async (ctx: ChainReadContext, sampleBlock: number): Promise<number> =>
        opts.readHead ? (await ctx.head()).block : sampleBlock;
    const result = (wallet: string): RuleResult => {
        const score = scoreFor(wallet);
        if (score > 0n) return { success: true, score };
        return {
            success: false,
            error: `stub gate: ${wallet} does not qualify`,
            ...(opts.penalize === undefined ? {} : { penalize: opts.penalize })
        };
    };
    const rule: Rule = {
        type: "erc5192-min-balance",
        optionsSchema: Erc5192MinBalanceOptionsSchema,
        async evaluate({ wallet, ctx }) {
            calls.push({
                kind: "one",
                wallets: [wallet.address],
                block: await blockFor(ctx, wallet.sampleBlock),
                sampleBlocks: [wallet.sampleBlock]
            });
            return result(wallet.address);
        },
        ...(opts.batched
            ? {
                  async evaluateMany({ wallets, ctx }) {
                      calls.push({
                          kind: "many",
                          wallets: wallets.map((wallet) => wallet.address),
                          block: await blockFor(ctx, wallets[0]!.sampleBlock),
                          sampleBlocks: wallets.map((wallet) => wallet.sampleBlock)
                      });
                      return { results: wallets.map((wallet) => result(wallet.address)) };
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
    const ruleCache = makeMemoryRuleCache();
    const verifier = makeBackgroundVerifier({
        criteria: bizCriteria(),
        registry: over.registry ?? { "erc5192-min-balance": stubRule({}).rule },
        chain: ({}) as unknown as ChainClient,
        bucketMath: makeBucketMath(bizCriteria().blocksPerBucket),
        nameResolvers: [],
        ruleCaches: [ruleCache],
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
    return { verifier, gateVerified, nameResolved, evicted, errors, cache, ruleCache };
}

describe("makeBackgroundVerifier", () => {
    it("batches a round's gate reads into ONE evaluateMany per sample block and settles each bundle", async () => {
        const { rule, calls } = stubRule({}, { batched: true });
        const h = harness({ registry: { "erc5192-min-balance": rule } });
        const entries = await Promise.all([pending(bundle("0x1")), pending(bundle("0x2")), pending(bundle("0x3"))]);
        h.verifier.enqueue(entries);
        await h.verifier.idle();

        expect(calls).toEqual([
            { kind: "many", wallets: entries.map((e) => e.bundle.address), block: 43200, sampleBlocks: entries.map(() => 43200) }
        ]);
        expect(h.gateVerified).toHaveLength(3);
        expect(h.evicted).toHaveLength(0);
        // Terminal valid verdicts are cached so a later re-publish short-circuits at the gate.
        expect(h.cache.get(entries[0]!.cid)).toMatchObject({ valid: true });
        expect(h.verifier.pendingCount()).toBe(0);
    });

    it("falls back to per-wallet evaluate calls when the rule has no evaluateMany", async () => {
        const { rule, calls } = stubRule({});
        const h = harness({ registry: { "erc5192-min-balance": rule } });
        h.verifier.enqueue(await Promise.all([pending(bundle("0x1")), pending(bundle("0x2"))]));
        await h.verifier.idle();
        expect(calls.map((c) => c.kind)).toEqual(["one", "one"]);
        expect(h.gateVerified).toHaveLength(2);
    });

    it("hands a round to the rule in ONE call, each wallet carrying its own ballot's pinned block", async () => {
        // The pipeline no longer groups by block: which block a wallet is read at is the rule's
        // decision (rules/types.ts), so a batch is simply everything pending, each entry tagged
        // with the block its ballot names. A rule that needs grouping does it itself.
        const { rule, calls } = stubRule({}, { batched: true });
        const h = harness({ registry: { "erc5192-min-balance": rule } });
        h.verifier.enqueue(
            await Promise.all([pending(bundle("0x1", { blockNumber: 43200 })), pending(bundle("0x2", { blockNumber: 86400 }))])
        );
        await h.verifier.idle();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.sampleBlocks.sort((x, y) => x - y)).toEqual([43200, 86400]);
        expect(h.gateVerified).toHaveLength(2);
    });

    it("evicts a gate-failed wallet's bundle with a cached provable reject", async () => {
        const bad = bundle("0xbad");
        const { rule } = stubRule({ [bad.address.toLowerCase()]: 0n }, { batched: true });
        const h = harness({ registry: { "erc5192-min-balance": rule } });
        const [good, failed] = await Promise.all([pending(bundle("0x1")), pending(bad)]);
        h.verifier.enqueue([good!, failed!]);
        await h.verifier.idle();

        expect(h.gateVerified).toEqual([good!.cid.toString()]);
        expect(h.evicted).toEqual([{ cid: failed!.cid.toString(), disposition: "reject" }]);
        expect(h.cache.get(failed!.cid)).toMatchObject({ valid: false, disposition: "reject" });
    });

    it("honours the rule's own memo across rounds: a repeat wallet costs no second read", async () => {
        // Memoization moved into the rule with the keys (rules/cache.ts). The pipeline hands the
        // same cache to the forward gate and to this verifier, so a wallet either of them settled
        // costs the other nothing — the property the old pipeline-level gate cache provided.
        let reads = 0;
        const rule: Rule = {
            type: "erc5192-min-balance",
            optionsSchema: Erc5192MinBalanceOptionsSchema,
            async evaluate({ wallet, ctx }) {
                const { values } = await ctx.cache.memoMany({
                    keys: [wallet.address.toLowerCase()],
                    epoch: wallet.sampleBlock,
                    read: async ({ keys }) => {
                        reads += keys.length;
                        return { values: keys.map(() => "2") };
                    }
                });
                return { success: true, score: BigInt(values[0]!) };
            }
        };
        const h = harness({ registry: { "erc5192-min-balance": rule } });
        const first = bundle("0x1");
        h.verifier.enqueue([await pending(first)]);
        await h.verifier.idle();
        expect(reads).toBe(1);
        expect(h.cache.get(await bundleCid(first))).toMatchObject({ valid: true });

        // A DIFFERENT bundle from the same wallet at the same block: no read at all this time.
        h.verifier.enqueue([await pending(bundle("0x1", { publicKey: KEY_B }))]);
        await h.verifier.idle();
        expect(reads).toBe(1);
        expect(h.gateVerified).toHaveLength(2);
    });

    it("verifies each enqueued CID once, even when a bundle is enqueued twice", async () => {
        const { rule, calls } = stubRule({}, { batched: true });
        const h = harness({ registry: { "erc5192-min-balance": rule } });
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
            type: "erc5192-min-balance",
            optionsSchema: Erc5192MinBalanceOptionsSchema,
            async evaluate() {
                throw new Error("unexpected: batched rule");
            },
            async evaluateMany({ wallets }) {
                calls.push({ kind: "many" });
                if (failures > 0) {
                    failures--;
                    throw new Error("RPC down");
                }
                return { results: wallets.map((): RuleResult => ({ success: true, score: 1n })) };
            }
        };
        const h = harness({ registry: { "erc5192-min-balance": rule } });
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
        const h = harness({ registry: { "erc5192-min-balance": rule }, nameResolvers: [flaky] });
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
            type: "erc5192-min-balance",
            optionsSchema: Erc5192MinBalanceOptionsSchema,
            async evaluate() {
                if (failing) throw new Error("RPC down");
                return { success: true, score: 1n };
            }
        };
        const h = harness({ registry: { "erc5192-min-balance": rule } });
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

describe("makeBackgroundVerifier: a rule that scores at the head (rules/types.ts, RuleResult.penalize)", () => {
    /** A rule that scores at the verifier's head and blames its `0n` on nobody — the v1 gate's shape. */
    const liveRule = (scores: Record<string, bigint | Error>) => stubRule(scores, { batched: true, readHead: true, penalize: false });

    it("scores the WHOLE round at one head, ignoring which bucket each bundle came from", async () => {
        // The pinned path groups per bundle bucket; a live round shares one block, so a cold
        // join's bundles collapse into a single multicall no matter how spread out their
        // buckets are. Strictly better batching than the pinned path, not worse.
        const { rule, calls } = liveRule({});
        const h = harness({
            registry: { "erc5192-min-balance": rule },
            readHead: async () => ({ block: 99_000 })
        });
        h.verifier.enqueue(
            await Promise.all([pending(bundle("0x1", { blockNumber: 43200 })), pending(bundle("0x2", { blockNumber: 86400 }))])
        );
        await h.verifier.idle();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.block).toBe(99_000); // the head, not either bundle's bucket sample block
        expect(h.gateVerified).toHaveLength(2);
    });

    it("keeps a 0n bundle pending inside the grace window instead of evicting it", async () => {
        // "not yet", not "no": the wallet may have acquired the gate asset in a block this
        // verifier has not seen. Evicting here would let RPC lag decide whether a vote counts.
        const { rule } = liveRule({ [padAddress("0xbad").toLowerCase()]: 0n });
        const h = harness({
            registry: { "erc5192-min-balance": rule },
            readHead: async () => ({ block: 99_000 }),
            gateGraceMs: 10_000,
            gateRetryMs: 5
        });
        const entry = await pending(bundle("0xbad"));
        h.verifier.enqueue([entry]);
        await new Promise((r) => setTimeout(r, 40)); // several re-examinations inside the window
        expect(h.evicted).toEqual([]);
        expect(h.verifier.pendingCount()).toBe(1);
        expect(h.errors).toEqual([]); // "not yet" is nobody's failure — no error surfaces
        h.verifier.stop();
    });

    it("admits a bundle whose wallet acquires the asset before the grace closes", async () => {
        // The fresh-mint case the live view exists for: the wallet is 0n at the head of the
        // first round and >0n a moment later. This stub does not memoize, so every re-examination
        // re-reads; a real rule keys its memo by a coarse head window (rules/cache.ts) and only
        // re-reads once the head has moved past it.
        const wallet = padAddress("0xbee").toLowerCase();
        const scores: Record<string, bigint | Error> = { [wallet]: 0n };
        const { rule, calls } = liveRule(scores);
        let head = 99_000;
        const h = harness({
            registry: { "erc5192-min-balance": rule },
            readHead: async () => ({ block: head }),
            gateGraceMs: 10_000,
            gateRetryMs: 5
        });
        h.verifier.enqueue([await pending(bundle("0xbee"))]);
        await new Promise((r) => setTimeout(r, 20));
        expect(h.gateVerified).toEqual([]); // still "not yet"

        scores[wallet] = 1n; // the mint lands...
        head += 30; // ...and the head moves on
        await h.verifier.idle();

        expect(h.gateVerified).toHaveLength(1);
        expect(h.evicted).toEqual([]);
        expect(calls.length).toBeGreaterThanOrEqual(2); // one read per window, not one per round
    });

    it("evicts ignore-class and UNCACHED once the grace window closes", async () => {
        // A wallet that never holds the asset must not pend forever — that is memory a spammer
        // chooses. The verdict stays uncached so a later re-publish is judged fresh rather than
        // inheriting a view-dependent drop.
        const { rule } = liveRule({ [padAddress("0xbad").toLowerCase()]: 0n });
        const h = harness({
            registry: { "erc5192-min-balance": rule },
            readHead: async () => ({ block: 99_000 }),
            gateGraceMs: 15,
            gateRetryMs: 5
        });
        const entry = await pending(bundle("0xbad"));
        h.verifier.enqueue([entry]);
        await h.verifier.idle();

        expect(h.evicted).toEqual([{ cid: entry.cid.toString(), disposition: "ignore" }]);
        expect(h.cache.get(entry.cid)).toBeUndefined();
        expect(h.verifier.pendingCount()).toBe(0);
    });
});

/**
 * A composite gate through the REAL background verifier: the leaves are batched independently and
 * their answers folded (rules/gate.ts), so the eviction, its reason and its disposition are what
 * the whole tree says — not what any one rule said.
 */
describe("composite gates", () => {
    /** A one-answer rule under an arbitrary `type`, so a gate can name two distinct rules. */
    function fixedRule(type: string, answer: RuleResult): Rule {
        return {
            type,
            optionsSchema: z.looseObject({ type: z.string() }),
            evaluate: async () => answer
        };
    }
    const ok: RuleResult = { success: true, score: 1n };
    const composite = (kind: "all" | "any") => ({
        ...bizCriteria(),
        gate: { [kind]: [{ rule: { type: "holds-pass" } }, { rule: { type: "not-banned" } }] } as never
    });

    it("evicts on ONE attributable failure inside an `all`, naming only the rules that explain it", async () => {
        const h = harness({
            criteria: composite("all"),
            registry: {
                "holds-pass": fixedRule("holds-pass", ok),
                "not-banned": fixedRule("not-banned", { success: false, error: "this wallet is banned from the board" })
            }
        });
        const entry = await pending(bundle("0xbad"));
        h.verifier.enqueue([entry]);
        await h.verifier.idle();

        // Attributable (the rule left `penalize` at its default), so terminal: evicted at once,
        // reject-class, and cached so a re-publish short-circuits.
        expect(h.evicted).toEqual([{ cid: entry.cid.toString(), disposition: "reject" }]);
        const verdict = h.cache.get(entry.cid);
        expect(verdict).toMatchObject({ valid: false, disposition: "reject" });
        const failed = verdict as VerifyFail;
        expect(failed.reason).toContain("banned from the board");
        // The satisfied leaf is not in the blame set — the wallet is not missing the Pass.
        expect(failed.failures?.map((f) => f.type)).toEqual(["not-banned"]);
    });

    it("holds an `any` whose alternatives failed for reasons NOBODY is blamed for", async () => {
        // One alternative is attributable, the other is not — so a peer looking at a fresher chain
        // may legitimately see a wallet this gate admits, and penalizing it would punish honest
        // relaying. The bundle is held through the grace window instead of evicted `reject`.
        const h = harness({
            criteria: composite("any"),
            registry: {
                "holds-pass": fixedRule("holds-pass", { success: false, error: "holds none of the gate token", penalize: false }),
                "not-banned": fixedRule("not-banned", { success: false, error: "this wallet is banned from the board" })
            },
            gateGraceMs: 15,
            gateRetryMs: 5
        });
        const entry = await pending(bundle("0xbad"));
        h.verifier.enqueue([entry]);
        await h.verifier.idle();

        expect(h.evicted).toEqual([{ cid: entry.cid.toString(), disposition: "ignore" }]);
        expect(h.cache.get(entry.cid)).toBeUndefined(); // uncached — judged fresh next time
        expect(h.gateVerified).toEqual([]);
    });

    it("admits when EITHER alternative of an `any` passes, and never re-reads the settled tree", async () => {
        const h = harness({
            criteria: composite("any"),
            registry: {
                "holds-pass": fixedRule("holds-pass", { success: false, error: "holds none of the gate token", penalize: false }),
                "not-banned": fixedRule("not-banned", ok)
            }
        });
        const entry = await pending(bundle("0xfeed"));
        h.verifier.enqueue([entry]);
        await h.verifier.idle();

        expect(h.evicted).toEqual([]);
        expect(h.gateVerified).toEqual([entry.cid.toString()]);
        expect(h.cache.get(entry.cid)).toMatchObject({ valid: true });
    });
});

/**
 * The batching contract for a composite gate. This path deliberately scores every leaf instead of
 * short-circuiting, and the reason is entirely about the axis of batching: one `evaluateMany` per
 * leaf covers a whole round's wallets, so collecting all costs one round trip per leaf however
 * many bundles are pending — whereas short-circuiting per wallet would fragment those batches
 * back into per-wallet reads. If that ever stops holding, the justification for `collectAll` here
 * goes with it.
 */
describe("composite gates: batching and per-leaf memos", () => {
    /** A batched rule that records each call, and can be made to throw like a failing RPC. */
    function batchedRule(type: string, answer: RuleResult, opts: { throws?: boolean } = {}) {
        const calls: string[][] = [];
        const caches: unknown[] = [];
        const rule: Rule = {
            type,
            optionsSchema: z.looseObject({ type: z.string() }),
            evaluate: async () => answer,
            async evaluateMany({ wallets, ctx }) {
                calls.push(wallets.map((wallet) => wallet.address));
                caches.push(ctx.cache);
                if (opts.throws) throw new Error(`${type}: RPC down`);
                return { results: wallets.map(() => answer) };
            }
        };
        return { rule, calls, caches };
    }
    const ok: RuleResult = { success: true, score: 1n };
    const compositeCriteria = {
        ...bizCriteria(),
        gate: { all: [{ rule: { type: "holds-pass" } }, { rule: { type: "not-banned" } }] } as never
    };

    it("makes exactly ONE evaluateMany per leaf per round, each over the whole round's wallets", async () => {
        const pass = batchedRule("holds-pass", ok);
        const banned = batchedRule("not-banned", ok);
        const h = harness({
            criteria: compositeCriteria,
            registry: { "holds-pass": pass.rule, "not-banned": banned.rule }
        });
        const entries = await Promise.all([pending(bundle("0x1")), pending(bundle("0x2")), pending(bundle("0x3"))]);
        h.verifier.enqueue(entries);
        await h.verifier.idle();

        const wallets = entries.map((entry) => entry.bundle.address);
        expect(pass.calls).toEqual([wallets]);
        expect(banned.calls).toEqual([wallets]);
        expect(h.gateVerified).toHaveLength(3);
    });

    it("collapses duplicate wallets once per leaf, not once per leaf per bundle", async () => {
        // Two bundles from ONE wallet in one bucket (a re-vote): the batch is a property of the
        // round, so each leaf still asks about that wallet exactly once.
        const pass = batchedRule("holds-pass", ok);
        const banned = batchedRule("not-banned", ok);
        const h = harness({
            criteria: compositeCriteria,
            registry: { "holds-pass": pass.rule, "not-banned": banned.rule }
        });
        const entries = await Promise.all([pending(bundle("0x9")), pending(bundle("0x9", { publicKey: KEY_B }))]);
        h.verifier.enqueue(entries);
        await h.verifier.idle();

        expect(pass.calls).toEqual([[padAddress("0x9")]]);
        expect(banned.calls).toEqual([[padAddress("0x9")]]);
    });

    it("asks a rule named in TWO branches once, not once per position", async () => {
        // "Any two of these three" repeats every rule across branches (schema/criteria.ts). The
        // batching axis is the question, not the position: six leaves, three distinct rules, three
        // batched calls — each still covering the whole round's wallets.
        const a = batchedRule("a", ok);
        const b = batchedRule("b", ok);
        const c = batchedRule("c", ok);
        const twoOfThree = {
            ...bizCriteria(),
            gate: {
                any: [
                    { all: [{ rule: { type: "a" } }, { rule: { type: "b" } }] },
                    { all: [{ rule: { type: "a" } }, { rule: { type: "c" } }] },
                    { all: [{ rule: { type: "b" } }, { rule: { type: "c" } }] }
                ]
            }
        } as never;
        const h = harness({ criteria: twoOfThree, registry: { a: a.rule, b: b.rule, c: c.rule } });
        const entries = await Promise.all([pending(bundle("0x1")), pending(bundle("0x2"))]);
        h.verifier.enqueue(entries);
        await h.verifier.idle();

        const wallets = entries.map((entry) => entry.bundle.address);
        expect(a.calls).toEqual([wallets]);
        expect(b.calls).toEqual([wallets]);
        expect(c.calls).toEqual([wallets]);
        expect(h.gateVerified).toHaveLength(2);
    });

    it("hands each leaf the memo at its OWN index", async () => {
        // `ruleCaches` is positional, and the inline verifier resolves the same leaves from the
        // same document — so a misalignment here would quietly serve one rule's answers to
        // another. Each leaf must see the store the voter namespaced for it.
        const pass = batchedRule("holds-pass", ok);
        const banned = batchedRule("not-banned", ok);
        const caches = [makeMemoryRuleCache(), makeMemoryRuleCache()];
        const h = harness({
            criteria: compositeCriteria,
            registry: { "holds-pass": pass.rule, "not-banned": banned.rule },
            ruleCaches: caches
        });
        h.verifier.enqueue([await pending(bundle("0x1"))]);
        await h.verifier.idle();

        expect(pass.caches).toEqual([caches[0]]);
        expect(banned.caches).toEqual([caches[1]]);
    });

    it("re-queues the round when a leaf's read fails, rather than deciding the gate without it", async () => {
        // An unreadable leaf is not an answer. Even though the OTHER leaf of this `any` admitted,
        // the item stays pending and un-evicted: a verdict reached on a read that never happened
        // is exactly what the retry exists to avoid.
        const flaky = batchedRule("holds-pass", ok, { throws: true });
        const banned = batchedRule("not-banned", ok);
        const h = harness({
            criteria: { ...bizCriteria(), gate: { any: [{ rule: { type: "holds-pass" } }, { rule: { type: "not-banned" } }] } as never },
            registry: { "holds-pass": flaky.rule, "not-banned": banned.rule }
        });
        const entry = await pending(bundle("0x1"));
        h.verifier.enqueue([entry]);
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(h.evicted).toHaveLength(0); // infra is nobody's verdict
        expect(h.cache.get(entry.cid)).toBeUndefined();
        expect(h.gateVerified).toEqual([]);
        expect(h.errors.length).toBeGreaterThan(0);
        expect(h.verifier.pendingCount()).toBe(1);
    });
});
