import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import type { Criteria } from "../schema/criteria.js";
import type { RuleRegistry, RuleResult, RuleWallet } from "../rules/types.js";
import type { ChainClient, BucketMath, NameResolver } from "../chain/types.js";
import type { RuleCache } from "../rules/cache.js";
import { GATE_GRACE_MS, GATE_RETRY_MS } from "./gate-grace.js";
import { dedupeLeaves, evaluateGate, gateBlame, gatePenalize, gateReason, resolveGate, type GateResult } from "../rules/gate.js";
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
 *                                   (Contest `error`) so "RPC down" is not silent — once per
 *                                   round, and for a gate read as soon as it throws rather
 *                                   than at the end of the round. Only the bundles whose read
 *                                   threw stay behind: a batched read that throws is asked
 *                                   again in smaller pieces (see `ask`), so a read that can
 *                                   never succeed for ONE wallet does not hold the rest. That
 *                                   costs a few call times, not one call per pending bundle,
 *                                   whether the RPC is down, answers again a moment later, or
 *                                   fails one wallet. A pending bundle the host no longer
 *                                   holds (`isAdmitted`) is dropped without a verdict — the
 *                                   exit for one whose read keeps failing until it expires.
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
    /** The contest's one chain client — every rule reads it (DESIGN.md "One clock"). */
    chain: ChainClient;
    bucketMath: BucketMath;
    nameResolvers: NameResolver[];
    /**
     * One memo per gate leaf, in `gateLeaves` order, handed to each rule as `ctx.cache`
     * (rules/cache.ts). Shared with the inline forward-gate verifier, so neither re-reads what
     * the other settled.
     */
    ruleCaches?: readonly RuleCache[];
    /**
     * This verifier's current head, handed to the rule as `ctx.head`. Resolved by the rule at
     * most once per batch, so a round stays batchable. Never called by a rule that scores pinned
     * historical state. Defaults to the contest chain's own `getBlockNumber()`; the voter injects
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
    /**
     * An infra-class failure (RPC/resolver threw): the round will retry; surface the degradation.
     * Also receives what one of the callbacks above threw — reported, never allowed to unwind a
     * round. A throw from this callback itself is swallowed.
     */
    onError: (error: unknown) => void;
    /**
     * Does the host still hold this bundle (it was not evicted, superseded or expired since it
     * was queued)? Checked at the start of every round; a bundle it no longer holds leaves the
     * queue with no callback and no cached verdict. Omitted ⇒ every queued bundle is held.
     */
    isAdmitted?: (cid: CID) => boolean;
    /** Concurrency cap for the un-batched fallbacks (per-wallet reads, name resolutions). */
    limit: <T>(fn: () => Promise<T>) => Promise<T>;
    /**
     * How many calls `limit` runs at once: how many wallets of a failed batched read are asked
     * alone, and into how many parts the rest are split. Defaults to {@link LIMIT_CONCURRENCY}.
     */
    limitConcurrency?: number;
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
const LIMIT_CONCURRENCY = 8;

/**
 * One wallet's answer to one gate question: the rule's result, or why there is none. `alone` is
 * true when the read that threw asked about this wallet only, so the failure is its own rather
 * than a batch's it was part of (or of a re-ask it never got).
 */
type Answer = { result: RuleResult } | { error: unknown; alone: boolean };

/** Internal queue item: `gateDone`/`gate` survive an infra retry so no stage re-runs. */
interface QueueItem extends PendingBundle {
    gateDone: boolean;
    /**
     * True once `onGateVerified` fired, so a name-stage retry does not re-notify. Cleared when the
     * same CID is enqueued again while this item is in flight (see `enqueue`).
     */
    gateNotified: boolean;
    /**
     * This item's place in line for the re-asks of a failed batch (see `ask`): a number drawn
     * from one counter when it is queued, and drawn again each time its wallet is asked about
     * alone and the read throws. gateStage lists items by it, so the wallets asked alone first
     * are those that have waited longest since they were last asked alone. A wallet whose read
     * throws goes behind every other pending item, bundles queued meanwhile included, so a run
     * of bad wallets cannot end the re-asks round after round, and an item waits at most one
     * extra round per `limitConcurrency` items ahead of it, however many arrive in the meantime.
     */
    turn: number;
    resolvedNames: Record<string, string>;
    /**
     * The folded gate tree for this wallet, or `undefined` before the gate stage ran. Carries
     * every leaf's answer, so the reason, the blame set and the penalize decision are all read
     * off the one structure (rules/gate.ts) rather than recomputed per call site.
     */
    gate: GateResult | undefined;
    /**
     * `Date.now()` when this item was first enqueued — the clock for the grace window (see
     * verify/gate-grace.ts). Only read when the gate fails and blames nobody for it.
     */
    queuedAt: number;
}

export function makeBackgroundVerifier(deps: BackgroundVerifierDeps): BackgroundChainVerifier {
    const { criteria, registry, chain, bucketMath, nameResolvers, nameResolutionCache, cache, limit } = deps;
    const retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
    const retryCapMs = deps.retryCapMs ?? RETRY_CAP_MS;
    const gateGraceMs = deps.gateGraceMs ?? GATE_GRACE_MS;
    const gateRetryMs = deps.gateRetryMs ?? GATE_RETRY_MS;
    const wave = deps.limitConcurrency ?? LIMIT_CONCURRENCY;

    // Resolve every gate leaf — rule, options, chain, memo — once (same call as verify/bundle.ts,
    // so the two verifiers cannot resolve a gate differently).
    const readHead = deps.readHead ?? (async ({ chain: client }: { chain: ChainClient }) => ({ block: Number(await client.getBlockNumber()) }));
    const leaves = resolveGate({ criteria, registry, chain, readHead, caches: deps.ruleCaches });
    // Which leaves ask the same question: a rule named twice in one gate is batched once.
    const { representatives, ofLeaf } = dedupeLeaves(leaves);

    const queue: QueueItem[] = [];
    /** Items queued or in-flight, by CID, so a re-chased root cannot double-verify a bundle. */
    const inFlight = new Map<string, QueueItem>();
    let draining = false;
    let stopped = false;
    /** Consecutive infra-failed rounds, driving the backoff exponent. */
    let failedRounds = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /** The running round already surfaced an infra failure: one report per round. */
    let infraReported = false;
    /** The next {@link QueueItem.turn}. */
    let turns = 0;
    const idleResolvers: Array<() => void> = [];

    function settle(item: QueueItem): void {
        inFlight.delete(item.cid.toString());
    }

    function maybeResolveIdle(): void {
        if (queue.length === 0 && !draining && retryTimer === undefined) {
            for (const resolve of idleResolvers.splice(0)) resolve();
        }
    }

    /**
     * Run a host callback. The voter's callbacks call host listeners synchronously, and a throw
     * from one must not unwind a round half-way: it is reported, and the round carries on.
     */
    function notify(callback: () => void): void {
        try {
            callback();
        } catch (error) {
            report(error);
        }
    }

    /** Surface an error through `onError` — host code too, so its own throw is swallowed. */
    function report(error: unknown): void {
        try {
            deps.onError(error);
        } catch {
            // Nowhere left to report it, and the verifier's own state is already consistent.
        }
    }

    /**
     * Surface the running round's infra failure the moment it happens: the round goes on (the
     * re-asks of a failed batch, then the name checks), and a down RPC must not stay silent
     * meanwhile.
     */
    function reportInfra(error: unknown): void {
        if (infraReported) return;
        infraReported = true;
        report(error);
    }

    /** The wallet's gate score at its bundle's bucket sample block. */
    function sampleBlockFor(bundle: VotesBundle): number {
        return bucketMath.sampleBlockForBucket(bucketMath.bucketForBlock(bundle.blockNumber));
    }

    /**
     * Gate stage for one round's batch: hand every not-yet-gated wallet to EACH gate leaf at once
     * — `evaluateMany` when the rule has one, `limit`-bounded per-wallet `evaluate` otherwise —
     * then fold each item's leaf answers into its verdict.
     *
     * Note this deliberately does NOT short-circuit the tree the way the inline gate does. Here
     * the axis of batching is the rule, not the wallet: one `evaluateMany` per leaf covers the
     * whole round, so scoring every leaf costs one round trip per leaf no matter how many wallets
     * are pending, while short-circuiting per wallet would fragment those batches into
     * per-wallet reads. Collecting all is the cheaper shape on this path, and it is also what
     * gives every item a complete blame set.
     *
     * No grouping and no cache lookups here: which block each wallet is read at, and what may be
     * memoized under which key, are the rule's decisions (rules/types.ts, rules/cache.ts).
     * Duplicate wallets are still collapsed before the calls, because that is a property of THIS
     * batch rather than of any rule. An item whose wallet's read threw on ANY leaf is left
     * un-gated for the caller to re-queue (an unreadable leaf is not an answer); every other item
     * is gated. Returns the first such infra failure, if any.
     */
    async function gateStage(items: QueueItem[]): Promise<{ error: unknown } | undefined> {
        const pending = items.filter((item) => !item.gateDone);
        if (pending.length === 0) return undefined;
        // In line for the re-asks of a failed batch (`ask`): longest wait since asked alone first.
        pending.sort((a, b) => a.turn - b.turn);

        const wallets: RuleWallet[] = [];
        const at = new Map<string, number>();
        for (const item of pending) {
            const wallet = { address: item.bundle.address, sampleBlock: sampleBlockFor(item.bundle) };
            const key = `${wallet.address.toLowerCase()}:${wallet.sampleBlock}`;
            if (at.has(key)) continue;
            at.set(key, wallets.length);
            wallets.push(wallet);
        }

        // One batched call per distinct QUESTION, those in parallel: each is a single multicall
        // for the whole round, and the voter's per-client in-flight budget still bounds what
        // reaches an RPC. A rule named twice in one gate ("any two of these three") is asked once
        // and its answer fanned back out to both positions.
        const byQuestion: Answer[][] = await Promise.all(representatives.map((leaf) => ask(leaf, wallets)));

        let failure: { error: unknown } | undefined;
        for (const item of pending) {
            const wallet = at.get(`${item.bundle.address.toLowerCase()}:${sampleBlockFor(item.bundle)}`)!;
            const results: RuleResult[] = [];
            let failedAlone = false;
            for (const answers of byQuestion) {
                const answer = answers[wallet]!;
                if ("result" in answer) {
                    results.push(answer.result);
                    continue;
                }
                failure ??= answer;
                failedAlone ||= answer.alone;
            }
            if (results.length < byQuestion.length) {
                if (failedAlone) item.turn = turns++; // to the back of the line
                continue; // a read never happened: no verdict
            }
            // Every leaf is already scored, so this "evaluation" reads the batch — no chain work.
            item.gate = await evaluateGate({
                node: criteria.gate,
                evaluate: async (leaf) => results[ofLeaf[leaf]!]!,
                collectAll: true
            });
            item.gateDone = true;
        }
        return failure;
    }

    /**
     * Ask one gate question about `wallets`, answering per wallet. A batched call is
     * all-or-nothing, so when it throws, `isolate` asks again in smaller pieces (still
     * `limit`-bounded, and still coalesced below the rule): a read that can never succeed for ONE
     * wallet — a pinned block the gateway cannot serve, say — then fails that wallet alone
     * instead of every bundle in the round, round after round.
     */
    async function ask(leaf: number, wallets: RuleWallet[]): Promise<Answer[]> {
        const { rule, options, ctx } = leaves[leaf]!;
        const alone = async (read: () => Promise<RuleResult>): Promise<Answer> => {
            try {
                return { result: await limit(read) };
            } catch (error) {
                reportInfra(error);
                return { error, alone: true };
            }
        };
        if (!rule.evaluateMany) return Promise.all(wallets.map((wallet) => alone(() => rule.evaluate({ options, wallet, ctx }))));
        // Called on `rule`, never detached: a rule may rely on `this` (issue #29).
        const many = (batch: RuleWallet[]) => rule.evaluateMany!({ options, wallets: batch, ctx });

        /**
         * Answer per wallet for `group`, whose batched read just threw `error`. Its first
         * `limitConcurrency` wallets are asked alone, in `group` order. If every one of those
         * throws as well, that is what a down RPC looks like: the rest are not asked this round,
         * because asking them would add a failing call per pending bundle to every round and
         * stretch it by the backlog. If gateStage's order put bad wallets there instead, they go
         * to the back of the line, and the next round asks the next ones. Otherwise the RPC
         * answers, and the batch threw for one of its wallets or for a blip: the rest are asked
         * again in `limitConcurrency` parts, and a part that throws is isolated the same way. A
         * blip then costs two more call times, and one wallet whose read always throws about two
         * call times per eight-fold split of the batch (6 for 200 wallets, 7 for 1000).
         */
        const isolate = async (group: RuleWallet[], error: unknown): Promise<Answer[]> => {
            if (group.length === 1) return [{ error, alone: true }];
            const first = await Promise.all(group.slice(0, wave).map((wallet) => alone(async () => (await many([wallet])).results[0]!)));
            const rest = group.slice(wave);
            if (first.every((answer) => "error" in answer)) return [...first, ...rest.map((): Answer => ({ error, alone: false }))];
            const size = Math.ceil(rest.length / wave);
            const parts: RuleWallet[][] = [];
            for (let start = 0; start < rest.length; start += size) parts.push(rest.slice(start, start + size));
            const answered = await Promise.all(
                parts.map(async (part): Promise<Answer[]> => {
                    try {
                        const { results } = await limit(() => many(part));
                        return results.map((result) => ({ result }));
                    } catch (failure) {
                        return isolate(part, failure); // the round already reported its first throw
                    }
                })
            );
            return [...first, ...answered.flat()];
        };

        try {
            const { results } = await many(wallets);
            return results.map((result) => ({ result }));
        } catch (error) {
            reportInfra(error); // now, before the re-asks: with the RPC down they all fail too
            return isolate(wallets, error);
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
                notify(() => deps.onEvict(item.cid, { valid: false, disposition: "ignore", reason: `no resolver handles community name "${name}"` }));
                return "evicted";
            }
            let resolution = resolutions.get(name);
            if (!resolution) {
                resolution = limit(() => resolveNameThroughCache({ resolver, name, cache: nameResolutionCache }));
                resolutions.set(name, resolution);
            }
            const record = await resolution;
            if (!record) {
                notify(() => deps.onEvict(item.cid, { valid: false, disposition: "ignore", reason: `community name "${name}" does not resolve` }));
                return "evicted";
            }
            if (record.publicKey !== v.community.publicKey) {
                notify(() =>
                    deps.onEvict(item.cid, {
                        valid: false,
                        disposition: "ignore",
                        reason: `community name "${name}" resolves to ${record.publicKey}, not the claimed ${v.community.publicKey}`
                    })
                );
                return "evicted";
            }
            item.resolvedNames[name] = record.publicKey;
        }
        return "verified";
    }

    /** One drain round over everything currently queued. Re-queues + backs off on infra failure. */
    async function round(): Promise<void> {
        infraReported = false;
        const batch: QueueItem[] = [];
        for (const item of queue.splice(0)) {
            // The host dropped it while it waited (expired, superseded, evicted): nothing to settle.
            if (deps.isAdmitted && !deps.isAdmitted(item.cid)) settle(item);
            else batch.push(item);
        }
        const requeue: QueueItem[] = [];
        /** Unattributable `0n` items still inside their grace window: re-examined, not a failure. */
        const notYet: QueueItem[] = [];
        let infraError: unknown;

        // Gate stage first, whole batch: this is where batching wins (one multicall per sample
        // block instead of one read per wallet). A failed read leaves its items un-gated, intact.
        const failed = await gateStage(batch);
        if (failed) infraError = failed.error;

        const resolutions = new Map<string, Promise<{ publicKey: string } | undefined>>();
        for (const item of batch) {
            if (!item.gateDone) {
                requeue.push(item); // gate read never happened (infra) — retry the whole item
                continue;
            }
            if (item.gate !== undefined && item.gate.satisfied !== true) {
                // The rules' own wording, narrowed to the failures that explain the refusal, plus
                // the recursive answer to "may this be blamed on the sender" (rules/gate.ts).
                const failures = gateBlame(item.gate).map((leaf) => ({
                    type: leaves[leaf.leaf]!.ref.type,
                    error: leaf.error ?? ""
                }));
                const reason = gateReason(item.gate);
                if (gatePenalize(item.gate)) {
                    // Provable, deterministic reject — safe to cache so a re-publish short-circuits.
                    const verdict: VerifyFail = {
                        valid: false,
                        disposition: "reject",
                        reason: `not admitted: ${reason}`,
                        failures
                    };
                    cache.set(item.cid, verdict);
                    notify(() => deps.onEvict(item.cid, verdict));
                    settle(item);
                    continue;
                }
                // No failure the gate will blame anyone for (see rules/types.ts, RuleResult.penalize,
                // and rules/gate.ts for how that folds through `all`/`any`):
                // the failure means "not yet", not "no". The wallet may have acquired the asset in
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
                    reason: `not admitted: ${reason} (still true after the grace window)`,
                    failures
                };
                notify(() => deps.onEvict(item.cid, verdict));
                settle(item);
                continue;
            }
            if (!item.gateNotified) {
                item.gateNotified = true;
                notify(() => deps.onGateVerified(item.cid));
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
            // The CID was enqueued again while the names were awaited, so the host has recorded
            // its checks afresh: report the gate pass again (from the result already held).
            if (!item.gateNotified) {
                item.gateNotified = true;
                notify(() => deps.onGateVerified(item.cid));
            }
            if (item.bundle.votes.some((v) => v.community.name)) notify(() => deps.onNameResolved(item.cid));
            // Fully settled: store the terminal valid verdict (same shape the forward-gate caches).
            cache.set(item.cid, { valid: true, resolvedNames: item.resolvedNames });
            settle(item);
        }

        if (requeue.length > 0) {
            queue.push(...requeue, ...notYet);
            failedRounds += 1;
            reportInfra(infraError); // unless the gate stage already did
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
            } catch (error) {
                // Not a failed read (those never escape a round) but a throw from the verifier's
                // own bookkeeping, unwinding a round mid-batch. Only one round runs at a time, so
                // what is in flight but not queued is exactly what it took and had not settled:
                // put that back (`enqueue` would skip it forever) and back off like a failed round.
                const queued = new Set(queue);
                for (const item of inFlight.values()) if (!queued.has(item)) queue.push(item);
                failedRounds += 1;
                report(error);
                armRetry();
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
                const existing = inFlight.get(key);
                if (existing) {
                    // Already queued or in flight: verified once. But the caller is recording this
                    // bundle afresh (the same ballot re-signed in the same bucket is the same CID),
                    // which resets its checks to pending — so a gate pass already reported must
                    // be reported again. The gate itself is not re-read.
                    existing.gateNotified = false;
                    continue;
                }
                const item: QueueItem = {
                    ...entry,
                    gateDone: false,
                    gateNotified: false,
                    turn: turns++,
                    gate: undefined,
                    resolvedNames: {},
                    queuedAt: Date.now()
                };
                inFlight.set(key, item);
                queue.push(item);
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
