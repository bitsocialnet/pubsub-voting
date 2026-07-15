import type { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
import type { BlockSessionLike } from "./types.js";
import type { VotesBundle } from "../schema/votes.js";
import { decodeCheckpoint } from "../checkpoint/codec.js";
import { encodeBundle, bundleCidForBytes } from "../crdt/codec.js";
import type { VerdictCache } from "../verify/cache.js";
import type { VerifyResult } from "../verify/types.js";
import type { PendingBundle } from "../verify/background.js";

/**
 * The divergence chase: act on an advertised checkpoint root that differs from our own (a
 * heartbeat or fetch-protocol hint — see DESIGN.md "Checkpoints", "Block pull"). Pull the
 * blocks behind the root by CID — through a bitswap session seeded with the root's advertisers
 * when the `openSession` seam is present (targeted wants, one provider lookup per root), the
 * broadcast `getBlock` otherwise or on session failure — and admit each inlined bundle in two
 * stages:
 *
 *   1. **Offline, synchronous, before admit** (µs each): signature + criteria constraints via
 *      `verifyOffline` — a forged or malformed bundle dies here and is never admitted.
 *   2. **Network, deferred**: the on-chain gate read and name resolution run in the background
 *      chain verifier (`deferVerify`, one batch per chased root so the gate reads batch into
 *      as few RPC round trips as the rule allows), which confirms or evicts each bundle after
 *      the fact. This is what keeps a cold join non-blocking: a 100-vote checkpoint admits in
 *      milliseconds instead of serializing 100 chain reads (see DESIGN.md "Background chain
 *      verification").
 *
 * So a single liar cannot inject a forged vote (offline check) nor hide an honest one
 * (union-only merge); an *ineligible-wallet* bundle it injects is admitted provisionally,
 * surfaces only as a `chainVerified: false` tally row, is never re-served in our checkpoint,
 * and is evicted as soon as its batched gate read lands.
 *
 * Bounded like everything at the gate: a shared concurrency cap (`limit`), a per-root
 * deadline whose `AbortSignal` cancels in-flight block wants, and in-flight dedup so a spray
 * of the same root queues one chase, not many. A failed chase (unfetchable blocks, malformed
 * chunks, all-invalid bundles) contributes nothing and throws nothing — the hint was never
 * trusted. No libp2p import; pure seams, unit-testable offline.
 */

/**
 * A directed block-pull session for one chased root, seeded with the peers that advertised it
 * (see DESIGN.md "Block pull"). The chase tries it before the broadcast `getBlock` and falls
 * back on any failure, so a session is an optimisation, never a correctness dependency.
 */
export interface ChaseSession {
    /** Fetch one block through the session; `undefined` or a throw falls back to `getBlock`. */
    get(cid: CID, signal: AbortSignal): Promise<Uint8Array | undefined>;
    /** Seed a late advertiser of the same root into the running pull. MUST NOT throw. */
    addPeer(peer: PeerId): void;
    /** Abort the session's in-flight wants and release it. MUST NOT throw. */
    close(): void;
}

/**
 * Wrap a raw block session into a {@link ChaseSession}, enforcing the contracts above at the one
 * boundary where they can be violated: `get` maps any failure to `undefined` (the chase falls
 * back to the broadcast want), and `addPeer`/`close` swallow synchronous throws as well as
 * rejections — a late hint can race the chase deadline and land on an already-closed session,
 * and nothing on that path guards again (`addProviders` relies on the MUST NOT throw contract,
 * and `chase()` is a fire-and-forget API). Shared by the voter and the integration harness so
 * the harness stays faithful to the production seam it mirrors.
 */
export function toChaseSession(session: BlockSessionLike): ChaseSession {
    return {
        get: async (cid, signal) => {
            try {
                return await session.get(cid, { signal });
            } catch {
                return undefined; // the chase falls back to the broadcast want
            }
        },
        addPeer: (peer) => {
            // A bad late hint (undialable, session at capacity, session already closed) must
            // never surface. `Promise.resolve(...)` alone would miss a synchronous throw — it
            // happens while evaluating the argument — so the call itself needs the try.
            try {
                void Promise.resolve(session.addPeer(peer)).catch(() => {});
            } catch {
                // same no-op as a rejection
            }
        },
        close: () => {
            try {
                session.close();
            } catch {
                // releasing a finished session must not fail the chase
            }
        }
    };
}

export interface RootChaserDeps {
    /**
     * Fetch one checkpoint block by CID (blockstore + directed bitswap); `undefined` or a
     * throw means unavailable. `signal` aborts the want when the per-root deadline fires.
     */
    getBlock: (cid: CID, signal: AbortSignal) => Promise<Uint8Array | undefined>;
    /**
     * Open a bitswap session for one chased root, seeded with `providers` — the advertisers of
     * that exact root, who provably hold its blocks. Optional twice over: absent when the host
     * blockstore cannot make sessions (plain blockstores, unit-test mocks), and a call may
     * return `undefined` to decline. NEVER invoked with zero providers — nothing announces
     * these CIDs to routing yet, so an unseeded session would fail-fast where the broadcast
     * `getBlock` succeeds via any connected topic peer.
     */
    openSession?: (root: CID, providers: PeerId[]) => ChaseSession | undefined;
    /** Stage 1 only — signature + constraints, local and synchronous (the gate's same stage). */
    verifyOffline: (bundle: VotesBundle) => Promise<VerifyResult>;
    /** The gate's per-CID verdict cache, shared so chased bundles reuse (and feed) it. */
    cache: VerdictCache;
    /** The gate's freshness guard (see gossip-validator.ts); omitted ⇒ no check. */
    isEvaluableNow?: (bundle: VotesBundle) => Promise<boolean>;
    /** Skip bundles we already hold (their CID is in the store) without re-verifying. */
    hasBundle: (cid: CID) => Promise<boolean>;
    /**
     * Store an offline-valid bundle's block bytes and admit its CID into the CRDT (idempotent).
     * `verified: true` means a cached terminal verdict already covers the FULL pipeline (the
     * bundle was verified before, e.g. by the forward-gate); `verified: false` is a provisional
     * admit whose deferred checks ride `deferVerify`.
     */
    admit: (args: { cid: CID; bytes: Uint8Array; bundle: VotesBundle; verified: boolean }) => Promise<void>;
    /** Hand one chased root's provisionally admitted bundles to the background chain verifier. */
    deferVerify: (entries: PendingBundle[]) => void;
    /** Called once per chase that admitted at least one bundle (drives tally updates). */
    onMerged?: () => void;
    /** Concurrency limiter shared across chases (a root spray queues, never floods). */
    limit: <T>(fn: () => Promise<T>) => Promise<T>;
    /** Per-root deadline (ms); on expiry the abort signal fires and the chase yields nothing. */
    timeoutMs: number;
}

export interface RootChaser {
    /**
     * Chase one advertised root, fire-and-forget: never throws, never blocks the caller
     * (the validator hands hints here without awaiting). A root already being chased is
     * dropped — the in-flight run covers it.
     *
     * `chunks` is the optional piggybacked chunk-CID index from a fetch-protocol root record
     * (see DESIGN.md "Block pull"): when supplied and it re-derives to `root`, the chase skips
     * the root-manifest bitswap round-trip and pulls the chunks directly. A heartbeat hint (no
     * index) omits it and takes the manifest-fetch path. The index is verified against `root`,
     * so a bad one simply falls back — never a trust vector.
     *
     * `providers` are the peers known to have advertised this exact root (the triggering
     * sender plus any prior advertisers still connected — see the voter's peer-root map); the
     * chase pulls through a bitswap session seeded with them when the `openSession` seam is
     * present, broadcasting only as fallback. A provider hint for a root already in flight is
     * added to the running session instead of dropped.
     */
    chase(root: CID, chunks?: CID[], providers?: readonly PeerId[]): void;
    /** Roots currently being chased (for tests/introspection). */
    inFlight(): number;
}

/** One in-flight chase's session state, shared between `chase()` (addPeer hints) and its run. */
interface Flight {
    /** Peer ids already seeded (dedups repeat hints across the chase's lifetime). */
    seeded: Set<string>;
    /** Providers accumulated before the run opens its session. */
    queued: PeerId[];
    session: ChaseSession | undefined;
    /** The run made its open-or-not decision; late hints past this point need `session`. */
    started: boolean;
}

export function makeRootChaser(deps: RootChaserDeps): RootChaser {
    const { getBlock, openSession, verifyOffline, cache, isEvaluableNow, hasBundle, admit, deferVerify, onMerged, limit, timeoutMs } = deps;
    const inFlight = new Map<string, Flight>();

    function addProviders(flight: Flight, providers: readonly PeerId[]): void {
        for (const peer of providers) {
            const id = peer.toString();
            if (flight.seeded.has(id)) continue;
            flight.seeded.add(id);
            if (flight.session !== undefined) flight.session.addPeer(peer);
            else if (!flight.started) flight.queued.push(peer);
            // started with no session (seam absent/declined): a late hint cannot help — drop it.
        }
    }

    async function runChase(flight: Flight, root: CID, chunks?: CID[]): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Open the session only now (not at enqueue): hints that arrived while queued behind the
        // concurrency cap are all in `queued`, so they seed the session instead of dialing addPeer.
        // A throwing factory degrades to the broadcast path exactly like an absent seam — a
        // session is an optimisation, never something a chase may die on.
        if (flight.queued.length > 0) {
            try {
                flight.session = openSession?.(root, flight.queued.splice(0));
            } catch {
                flight.session = undefined;
            }
        }
        flight.started = true;
        // One failed session want marks the whole session dead (a converged advertiser holds all
        // blocks or none) — the remaining blocks skip straight to the broadcast fallback instead
        // of paying a doomed session attempt each.
        let sessionDead = false;
        const fetchBlock = async (cid: CID): Promise<Uint8Array | undefined> => {
            if (controller.signal.aborted) return undefined;
            if (flight.session !== undefined && !sessionDead) {
                try {
                    const bytes = await flight.session.get(cid, controller.signal);
                    if (bytes !== undefined) return bytes;
                } catch {
                    // fall through to the broadcast path
                }
                sessionDead = true;
                if (controller.signal.aborted) return undefined; // deadline, not a session miss
            }
            try {
                return await getBlock(cid, controller.signal);
            } catch {
                return undefined; // unfetchable/aborted — decode throws "unavailable", chase yields nothing
            }
        };
        try {
            // Race the decode against the deadline so even a `getBlock` that ignores its abort
            // signal cannot pin this chase slot past `timeoutMs` — the slot is always freed.
            const winners = await Promise.race([
                decodeCheckpoint(root, fetchBlock, chunks),
                new Promise<undefined>((resolve) => {
                    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
                })
            ]);
            if (winners === undefined) return; // deadline hit — the hint contributed nothing

            let merged = false;
            const pending: PendingBundle[] = [];
            for (const bundle of winners) {
                if (controller.signal.aborted) break;
                // Re-encoding the decoded bundle reproduces the exact block bytes (the codec is
                // canonical), so the CID matches the advertiser's block and dedups everywhere.
                const bytes = encodeBundle(bundle);
                const cid = await bundleCidForBytes(bytes);
                if (await hasBundle(cid)) continue; // already held — nothing to verify
                const cached = cache.get(cid);
                if (cached) {
                    if (!cached.valid) continue; // known bad — skip
                    await admit({ cid, bytes, bundle, verified: true }); // full pipeline already passed
                    merged = true;
                    continue;
                }
                if (isEvaluableNow && !(await isEvaluableNow(bundle))) continue; // transient, uncached
                const offline = await verifyOffline(bundle);
                if (!offline.valid) {
                    // A liar's forged/malformed bundle dies here, before admit. A provable
                    // offline reject (bad signature, constraints) is terminal — cache it so a
                    // re-served copy short-circuits; a transient `ignore` stays uncached.
                    if (offline.disposition === "reject") cache.set(cid, offline);
                    continue;
                }
                await admit({ cid, bytes, bundle, verified: false });
                pending.push({ cid, bundle });
                merged = true;
            }
            // One batch per chased root: the background verifier groups these by sample block
            // and batches the gate reads (see verify/background.ts).
            if (pending.length > 0) deferVerify(pending);
            if (merged) onMerged?.();
        } finally {
            clearTimeout(timer);
            flight.session?.close();
        }
    }

    return {
        chase(root: CID, chunks?: CID[], providers?: readonly PeerId[]): void {
            const key = root.toString();
            const existing = inFlight.get(key);
            if (existing !== undefined) {
                // The in-flight run covers this hint (chunks derive from root) — but a new
                // advertiser joins its session rather than being dropped on the floor.
                if (providers !== undefined) addProviders(existing, providers);
                return;
            }
            const flight: Flight = { seeded: new Set(), queued: [], session: undefined, started: false };
            if (providers !== undefined) addProviders(flight, providers);
            inFlight.set(key, flight);
            void limit(() => runChase(flight, root, chunks))
                .catch(() => {}) // a failed chase contributes nothing; the hint was never trusted
                .finally(() => inFlight.delete(key));
        },
        inFlight(): number {
            return inFlight.size;
        }
    };
}
