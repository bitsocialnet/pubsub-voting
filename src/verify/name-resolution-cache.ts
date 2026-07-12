import { sha256, stringToHex } from "viem";
import type { NameResolver } from "../chain/types.js";
import type { LruStorage } from "../storage/types.js";

/**
 * Persistent cache of community-name resolutions, a port of pkc-js's `NameResolutionCache`
 * (clients/name-resolution-cache.ts) — the SAME rule, so a host reasons about one caching
 * policy across both libraries:
 *
 *   - LRU-bounded persistent store, no stored TTL: an entry lives until evicted.
 *   - Freshness is a per-CALL max-age, modeled on HTTP `Cache-Control: max-age` (RFC 9111
 *     §5.2.1.1): `maxAgeSeconds: 0` bypasses the cache, `N` serves an entry only while
 *     `Date.now() - resolvedAtMs <= N * 1000`, `undefined` serves whatever is cached.
 *   - Only SUCCESSFUL resolutions are stored; a name that fails to resolve is retried by the
 *     caller, never negatively cached. No stale-while-revalidate.
 *   - Keyed `{name}::{resolverKey}::{sha256(provider)}` — per resolver identity, because two
 *     resolvers (or providers) may legitimately disagree during a migration.
 *
 * This cache exists because the host's own pkc-js instance caches at ITS call sites, not
 * inside the injected resolver — so without this layer every verify here pays a live
 * registry read that pkc-js would have served from cache.
 */
export interface NameResolutionCacheEntry {
    publicKey: string;
    resolverKey: string;
    provider: string;
    resolvedAtMs: number;
}

export interface NameResolutionCache {
    get(args: {
        name: string;
        resolverKey: string;
        provider: string;
        maxAgeSeconds?: number;
    }): Promise<NameResolutionCacheEntry | undefined>;
    set(args: { name: string; resolverKey: string; provider: string; publicKey: string }): Promise<void>;
}

/**
 * The verify pipeline's freshness bound, matching pkc-js's background resolution call site
 * (`cache: { maxAge: 3600 }`): a re-pointed name is honored here within at most one hour.
 * Names gate vote validity, so this is the staleness ceiling a community re-point can see.
 */
export const NAME_RESOLUTION_MAX_AGE_SECONDS = 3600;

const keyFor = (args: { name: string; resolverKey: string; provider: string }): string =>
    `${args.name}::${args.resolverKey}::${sha256(stringToHex(args.provider))}`;

export function makeNameResolutionCache(store: LruStorage): NameResolutionCache {
    return {
        async get(args) {
            if (args.maxAgeSeconds === 0) return undefined;
            let entry: unknown;
            try {
                entry = await store.getItem(keyFor(args));
            } catch {
                return undefined; // a broken cache read degrades to a live resolution, never a failure
            }
            if (
                entry === null ||
                typeof entry !== "object" ||
                typeof (entry as NameResolutionCacheEntry).publicKey !== "string" ||
                typeof (entry as NameResolutionCacheEntry).resolvedAtMs !== "number"
            ) {
                return undefined;
            }
            const cached = entry as NameResolutionCacheEntry;
            if (typeof args.maxAgeSeconds === "number" && Date.now() - cached.resolvedAtMs > args.maxAgeSeconds * 1000) {
                return undefined;
            }
            return cached;
        },
        async set(args) {
            const entry: NameResolutionCacheEntry = {
                publicKey: args.publicKey,
                resolverKey: args.resolverKey,
                provider: args.provider,
                resolvedAtMs: Date.now()
            };
            try {
                await store.setItem(keyFor(args), entry);
            } catch {
                // a failed cache write costs a future re-resolution, never a wrong answer
            }
        }
    };
}

/**
 * The verify pipeline's single resolution path (inline forward-gate AND background verifier):
 * serve from the cache within {@link NAME_RESOLUTION_MAX_AGE_SECONDS}, otherwise resolve live
 * and persist a success. `undefined` (no record) is returned uncached — the pkc-js rule.
 */
export async function resolveNameThroughCache(opts: {
    resolver: NameResolver;
    name: string;
    cache: NameResolutionCache | undefined;
}): Promise<{ publicKey: string } | undefined> {
    const { resolver, name, cache } = opts;
    const identity = { name, resolverKey: resolver.key, provider: resolver.provider };
    const cached = await cache?.get({ ...identity, maxAgeSeconds: NAME_RESOLUTION_MAX_AGE_SECONDS });
    if (cached) return { publicKey: cached.publicKey };
    const record = await resolver.resolve({ name });
    if (record && cache) await cache.set({ ...identity, publicKey: record.publicKey });
    return record;
}
