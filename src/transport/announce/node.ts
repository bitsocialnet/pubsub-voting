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
 * Addresses: the announceable set is `getMultiaddrs()` filtered to public/DNS addrs plus
 * exactly-unspecified addrs (`0.0.0.0`/`::`), which the production router rewrites to the PUT's
 * observed source IP (`cleanAddrs` — how kubo's announces work). When the filter comes up EMPTY,
 * the announcer synthesizes those wildcard sentinels itself from the node's listen ports
 * ({@link sentinelAddrs}), because libp2p never reports one: a wildcard listen is expanded to
 * concrete interface addrs, and a PUBLIC interface addr is withheld from `getMultiaddrs()` until
 * AutoNAT confirms it — which a seeder with no inbound peers yet can never pass (the announce is
 * what brings the first peer). So the zero-config seeder — NAT'd, Docker-bridged, or a bare
 * public-IP host without AutoNAT — announces the sentinel and the router fills in the IP it can
 * actually see.
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

/** The exactly-unspecified IPs — the production router's "rewrite me to the PUT's source IP" sentinels. */
const UNSPECIFIED_IP4 = "0.0.0.0";
const UNSPECIFIED_IP6 = "::";

/** RFC1918/loopback/link-local/CGNAT/"this network" IPv4 — never dialable as announced. */
function isPrivateIp4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    return (
        a === 0 || // "this network" 0.0.0.0/8 (the exact unspecified addr is special-cased by callers)
        a === 10 ||
        a === 127 || // loopback
        (a === 100 && b >= 64 && b < 128) || // CGNAT 100.64/10
        (a === 169 && b === 254) || // link-local
        (a === 172 && b >= 16 && b < 32) ||
        (a === 192 && b === 168)
    );
}

/** Loopback/link-local/ULA IPv6 — never dialable as announced. */
function isPrivateIp6(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === UNSPECIFIED_IP6 || lower === "::1") return true;
    // fe80::/10 link-local (fe8x..febx), fc00::/7 unique-local (fcxx/fdxx).
    return /^fe[89ab]/.test(lower) || /^f[cd]/.test(lower);
}

/**
 * Filter a node's multiaddrs down to what belongs in a public provider record: public `/ip4` /
 * `/ip6` addrs, DNS addrs (`/dns4`/`/dns6`/`/dnsaddr` — the AutoTLS `<peerId>.libp2p.direct`
 * WSS addrs travel this way, and the production router passes DNS through unvalidated), and
 * EXACTLY-unspecified addrs (`/ip4/0.0.0.0/...`, `/ip6/::/...`) — the router rewrites those to
 * the PUT's observed source IP (`cleanAddrs`, the same mechanism kubo's announces rely on), so
 * they are how a node that cannot see its own public IP still announces a dialable record.
 * Private, loopback, link-local, and CGNAT IPs are dropped CLIENT-side rather than trusting the
 * router to drop them; a `p2p-circuit` addr is judged by its relay's leading component like any
 * other. Exported for the announcer's unit tests.
 */
export function announceableAddrs(addrs: readonly string[]): string[] {
    return addrs.filter((addr) => {
        const [, proto, value] = addr.split("/");
        if (proto === undefined || value === undefined) return false;
        if (proto === "dns4" || proto === "dns6" || proto === "dnsaddr" || proto === "dns") return true;
        if (proto === "ip4") return value === UNSPECIFIED_IP4 || !isPrivateIp4(value);
        if (proto === "ip6") return value.toLowerCase() === UNSPECIFIED_IP6 || !isPrivateIp6(value);
        return false;
    });
}

/**
 * Synthesize the router's "rewrite me" wildcard sentinels for a node with NO announceable addr:
 * every non-loopback `/ip4`/`/ip6` interface addr, with its IP swapped for the unspecified addr
 * of its family and the rest of the multiaddr (port, transport, `/p2p/` suffix) kept, deduped.
 * libp2p never reports a wildcard itself — a `0.0.0.0` listen is expanded to concrete interface
 * addrs, and a public interface addr is withheld until AutoNAT confirms it — so behind NAT, on a
 * Docker bridge, or on a public-IP host without AutoNAT the whole set filters away and the listen
 * ports here are the only truthful thing left to announce; the router substitutes the source IP
 * it observed (dropping the family it did not see the PUT from). Loopback addrs are excluded as
 * synthesis sources: a loopback-only node deliberately isn't listening on any interface a rewrite
 * could make dialable, and it must keep announcing nothing. Exported for the announcer's tests.
 */
export function sentinelAddrs(addrs: readonly string[]): string[] {
    const sentinels = new Set<string>();
    for (const addr of addrs) {
        const parts = addr.split("/");
        const [, proto, value] = parts;
        if (proto === undefined || value === undefined) continue;
        if (proto === "ip4" && value !== UNSPECIFIED_IP4 && value.split(".")[0] !== "127") {
            sentinels.add(["", proto, UNSPECIFIED_IP4, ...parts.slice(3)].join("/"));
        } else if (proto === "ip6" && !["::", "::1"].includes(value.toLowerCase())) {
            sentinels.add(["", proto, UNSPECIFIED_IP6, ...parts.slice(3)].join("/"));
        }
    }
    return [...sentinels];
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
                const all = options.libp2p.getMultiaddrs().map((a) => a.toString());
                let addrs = announceableAddrs(all);
                // No announceable addr — behind NAT/Docker-bridge, or a public interface addr
                // libp2p is still withholding pending AutoNAT — announce the wildcard sentinels
                // and let the router substitute the source IP it observes (see sentinelAddrs).
                if (addrs.length === 0) addrs = sentinelAddrs(all);
                // Nothing joined, or loopback-only (not listening on any rewritable interface):
                // announce nothing — the production router drops addr-less providers anyway.
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
