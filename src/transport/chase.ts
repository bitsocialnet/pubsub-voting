import type { CID } from "multiformats/cid";
import type { VotesBundle } from "../schema/votes.js";
import { decodeCheckpoint } from "../checkpoint/codec.js";
import { encodeBundle, bundleCidForBytes } from "../crdt/codec.js";
import { isCacheableVerdict, type VerdictCache } from "../verify/cache.js";
import type { BundleVerifier } from "../verify/types.js";

/**
 * The divergence chase: act on an advertised checkpoint root that differs from our own (a
 * heartbeat or fetch-protocol hint — see DESIGN.md "Checkpoints", "Block pull"). Pull the
 * blocks behind the root by CID (directed bitswap at the connected advertisers, through the
 * injected `getBlock`), verify every inlined bundle **through the same verifier the gate
 * uses**, and admit the survivors — so a single liar cannot inject a bad vote (each bundle
 * self-verifies) nor hide an honest one (union-only merge).
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
    /** The full validity pipeline for one bundle — the SAME one the forward-gate runs. */
    verifier: BundleVerifier;
    /** The gate's per-CID verdict cache, shared so chased bundles reuse (and feed) it. */
    cache: VerdictCache;
    /** The gate's freshness guard (see gossip-validator.ts); omitted ⇒ no check. */
    isEvaluableNow?: (bundle: VotesBundle) => Promise<boolean>;
    /** Skip bundles we already hold (their CID is in the store) without re-verifying. */
    hasBundle: (cid: CID) => Promise<boolean>;
    /** Store a verified bundle's block bytes and admit its CID into the CRDT (idempotent). */
    admit: (args: { cid: CID; bytes: Uint8Array; bundle: VotesBundle }) => Promise<void>;
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
     */
    chase(root: CID): void;
    /** Roots currently being chased (for tests/introspection). */
    inFlight(): number;
}

export function makeRootChaser(deps: RootChaserDeps): RootChaser {
    const { getBlock, verifier, cache, isEvaluableNow, hasBundle, admit, onMerged, limit, timeoutMs } = deps;
    const inFlight = new Set<string>();

    async function runChase(root: CID): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // Race the decode against the deadline so even a `getBlock` that ignores its abort
            // signal cannot pin this chase slot past `timeoutMs` — the slot is always freed.
            const winners = await Promise.race([
                decodeCheckpoint(root, async (cid) => {
                    if (controller.signal.aborted) return undefined;
                    try {
                        return await getBlock(cid, controller.signal);
                    } catch {
                        return undefined; // unfetchable/aborted — decode throws "unavailable", chase yields nothing
                    }
                }),
                new Promise<undefined>((resolve) => {
                    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
                })
            ]);
            if (winners === undefined) return; // deadline hit — the hint contributed nothing

            let merged = false;
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
                    await admit({ cid, bytes, bundle });
                    merged = true;
                    continue;
                }
                if (isEvaluableNow && !(await isEvaluableNow(bundle))) continue; // transient, uncached
                const verdict = await verifier.verify(bundle);
                if (isCacheableVerdict(verdict)) cache.set(cid, verdict);
                if (!verdict.valid) continue; // a liar's injected bundle dies here; honest ones survive
                await admit({ cid, bytes, bundle });
                merged = true;
            }
            if (merged) onMerged?.();
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        chase(root: CID): void {
            const key = root.toString();
            if (inFlight.has(key)) return; // the in-flight run covers this hint
            inFlight.add(key);
            void limit(() => runChase(root))
                .catch(() => {}) // a failed chase contributes nothing; the hint was never trusted
                .finally(() => inFlight.delete(key));
        },
        inFlight(): number {
            return inFlight.size;
        }
    };
}
