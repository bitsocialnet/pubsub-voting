import pLimit from "p-limit";
import type { PeerId } from "@libp2p/interface";
import type { FetchServiceLike } from "../transport/types.js";
import {
    batchRootsFetchKey,
    decodeBatchRootsResponse,
    decodeRootRecord,
    rootFetchKey,
    MAX_BATCH_ROOT_KEYS,
    type FetchRootRecord
} from "../transport/messages.js";

/**
 * The cold-start root puller: the voter-wide seam every engine's cold-join pull goes through
 * (see DESIGN.md "Checkpoints"). One instance per voter, because everything it guards is
 * per-PEER, not per-topic:
 *
 *   - **Batching.** Pulls to the same peer that arrive within {@link BATCH_WINDOW_MS} coalesce
 *     into ONE fetch stream carrying a batch key ({@link batchRootsFetchKey}), so a directory-
 *     scale join pays the ~2-RTT multistream-select negotiation once per peer instead of once
 *     per contest. A single pending topic skips the batch key entirely (the common single-board
 *     case has zero new wire surface). A responder that predates the batch key answers
 *     NOT_FOUND (or garbage), and the puller falls back to today's per-topic keys.
 *   - **Budget.** At most {@link COLD_START_PEER_FETCH_LIMIT} concurrent fetch streams per peer
 *     across ALL contests, under libp2p's default per-protocol caps (32 inbound on the
 *     responder, 64 outbound on us — both enforced PER CONNECTION per direction, so one
 *     connection's budget is exactly the scope of the remote cap; other users of a shared
 *     seeder arrive on their own connections and do not eat these slots). 24 rather than the
 *     full 32 because running at the cliff still resets: our slot frees when the response
 *     lands, but the responder only decrements its count when it sees the stream *close*, so
 *     back-to-back reuse races that bookkeeping — and the same connection can carry fetch
 *     streams the budget cannot see (the host's own IPNS-over-pubsub record fetches ride the
 *     same protocol; so would a second voter on the shared node).
 *   - **Retry.** A THROWN fetch retries with full-jittered exponential backoff until
 *     {@link COLD_START_FETCH_DEADLINE_MS} — the safety net for a responder saturated by
 *     streams the budget cannot see. While the cap is saturated every freed slot is instantly
 *     retaken, so a fixed attempt count can lose the race and strand a board (measured: no
 *     retry → 32/63 boards converge; 5 fixed retries → 53/63; retry-to-deadline → 63/63). Only
 *     a throw retries — a definitive `undefined`/`null` ("no record") returns as-is — and a
 *     pull whose contest was torn down (`isLive()` false) abandons quietly. Each attempt (not
 *     the whole loop, so a backoff sleep never holds a slot) passes through the budget; queue
 *     wait counts against the same deadline.
 */
export interface RootPuller {
    /**
     * Pull one topic's root record from one peer: the decoded record, or `null`/`undefined`
     * ("no record", definitive), or a rejection (unreachable peer past the deadline, or a
     * garbage answer). `isLive` is polled between retries and before resolving, so a contest
     * left mid-pull abandons instead of holding work alive.
     */
    pull(peer: PeerId, topic: string, isLive: () => boolean): Promise<FetchRootRecord | null | undefined>;
}

/** See the budget note on {@link RootPuller}. */
export const COLD_START_PEER_FETCH_LIMIT = 24;
/** See the retry note on {@link RootPuller}. */
export const COLD_START_FETCH_DEADLINE_MS = 30_000;
const COLD_START_FETCH_BACKOFF_MS = 400;
const COLD_START_FETCH_BACKOFF_CAP_MS = 4_000;
/**
 * How long a peer's first pending pull waits for same-peer company before its batch flushes.
 * A directory join fires all its cold starts in one synchronous burst, so one tick would
 * usually do; a few ms of slack covers joins interleaved with per-contest async work (topic
 * hashing, chain-client setup) without adding perceptible latency to a lone join.
 */
const BATCH_WINDOW_MS = 20;

/** One waiter for one (peer, topic) pull. */
interface Waiter {
    isLive: () => boolean;
    resolve: (record: FetchRootRecord | null | undefined) => void;
    reject: (error: unknown) => void;
}

/** A peer's coalescing window: the topics waiting to ride one batch key. */
interface PendingBatch {
    peer: PeerId;
    topics: Map<string, Waiter[]>;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * One `pLimit(limitPerPeer)` per peer id, created on first use and dropped once its queue
 * drains, so a long-lived voter does not accumulate limiters for every peer it ever
 * cold-started against.
 */
function makePerPeerBudget(limitPerPeer: number): <T>(peerId: string, task: () => Promise<T>) => Promise<T> {
    const limiters = new Map<string, ReturnType<typeof pLimit>>();
    return async (peerId, task) => {
        let limiter = limiters.get(peerId);
        if (limiter === undefined) {
            limiter = pLimit(limitPerPeer);
            limiters.set(peerId, limiter);
        }
        try {
            return await limiter(task);
        } finally {
            if (limiter.activeCount === 0 && limiter.pendingCount === 0) limiters.delete(peerId);
        }
    };
}

/** Build the voter-wide puller over the host's fetch service. */
export function makeRootPuller(fetch: FetchServiceLike): RootPuller {
    const budget = makePerPeerBudget(COLD_START_PEER_FETCH_LIMIT);
    const pending = new Map<string, PendingBatch>();

    /** One budgeted+retried fetch of one key (see the retry note on {@link RootPuller}). */
    const fetchWithRetry = async (peer: PeerId, key: string, isLive: () => boolean): Promise<Uint8Array | undefined | null> => {
        const deadline = Date.now() + COLD_START_FETCH_DEADLINE_MS;
        let lastError: unknown;
        for (let attempt = 0; ; attempt++) {
            if (attempt > 0) {
                if (!isLive() || Date.now() >= deadline) break; // left or out of time
                const ceiling = Math.min(COLD_START_FETCH_BACKOFF_CAP_MS, COLD_START_FETCH_BACKOFF_MS * 2 ** (attempt - 1));
                await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
                if (!isLive()) return undefined; // left mid-backoff — abandon quietly
            }
            try {
                return await budget(peer.toString(), () => fetch.fetch(peer, key));
            } catch (error) {
                lastError = error; // transient (e.g. responder over its inbound-stream cap) — back off and retry
            }
        }
        throw lastError;
    };

    /** The per-topic path: today's `<topic>/root` key; a garbage answer rejects the waiters. */
    const pullSingle = async (peer: PeerId, topic: string, waiters: Waiter[]): Promise<void> => {
        try {
            const value = await fetchWithRetry(peer, rootFetchKey(topic), () => waiters.some((w) => w.isLive()));
            const record = value === undefined || value === null ? value : decodeRootRecord(value);
            waiters.forEach((w) => w.resolve(record));
        } catch (error) {
            waiters.forEach((w) => w.reject(error));
        }
    };

    /**
     * The batch path: one stream, one key carrying every pending topic, answers distributed by
     * request order. NOT_FOUND (a responder without the batch key), a malformed response, or a
     * length mismatch all degrade to the per-topic path — never to silence.
     */
    const pullBatch = async (peer: PeerId, topics: Map<string, Waiter[]>): Promise<void> => {
        const order = [...topics.keys()];
        const isLive = (): boolean => [...topics.values()].some((waiters) => waiters.some((w) => w.isLive()));
        try {
            const value = await fetchWithRetry(peer, batchRootsFetchKey(order), isLive);
            if (value !== undefined && value !== null) {
                let records: (FetchRootRecord | null)[] | undefined;
                try {
                    records = decodeBatchRootsResponse(value);
                } catch {
                    records = undefined; // hostile/buggy answer — fall through to per-topic
                }
                if (records !== undefined && records.length === order.length) {
                    order.forEach((topic, i) => topics.get(topic)!.forEach((w) => w.resolve(records[i] ?? null)));
                    return;
                }
            }
            // Old responder (NOT_FOUND) or malformed batch answer: degrade to per-topic keys.
            await Promise.all([...topics.entries()].map(([topic, waiters]) => pullSingle(peer, topic, waiters)));
        } catch (error) {
            for (const waiters of topics.values()) waiters.forEach((w) => w.reject(error));
        }
    };

    const flush = (peerId: string): void => {
        const batch = pending.get(peerId);
        if (batch === undefined) return;
        pending.delete(peerId);
        clearTimeout(batch.timer);
        // A lone topic keeps today's per-topic key — no batch envelope for the common
        // single-board join; two or more ride one batch stream.
        if (batch.topics.size === 1) {
            for (const [topic, waiters] of batch.topics) void pullSingle(batch.peer, topic, waiters);
        } else {
            void pullBatch(batch.peer, batch.topics);
        }
    };

    return {
        pull: (peer, topic, isLive) =>
            new Promise((resolve, reject) => {
                const peerId = peer.toString();
                let batch = pending.get(peerId);
                if (batch === undefined) {
                    const timer = setTimeout(() => flush(peerId), BATCH_WINDOW_MS);
                    (timer as { unref?: () => void }).unref?.();
                    batch = { peer, topics: new Map(), timer };
                    pending.set(peerId, batch);
                }
                const waiters = batch.topics.get(topic) ?? [];
                waiters.push({ isLive, resolve, reject });
                batch.topics.set(topic, waiters);
                // A full batch flushes immediately; the next pull opens a fresh window.
                if (batch.topics.size >= MAX_BATCH_ROOT_KEYS) flush(peerId);
            })
    };
}
