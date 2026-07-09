import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import { decodeCheckpoint } from "../checkpoint/codec.js";
import { encodeBundle, bundleCidForBytes } from "../crdt/codec.js";
import type { VerdictCache } from "../verify/cache.js";
import type { VerifyResult } from "../verify/types.js";
import type { PendingBundle } from "../verify/background.js";

/**
 * The divergence chase: act on an advertised checkpoint root that differs from our own (a
 * heartbeat or fetch-protocol hint — see DESIGN.md "Checkpoints", "Block pull"). Pull the
 * blocks behind the root by CID (directed bitswap at the connected advertisers, through the
 * injected `getBlock`) and admit each inlined bundle in two stages:
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

export interface RootChaserDeps {
    /**
     * Fetch one checkpoint block by CID (blockstore + directed bitswap); `undefined` or a
     * throw means unavailable. `signal` aborts the want when the per-root deadline fires.
     */
    getBlock: (cid: CID, signal: AbortSignal) => Promise<Uint8Array | undefined>;
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
     */
    chase(root: CID, chunks?: CID[]): void;
    /** Roots currently being chased (for tests/introspection). */
    inFlight(): number;
}

export function makeRootChaser(deps: RootChaserDeps): RootChaser {
    const { getBlock, verifyOffline, cache, isEvaluableNow, hasBundle, admit, deferVerify, onMerged, limit, timeoutMs } = deps;
    const inFlight = new Set<string>();

    async function runChase(root: CID, chunks?: CID[]): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // Race the decode against the deadline so even a `getBlock` that ignores its abort
            // signal cannot pin this chase slot past `timeoutMs` — the slot is always freed.
            const winners = await Promise.race([
                decodeCheckpoint(
                    root,
                    async (cid) => {
                        if (controller.signal.aborted) return undefined;
                        try {
                            return await getBlock(cid, controller.signal);
                        } catch {
                            return undefined; // unfetchable/aborted — decode throws "unavailable", chase yields nothing
                        }
                    },
                    chunks
                ),
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
        }
    }

    return {
        chase(root: CID, chunks?: CID[]): void {
            const key = root.toString();
            if (inFlight.has(key)) return; // the in-flight run covers this hint (chunks derive from root)
            inFlight.add(key);
            void limit(() => runChase(root, chunks))
                .catch(() => {}) // a failed chase contributes nothing; the hint was never trusted
                .finally(() => inFlight.delete(key));
        },
        inFlight(): number {
            return inFlight.size;
        }
    };
}
