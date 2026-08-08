import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import type { Criteria } from "../schema/criteria.js";
import type { RuleRegistry, RuleWallet } from "../rules/types.js";
import type { ChainClient, BucketMath, NameResolver } from "../chain/types.js";
import { tickerForRef } from "../chain/ticker.js";
import { makeMemoryRuleCache, type RuleCache } from "../rules/cache.js";
import { GATE_GRACE_MS, GATE_RETRY_MS } from "./gate-grace.js";
import { UnknownRuleError } from "../errors.js";
import { resolveNameThroughCache, type NameResolutionCache } from "./name-resolution-cache.js";
import type { VerdictCache } from "./cache.js";
import type { VerifyFail } from "./types.js";

/**
 * The background chain verifier: runs the two deferred NETWORK checks — the on-chain gate
 * (`rule` scores the wallet `> 0n` at the bucket block) and community-name resolution — for
 * bundles that were admitted *provisionally* after the synchronous offline checks (signature +
 * constraints). This is what makes a cold join non-blocking: the chase admits a checkpoint's
 * bundles on offline validity alone (µs each), the first tally renders immediately with
 * `chainVerified: false` rows, and this verifier confirms or evicts in the background (see
 * DESIGN.md "Background chain verification").
 *
 * Batched, not sequential: the gate stage hands a whole round's pending wallets to the rule's
 * `evaluateMany` (one multicall3 round trip for N wallets) rather than making N serial
 * `readContract` calls, falling back to `limit`-bounded per-wallet `evaluate` for rules without
 * a batched form. It does NOT group them by block — which block each wallet is read at is the
 * rule's business now, and a rule that needs grouping does it itself (see rules/types.ts).
 * Deduping and memoizing reads is likewise the rule's, through the cache it is handed
 * (rules/cache.ts), so a wallet settled by the forward gate costs nothing here; what this stage
 * still owns is the per-CID verdict cache, so a later re-publish of a settled bundle
 * short-circuits at the gossip gate with zero chain work.
 *
 * Failure classes are kept apart, mirroring the forward-gate's `reject`/`ignore` split:
 *   - gate `0n`, blamed on the sender → EVICT + cache the `reject` (the rule stands behind it:
 *                                   every honest verifier computes the same score, so terminal).
 *   - gate `0n`, blamed on nobody → "not yet", NOT "no": the item is re-examined until a grace
 *                                   window closes (verify/gate-grace.ts), then evicted
 *                                   `ignore`-class and uncached. A wallet that acquired the gate
 *                                   asset seconds ago scores `0n` only for whoever's head lags,
 *                                   so evicting on the spot would let RPC lag decide whether a
 *                                   vote counts.
 *   - name missing/mismatched     → EVICT, NOT cached (view-dependent `ignore`-class: v1
 *                                   resolves at head — see verify/bundle.ts step 4).
 *   - RPC / resolver THREW        → infra, nobody's verdict: the bundle STAYS pending, the
 *                                   round retries with capped full-jitter backoff, and
 *                                   `onError` surfaces the degraded state to the host
 *                                   (Contest `error`) so "RPC down" is not silent.
 *
 * Pure seams, no libp2p import — unit-testable offline like the rest of the engine.
 */

/** One provisionally admitted bundle awaiting its deferred checks. */
export interface PendingBundle {
    cid: CID;
    bundle: VotesBundle;
}

export interface BackgroundVerifierDeps {
    criteria: Criteria;
    registry: RuleRegistry;
    chainFor: (ticker: string) => ChainClient;
    bucketMath: BucketMath;
    nameResolvers: NameResolver[];
    /**
     * The gate rule's memo, handed to it as `ctx.cache` (rules/cache.ts). Shared with the inline
     * forward-gate verifier, so neither re-reads what the other settled.
     */
    ruleCache?: RuleCache;
    /**
     * This verifier's current head, handed to the rule as `ctx.head`. Resolved by the rule at
     * most once per batch, so a round stays batchable. Never called by a rule that scores pinned
     * historical state. Defaults to the rule chain's own `getBlockNumber()`; the voter injects
     * its coalesced reader.
     */
    readHead?: (args: { chain: ChainClient }) => Promise<{ block: number }>;
    /** Shared persistent name-resolution cache (pkc-js rule, 1h max-age); omitted ⇒ resolve live. */
    nameResolutionCache?: NameResolutionCache;
    /** The gate's per-CID verdict cache — a settled bundle's terminal verdict is stored here. */
    cache: VerdictCache;
    /** The bundle's gate read confirmed `> 0n` (flip `chainVerified`, kick the tally). */
    onGateVerified: (cid: CID) => void;
    /** The bundle's carried name resolved to its claimed publicKey (flip `nameResolved`). */
    onNameResolved: (cid: CID) => void;
    /** Remove a failed bundle from the working set (gate `0n`, or a name that did not check out). */
    onEvict: (cid: CID, verdict: VerifyFail) => void;
    /** An infra-class failure (RPC/resolver threw): the round will retry; surface the degradation. */
    onError: (error: unknown) => void;
    /** Concurrency cap for the un-batched fallbacks (per-wallet reads, name resolutions). */
    limit: <T>(fn: () => Promise<T>) => Promise<T>;
    /** Infra-retry backoff base / cap (ms). Full-jittered exponential between rounds. */
    retryBaseMs?: number;
    retryCapMs?: number;
    /**
     * Grace / re-examination interval (ms) — how long a `0n` the rule blamed on nobody is
     * treated as "not yet" before the bundle is dropped, and how often it is looked at in the
     * meantime. Defaults to {@link GATE_GRACE_MS} / {@link GATE_RETRY_MS}; overridable so tests
     * do not sit through the real window. Unused when the rule blames the sender.
     */
    gateGraceMs?: number;
    gateRetryMs?: number;
}

export interface BackgroundChainVerifier {
    /** Queue provisionally admitted bundles and return immediately; the drain runs detached. */
    enqueue(entries: PendingBundle[]): void;
    /** Bundles whose deferred checks have not settled yet (queued, in-flight, or awaiting retry). */
    pendingCount(): number;
    /** Resolves once every queued bundle has settled and no retry is armed (tests/introspection). */
    idle(): Promise<void>;
    /** Clear the retry timer (topic leave / voter destroy). Pending state is kept for `resume`. */
    stop(): void;
    /** Re-kick the drain after `stop()` if anything is still pending (topic re-join). */
    resume(): void;
}

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;

/** Internal queue item: `gateDone`/`ruleScore` survive an infra retry so no stage re-runs. */
interface QueueItem extends PendingBundle {
    gateDone: boolean;
    /** True once `onGateVerified` fired, so a name-stage retry does not re-notify. */
    gateNotified: boolean;
    ruleScore: bigint;
    resolvedNames: Record<string, string>;
    /** The rule's verdict on whether its `0n` may be blamed on the sender (RuleResult.penalize). */
    gatePenalize: boolean;
    /**
     * `Date.now()` when this item was first enqueued — the clock for the grace window (see
     * verify/gate-grace.ts). Only read when a gate scores `0n` and blames nobody for it.
     */
    queuedAt: number;
}

export function makeBackgroundVerifier(deps: BackgroundVerifierDeps): BackgroundChainVerifier {
    const { criteria, registry, chainFor, bucketMath, nameResolvers, nameResolutionCache, cache, limit } = deps;
    const retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
    const retryCapMs = deps.retryCapMs ?? RETRY_CAP_MS;
    const gateGraceMs = deps.gateGraceMs ?? GATE_GRACE_MS;
    const gateRetryMs = deps.gateRetryMs ?? GATE_RETRY_MS;

    // Resolve the gate `rule`, its options, and its chain once (same shape as verify/bundle.ts).
    // The re-binding after the guard keeps the non-undefined narrowing inside the closures below.
    const maybeRule = registry[criteria.rule.type];
    if (!maybeRule) throw new UnknownRuleError("rule", criteria.rule.type);
    const rule = maybeRule;
    const ruleOptions = rule.optionsSchema.parse(criteria.rule);
    const ruleChain = chainFor(tickerForRef(criteria, criteria.rule, ruleOptions));
    const readHead = deps.readHead ?? (async ({ chain }: { chain: ChainClient }) => ({ block: Number(await chain.getBlockNumber()) }));
    const ctx = {
        chain: ruleChain,
        head: () => readHead({ chain: ruleChain }),
        cache: deps.ruleCache ?? makeMemoryRuleCache()
    };

    const queue: QueueItem[] = [];
    /** CIDs queued or in-flight, so a re-chased root cannot double-verify a bundle. */
    const inFlight = new Set<string>();
    let draining = false;
    let stopped = false;
    /** Consecutive infra-failed rounds, driving the backoff exponent. */
    let failedRounds = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const idleResolvers: Array<() => void> = [];

    function settle(item: QueueItem): void {
        inFlight.delete(item.cid.toString());
    }

    function maybeResolveIdle(): void {
        if (queue.length === 0 && !draining && retryTimer === undefined) {
            for (const resolve of idleResolvers.splice(0)) resolve();
        }
    }

    /** The wallet's gate score at its bundle's bucket sample block. */
    function sampleBlockFor(bundle: VotesBundle): number {
        return bucketMath.sampleBlockForBucket(bucketMath.bucketForBlock(bundle.blockNumber));
    }

    /**
     * Gate stage for one round's batch: hand every not-yet-gated wallet to the rule at once —
     * `evaluateMany` when it has one, `limit`-bounded per-wallet `evaluate` otherwise — and
     * record each score with the rule's own verdict on whether a `0n` is attributable.
     *
     * No grouping and no cache lookups here any more: which block each wallet is read at, and
     * what may be memoized under which key, are the rule's decisions (rules/types.ts,
     * rules/cache.ts). Duplicate wallets are still collapsed before the call, because that is a
     * property of THIS batch rather than of any rule. Throws on the FIRST infra failure: the
     * round's unfinished items are re-queued by the caller.
     */
    async function gateStage(items: QueueItem[]): Promise<void> {
        const pending = items.filter((item) => !item.gateDone);
        if (pending.length === 0) return;

        const wallets: RuleWallet[] = [];
        const at = new Map<string, number>();
        for (const item of pending) {
            const wallet = { address: item.bundle.address, sampleBlock: sampleBlockFor(item.bundle) };
            const key = `${wallet.address.toLowerCase()}:${wallet.sampleBlock}`;
            if (at.has(key)) continue;
            at.set(key, wallets.length);
            wallets.push(wallet);
        }

        const results = rule.evaluateMany
            ? (await rule.evaluateMany({ options: ruleOptions, wallets, ctx })).results
            : await Promise.all(wallets.map((wallet) => limit(() => rule.evaluate({ options: ruleOptions, wallet, ctx }))));

        for (const item of pending) {
            const key = `${item.bundle.address.toLowerCase()}:${sampleBlockFor(item.bundle)}`;
            const result = results[at.get(key)!]!;
            item.ruleScore = result.score;
            item.gatePenalize = result.penalize !== false;
            item.gateDone = true;
        }
    }

    /**
     * Settle one gate-passed item's name checks. Resolutions are deduped per round via
     * `resolutions`. Returns "verified" | "evicted"; throws on a resolver infra failure
     * (the caller re-queues the item — its `gateDone` survives, so only names re-run).
     */
    async function nameStage(
        item: QueueItem,
        resolutions: Map<string, Promise<{ publicKey: string } | undefined>>
    ): Promise<"verified" | "evicted"> {
        for (const v of item.bundle.votes) {
            const name = v.community.name;
            if (!name || item.resolvedNames[name]) continue;
            const resolver = nameResolvers.find((r) => r.canResolve({ name }));
            if (!resolver) {
                // `ignore`-class, view-dependent (a missing resolver differs per verifier) — evict,
                // never cache (see verify/bundle.ts step 4).
                deps.onEvict(item.cid, { valid: false, disposition: "ignore", reason: `no resolver handles community name "${name}"` });
                return "evicted";
            }
            let resolution = resolutions.get(name);
            if (!resolution) {
                resolution = limit(() => resolveNameThroughCache({ resolver, name, cache: nameResolutionCache }));
                resolutions.set(name, resolution);
            }
            const record = await resolution;
            if (!record) {
                deps.onEvict(item.cid, { valid: false, disposition: "ignore", reason: `community name "${name}" does not resolve` });
                return "evicted";
            }
            if (record.publicKey !== v.community.publicKey) {
                deps.onEvict(item.cid, {
                    valid: false,
                    disposition: "ignore",
                    reason: `community name "${name}" resolves to ${record.publicKey}, not the claimed ${v.community.publicKey}`
                });
                return "evicted";
            }
            item.resolvedNames[name] = record.publicKey;
        }
        return "verified";
    }

    /** One drain round over everything currently queued. Re-queues + backs off on infra failure. */
    async function round(): Promise<void> {
        const batch = queue.splice(0);
        const requeue: QueueItem[] = [];
        /** Unattributable `0n` items still inside their grace window: re-examined, not a failure. */
        const notYet: QueueItem[] = [];
        let infraError: unknown;

        // Gate stage first, whole batch: this is where batching wins (one multicall per sample
        // block instead of one read per wallet). An infra throw leaves every un-gated item intact.
        try {
            await gateStage(batch);
        } catch (error) {
            infraError = error;
        }

        const resolutions = new Map<string, Promise<{ publicKey: string } | undefined>>();
        for (const item of batch) {
            if (!item.gateDone) {
                requeue.push(item); // gate read never happened (infra) — retry the whole item
                continue;
            }
            if (item.ruleScore === 0n) {
                if (item.gatePenalize) {
                    // Provable, deterministic reject — safe to cache so a re-publish short-circuits.
                    const verdict: VerifyFail = {
                        valid: false,
                        disposition: "reject",
                        reason: `not admitted: rule score is 0n`
                    };
                    cache.set(item.cid, verdict);
                    deps.onEvict(item.cid, verdict);
                    settle(item);
                    continue;
                }
                // The rule declined to blame anyone (see rules/types.ts, RuleResult.penalize):
                // `0n` means "not yet", not "no". The wallet may have acquired the gate asset in
                // a block this verifier has not seen, or may acquire it a moment from now — a
                // client that signs the instant it mints races its own transaction. Evicting here
                // would make whether a vote counts depend on whose RPC was a few blocks ahead, so
                // the item is re-examined until the grace window closes; only then is it dropped,
                // `ignore`-class and UNCACHED, so a later re-publish is judged fresh.
                // Re-examining is nearly free: while the rule's own memo holds, its re-read comes
                // straight from that cache and touches no chain (see verify/gate-grace.ts).
                if (Date.now() - item.queuedAt < gateGraceMs) {
                    item.gateDone = false;
                    notYet.push(item);
                    continue;
                }
                const verdict: VerifyFail = {
                    valid: false,
                    disposition: "ignore",
                    reason: `not admitted: rule score is 0n, and still 0n after the grace window`
                };
                deps.onEvict(item.cid, verdict);
                settle(item);
                continue;
            }
            if (!item.gateNotified) {
                item.gateNotified = true;
                deps.onGateVerified(item.cid);
            }
            try {
                if ((await nameStage(item, resolutions)) === "evicted") {
                    settle(item);
                    continue;
                }
            } catch (error) {
                infraError = error;
                requeue.push(item); // gateDone survives — the retry only re-runs names
                continue;
            }
            if (item.bundle.votes.some((v) => v.community.name)) deps.onNameResolved(item.cid);
            // Fully settled: store the terminal valid verdict (same shape the forward-gate caches).
            cache.set(item.cid, { valid: true, ruleScore: item.ruleScore, resolvedNames: item.resolvedNames });
            settle(item);
        }

        if (requeue.length > 0) {
            queue.push(...requeue, ...notYet);
            failedRounds += 1;
            deps.onError(infraError);
            armRetry();
        } else if (notYet.length > 0) {
            // "Not yet" is nobody's failure: no `onError`, no backoff escalation, just a fixed
            // re-examination interval until the grace window closes or the wallet's holding
            // shows up. Counting it as a failed round would exponentially back off the ONE
            // thing that needs a steady cadence.
            queue.push(...notYet);
            failedRounds = 0;
            armRetry(gateRetryMs);
        } else {
            failedRounds = 0;
        }
    }

    function armRetry(fixedDelayMs?: number): void {
        if (stopped || retryTimer !== undefined) return;
        const ceiling = Math.min(retryCapMs, retryBaseMs * 2 ** (failedRounds - 1));
        const timer = setTimeout(() => {
            retryTimer = undefined;
            kickDrain();
        }, fixedDelayMs ?? Math.random() * ceiling);
        (timer as { unref?: () => void }).unref?.();
        retryTimer = timer;
    }

    function kickDrain(): void {
        if (draining || stopped || queue.length === 0) {
            maybeResolveIdle();
            return;
        }
        draining = true;
        void (async () => {
            try {
                // A round that infra-fails re-queues and arms the retry timer instead of spinning.
                while (queue.length > 0 && !stopped && retryTimer === undefined) await round();
            } finally {
                draining = false;
                maybeResolveIdle();
            }
        })();
    }

    return {
        enqueue(entries: PendingBundle[]): void {
            for (const entry of entries) {
                const key = entry.cid.toString();
                if (inFlight.has(key)) continue;
                inFlight.add(key);
                queue.push({
                    ...entry,
                    gateDone: false,
                    gateNotified: false,
                    ruleScore: 0n,
                    gatePenalize: true,
                    resolvedNames: {},
                    queuedAt: Date.now()
                });
            }
            kickDrain();
        },
        pendingCount(): number {
            return inFlight.size;
        },
        idle(): Promise<void> {
            if (queue.length === 0 && !draining && retryTimer === undefined) return Promise.resolve();
            return new Promise((resolve) => idleResolvers.push(resolve));
        },
        stop(): void {
            stopped = true;
            if (retryTimer !== undefined) clearTimeout(retryTimer);
            retryTimer = undefined;
            maybeResolveIdle();
        },
        resume(): void {
            stopped = false;
            kickDrain();
        }
    };
}
