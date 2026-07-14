import type { Announcer, AnnouncerOptions } from "./types.js";

/**
 * The Node provider-record announcer (see types.ts for the seam rationale, and DESIGN.md
 * "Deferred pkc-js work", provider-record announces): one unsigned `PUT /routing/v1/providers`
 * per configured router per tick, kubo's body shape —
 * `{ Providers: [{ Schema: "peer", Payload: { ID, Addrs, Keys } }] }` — with `Keys` batched
 * across ALL joined contests. Unsigned is correct against the production router
 * (pkc-http-router reads only `Payload.{ID, Addrs, Keys, AdvisoryTTL}`; no signature field
 * exists), and its anti-spoofing keeps `/ip4`/`/ip6` addrs only when the IP matches the PUT's
 * source IP — which a seeder announcing its own addresses passes naturally.
 *
 * Ticks: the debounced change trigger ({@link Announcer.notifyChange} — contest joins, checkpoint
 * root changes, `self:peer:update` address changes) plus an hourly re-announce (pkc-js's
 * `providePubsubTopicRoutingCidsIfNeeded` cadence; the production router's record TTL is 24h, so
 * hourly has a 24× margin). Best-effort per router: a failing or slow router is reported through
 * `onError` and never throws into the voter; there is no retry — the next tick covers it.
 */

/** Hourly re-announce — pkc-js's `providePubsubTopicRoutingCidsIfNeeded` cadence, ≪ the 24h TTL. */
export const ANNOUNCE_INTERVAL_MS = 3_600_000;
/**
 * Change-coalescing window: a gossip burst re-dirties the checkpoint per accepted bundle and a
 * directory join fires once per contest, so the first trigger arms one timer and the burst rides
 * it — bounding announces to one per window while a hot topic churns.
 */
export const ANNOUNCE_DEBOUNCE_MS = 10_000;
/** Per-router PUT deadline — same order as the cold-join router lookup deadline. */
export const ANNOUNCE_ROUTER_TIMEOUT_MS = 10_000;

/** RFC1918/loopback/link-local/CGNAT/unspecified IPv4 — never announceable. */
function isPrivateIp4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    return (
        a === 0 || // unspecified / "this network"
        a === 10 ||
        a === 127 || // loopback
        (a === 100 && b >= 64 && b < 128) || // CGNAT 100.64/10
        (a === 169 && b === 254) || // link-local
        (a === 172 && b >= 16 && b < 32) ||
        (a === 192 && b === 168)
    );
}

/** Loopback/link-local/ULA/unspecified IPv6 — never announceable. */
function isPrivateIp6(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    // fe80::/10 link-local (fe8x..febx), fc00::/7 unique-local (fcxx/fdxx).
    return /^fe[89ab]/.test(lower) || /^f[cd]/.test(lower);
}

/**
 * Filter a node's multiaddrs down to what belongs in a public provider record: public `/ip4` /
 * `/ip6` addrs and DNS addrs (`/dns4`/`/dns6`/`/dnsaddr` — the AutoTLS `<peerId>.libp2p.direct`
 * WSS addrs travel this way, and the production router passes DNS through unvalidated). Private,
 * loopback, link-local, CGNAT, and unspecified IPs are dropped CLIENT-side rather than trusting
 * the router to drop them; a `p2p-circuit` addr is judged by its relay's leading component like
 * any other. Exported for the announcer's unit tests.
 */
export function announceableAddrs(addrs: readonly string[]): string[] {
    return addrs.filter((addr) => {
        const [, proto, value] = addr.split("/");
        if (proto === undefined || value === undefined) return false;
        if (proto === "dns4" || proto === "dns6" || proto === "dnsaddr" || proto === "dns") return true;
        if (proto === "ip4") return !isPrivateIp4(value);
        if (proto === "ip6") return !isPrivateIp6(value);
        return false;
    });
}

/** One unsigned kubo-shape provider PUT; throws on timeout or a non-2xx answer. */
async function putProviders(baseUrl: string, body: string, timeoutMs: number): Promise<void> {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/routing/v1/providers`;
    const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`router ${endpoint} answered ${res.status}`);
    // Drain so the connection can be reused; the ProvideResults echo carries nothing we act on.
    await res.arrayBuffer().catch(() => {});
}

/** Build the Node announcer. The browser build never sees this file (package.json `browser` remap). */
export function makeAnnouncer(options: AnnouncerOptions): Announcer {
    const intervalMs = options.intervalMs ?? ANNOUNCE_INTERVAL_MS;
    const debounceMs = options.debounceMs ?? ANNOUNCE_DEBOUNCE_MS;
    const timeoutMs = options.timeoutMs ?? ANNOUNCE_ROUTER_TIMEOUT_MS;

    let started = false;
    let intervalTimer: ReturnType<typeof setInterval> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    /** True while one announce runs; a trigger landing mid-run re-runs once after (never overlaps). */
    let running = false;
    let rerun = false;

    const announceNow = async (): Promise<void> => {
        if (running) {
            rerun = true;
            return;
        }
        running = true;
        try {
            do {
                rerun = false;
                const keys = await options.keys();
                const addrs = announceableAddrs(options.libp2p.getMultiaddrs().map((a) => a.toString()));
                // Nothing joined, or no publicly dialable address: announce nothing. The production
                // router drops a provider whose addrs come up empty anyway — an undialable node
                // (plain client, NATed box with no configured announce addrs) must not announce.
                if (keys.length === 0 || addrs.length === 0) continue;
                const body = JSON.stringify({
                    Providers: [{ Schema: "peer", Payload: { ID: options.libp2p.peerId.toString(), Addrs: addrs, Keys: keys } }]
                });
                await Promise.all(
                    options.routerUrls.map(async (url) => {
                        try {
                            await putProviders(url, body, timeoutMs);
                        } catch (error) {
                            options.onError?.(url, error);
                        }
                    })
                );
            } while (rerun);
        } finally {
            running = false;
        }
    };

    const notifyChange = (): void => {
        if (!started || debounceTimer !== undefined) return;
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            void announceNow();
        }, debounceMs);
        (debounceTimer as { unref?: () => void }).unref?.();
    };

    const onAddressChange = (): void => notifyChange();

    return {
        start() {
            if (started) return;
            started = true;
            options.libp2p.addEventListener("self:peer:update", onAddressChange);
            intervalTimer = setInterval(() => void announceNow(), intervalMs);
            (intervalTimer as { unref?: () => void }).unref?.();
        },
        stop() {
            if (!started) return;
            started = false;
            options.libp2p.removeEventListener("self:peer:update", onAddressChange);
            if (intervalTimer !== undefined) clearInterval(intervalTimer);
            intervalTimer = undefined;
            if (debounceTimer !== undefined) clearTimeout(debounceTimer);
            debounceTimer = undefined;
        },
        notifyChange
    };
}
