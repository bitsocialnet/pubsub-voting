import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import type { Criteria } from "../schema/criteria.js";
import type { RuleRegistry } from "../rules/types.js";
import type { ChainClient, BucketMath, NameResolver } from "../chain/types.js";
import { tickerForRef } from "../chain/ticker.js";
import { UnknownRuleError } from "../errors.js";
import type { GateResultCache } from "./gate-result-cache.js";
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
 * Batched, not sequential: a checkpoint's bundles share one bucket sample block, so the gate
 * stage groups pending wallets per sample block and prefers the rule's `evaluateMany` (one
 * multicall3 round trip for N wallets) over N serial `readContract` calls, falling back to
 * `limit`-bounded per-wallet reads for rules without a batched form. Results feed the shared
 * `(wallet, sampleBlock)` gate-result cache, and a settled bundle's terminal verdict feeds the
 * shared per-CID verdict cache — so a later re-publish of the same bundle short-circuits at
 * the gossip gate with zero chain work.
 *
 * Failure classes are kept apart, mirroring the forward-gate's `reject`/`ignore` split:
 *   - gate scores `0n`            → EVICT + cache the provable `reject` (deterministic).
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
    /** Shared `(wallet, sampleBlock)` gate scores — batch results land here, hits skip the read. */
    gateResultCache: GateResultCache;
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
}

export function makeBackgroundVerifier(deps: BackgroundVerifierDeps): BackgroundChainVerifier {
    const { criteria, registry, chainFor, bucketMath, nameResolvers, gateResultCache, nameResolutionCache, cache, limit } = deps;
    const retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
    const retryCapMs = deps.retryCapMs ?? RETRY_CAP_MS;

    // Resolve the gate `rule`, its options, and its chain once (same shape as verify/bundle.ts).
    // The re-binding after the guard keeps the non-undefined narrowing inside the closures below.
    const maybeRule = registry[criteria.rule.type];
    if (!maybeRule) throw new UnknownRuleError("rule", criteria.rule.type);
    const rule = maybeRule;
    const ruleOptions = rule.optionsSchema.parse(criteria.rule);
    const ruleChain = chainFor(tickerForRef(criteria, criteria.rule, ruleOptions));

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
     * Gate stage for one round's batch: group the not-yet-gated items per sample block, read the
     * distinct uncached wallets — `evaluateMany` when the rule has it, `limit`-bounded singles
     * otherwise — and feed every score into the shared gate-result cache. Throws on the FIRST
     * infra failure: the round's unfinished items are re-queued by the caller.
     */
    async function gateStage(items: QueueItem[]): Promise<void> {
        const groups = new Map<number, QueueItem[]>();
        for (const item of items) {
            if (item.gateDone) continue;
            const block = sampleBlockFor(item.bundle);
            groups.set(block, [...(groups.get(block) ?? []), item]);
        }
        for (const [sampleBlock, group] of groups) {
            const wallets: string[] = [];
            for (const item of group) {
                const wallet = item.bundle.address;
                if ((await gateResultCache.get(wallet, sampleBlock)) === undefined && !wallets.includes(wallet)) {
                    wallets.push(wallet);
                }
            }
            if (wallets.length > 0) {
                const ctx = { chain: ruleChain, blockNumber: sampleBlock };
                const results = rule.evaluateMany
                    ? await rule.evaluateMany({ options: ruleOptions, walletAddresses: wallets, ctx })
                    : await Promise.all(
                          wallets.map((walletAddress) => limit(() => rule.evaluate({ options: ruleOptions, walletAddress, ctx })))
                      );
                wallets.forEach((wallet, i) => gateResultCache.set(wallet, sampleBlock, results[i]!.score));
            }
            for (const item of group) {
                item.ruleScore = (await gateResultCache.get(item.bundle.address, sampleBlock))!;
                item.gateDone = true;
            }
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
                // Provable, deterministic reject — safe to cache so a re-publish short-circuits.
                const verdict: VerifyFail = {
                    valid: false,
                    disposition: "reject",
                    reason: `not admitted: rule score is 0n at block ${sampleBlockFor(item.bundle)}`
                };
                cache.set(item.cid, verdict);
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
            queue.push(...requeue);
            failedRounds += 1;
            deps.onError(infraError);
            armRetry();
        } else {
            failedRounds = 0;
        }
    }

    function armRetry(): void {
        if (stopped || retryTimer !== undefined) return;
        const ceiling = Math.min(retryCapMs, retryBaseMs * 2 ** (failedRounds - 1));
        const timer = setTimeout(() => {
            retryTimer = undefined;
            kickDrain();
        }, Math.random() * ceiling);
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
                queue.push({ ...entry, gateDone: false, gateNotified: false, ruleScore: 0n, resolvedNames: {} });
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
