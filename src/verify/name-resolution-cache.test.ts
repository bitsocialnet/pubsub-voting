import { describe, it, expect, vi, afterEach } from "vitest";
import { makeNameResolutionCache, resolveNameThroughCache, NAME_RESOLUTION_MAX_AGE_SECONDS } from "./name-resolution-cache.js";
import { makeMemoryLruStorage } from "../storage/memory.js";
import type { NameResolver } from "../chain/types.js";

const IDENTITY = { name: "memes.bso", resolverKey: "bso-viem", provider: "viem" };
const KEY = "0x" + "ab".repeat(32);

/** A resolver over a fixed name -> publicKey map, counting live `resolve` calls. */
function countingResolver(records: Record<string, string | undefined>) {
    let calls = 0;
    const resolver: NameResolver = {
        key: "bso-viem",
        provider: "viem",
        canResolve: ({ name }) => name.endsWith(".bso"),
        resolve: async ({ name }) => {
            calls += 1;
            const publicKey = records[name];
            return publicKey === undefined ? undefined : { publicKey };
        }
    };
    return { resolver, calls: () => calls };
}

afterEach(() => vi.useRealTimers());

describe("makeNameResolutionCache (the pkc-js rule)", () => {
    it("serves a stored entry, keyed per (name, resolverKey, provider)", async () => {
        const cache = makeNameResolutionCache(makeMemoryLruStorage(10));
        await cache.set({ ...IDENTITY, publicKey: KEY });
        expect((await cache.get(IDENTITY))?.publicKey).toBe(KEY);
        // A different resolver identity is a different key — never served across resolvers.
        expect(await cache.get({ ...IDENTITY, resolverKey: "other" })).toBeUndefined();
        expect(await cache.get({ ...IDENTITY, provider: "other" })).toBeUndefined();
        expect(await cache.get({ ...IDENTITY, name: "other.bso" })).toBeUndefined();
    });

    it("maxAge 0 bypasses, maxAge N enforces freshness, undefined serves anything (RFC 9111 max-age)", async () => {
        vi.useFakeTimers();
        const cache = makeNameResolutionCache(makeMemoryLruStorage(10));
        await cache.set({ ...IDENTITY, publicKey: KEY });
        expect(await cache.get({ ...IDENTITY, maxAgeSeconds: 0 })).toBeUndefined();
        expect((await cache.get({ ...IDENTITY, maxAgeSeconds: 60 }))?.publicKey).toBe(KEY);
        vi.advanceTimersByTime(61_000);
        expect(await cache.get({ ...IDENTITY, maxAgeSeconds: 60 })).toBeUndefined(); // stale for this caller
        expect((await cache.get(IDENTITY))?.publicKey).toBe(KEY); // no threshold: still served
    });

    it("ignores a corrupt stored entry", async () => {
        const store = makeMemoryLruStorage(10);
        const cache = makeNameResolutionCache(store);
        await cache.set({ ...IDENTITY, publicKey: KEY });
        const [key] = await store.keys();
        await store.setItem(key!, { junk: true }); // overwrite the real key with a non-entry shape
        expect(await cache.get(IDENTITY)).toBeUndefined();
    });
});

describe("resolveNameThroughCache", () => {
    it("resolves live once, then serves the cache within the max-age", async () => {
        const cache = makeNameResolutionCache(makeMemoryLruStorage(10));
        const { resolver, calls } = countingResolver({ "memes.bso": KEY });
        expect(await resolveNameThroughCache({ resolver, name: "memes.bso", cache })).toEqual({ publicKey: KEY });
        expect(await resolveNameThroughCache({ resolver, name: "memes.bso", cache })).toEqual({ publicKey: KEY });
        expect(calls()).toBe(1);
    });

    it("re-resolves once the entry outages the max-age (a re-point is honored within the hour)", async () => {
        vi.useFakeTimers();
        const cache = makeNameResolutionCache(makeMemoryLruStorage(10));
        const records: Record<string, string> = { "memes.bso": KEY };
        const { resolver, calls } = countingResolver(records);
        await resolveNameThroughCache({ resolver, name: "memes.bso", cache });
        records["memes.bso"] = "0x" + "cd".repeat(32); // the name re-points
        vi.advanceTimersByTime((NAME_RESOLUTION_MAX_AGE_SECONDS + 1) * 1000);
        const record = await resolveNameThroughCache({ resolver, name: "memes.bso", cache });
        expect(record?.publicKey).toBe("0x" + "cd".repeat(32));
        expect(calls()).toBe(2);
    });

    it("never caches a failed resolution (the caller retries live)", async () => {
        const cache = makeNameResolutionCache(makeMemoryLruStorage(10));
        const { resolver, calls } = countingResolver({ "ghost.bso": undefined });
        expect(await resolveNameThroughCache({ resolver, name: "ghost.bso", cache })).toBeUndefined();
        expect(await resolveNameThroughCache({ resolver, name: "ghost.bso", cache })).toBeUndefined();
        expect(calls()).toBe(2);
    });

    it("resolves live every time with no cache (prior behaviour)", async () => {
        const { resolver, calls } = countingResolver({ "memes.bso": KEY });
        await resolveNameThroughCache({ resolver, name: "memes.bso", cache: undefined });
        await resolveNameThroughCache({ resolver, name: "memes.bso", cache: undefined });
        expect(calls()).toBe(2);
    });
});
