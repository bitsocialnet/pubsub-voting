import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { makeAnnouncer, announceableAddrs, sentinelAddrs } from "./node.js";
import { makeAnnouncer as makeBrowserAnnouncer } from "./browser.js";
import type { AnnouncerLibp2p, AnnouncerOptions } from "./types.js";

/** One received announce, as the mock router recorded it. */
interface ReceivedPut {
    method: string;
    url: string;
    body: { Providers: Array<{ Schema: string; Payload: { ID: string; Addrs: string[]; Keys: string[] } }> };
}

/** A local mock Delegated Routing V1 router: records every PUT, answers per `status`. */
async function startMockRouter(opts: { status?: number; hang?: boolean } = {}): Promise<{
    url: string;
    puts: ReceivedPut[];
    stop: () => Promise<void>;
}> {
    const puts: ReceivedPut[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            puts.push({ method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : undefined });
            if (opts.hang) return; // never answer — the client's per-router timeout must fire
            res.writeHead(opts.status ?? 200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ProvideResults: [] }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/`,
        puts,
        stop: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            })
    };
}

/** Poll until `cond` holds (the announcer's ticks are async fire-and-forget). */
async function waitUntil(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error("waitUntil: condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const PUBLIC_ADDR = "/ip4/203.0.113.5/tcp/4001";
const DNS_ADDR = "/dns4/example.libp2p.direct/tcp/443/tls/ws";

/** A fake libp2p carrying a peer id + address set, capturing the `self:peer:update` listener. */
function fakeLibp2p(addrs: string[] = [PUBLIC_ADDR, "/ip4/127.0.0.1/tcp/4001"]): AnnouncerLibp2p & {
    fireAddressChange: () => void;
    listenerCount: () => number;
} {
    const listeners = new Set<() => void>();
    return {
        peerId: { toString: () => "12D3KooWAnnouncerPeer" },
        getMultiaddrs: () => addrs.map((a) => ({ toString: () => a })),
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        fireAddressChange: () => listeners.forEach((l) => l()),
        listenerCount: () => listeners.size
    };
}

/** Announcer with fast test cadences; callers override per test. */
function testAnnouncer(overrides: Partial<AnnouncerOptions> & Pick<AnnouncerOptions, "routerUrls">) {
    return makeAnnouncer({
        libp2p: fakeLibp2p(),
        keys: async () => ["bafyCriteria"],
        debounceMs: 25,
        intervalMs: 60_000,
        timeoutMs: 1_000,
        ...overrides
    });
}

describe("announceableAddrs", () => {
    it("keeps public ip4/ip6 and DNS addrs, judging circuit/webrtc addrs by their leading component", () => {
        expect(
            announceableAddrs([
                PUBLIC_ADDR,
                "/ip6/2001:db8::1/tcp/4001",
                DNS_ADDR,
                "/dnsaddr/bootstrap.libp2p.io",
                "/ip4/203.0.113.5/udp/4001/webrtc-direct/certhash/uEiA",
                "/ip4/203.0.113.9/tcp/4001/p2p/12D3KooWRelay/p2p-circuit"
            ])
        ).toEqual([
            PUBLIC_ADDR,
            "/ip6/2001:db8::1/tcp/4001",
            DNS_ADDR,
            "/dnsaddr/bootstrap.libp2p.io",
            "/ip4/203.0.113.5/udp/4001/webrtc-direct/certhash/uEiA",
            "/ip4/203.0.113.9/tcp/4001/p2p/12D3KooWRelay/p2p-circuit"
        ]);
    });

    it("drops loopback, private, link-local, CGNAT, and ULA addrs", () => {
        expect(
            announceableAddrs([
                "/ip4/127.0.0.1/tcp/4001",
                "/ip4/10.0.0.2/tcp/4001",
                "/ip4/172.31.0.2/tcp/4001",
                "/ip4/192.168.1.2/tcp/4001",
                "/ip4/169.254.0.2/tcp/4001",
                "/ip4/100.64.0.2/tcp/4001",
                "/ip6/::1/tcp/4001",
                "/ip6/fe80::1/tcp/4001",
                "/ip6/fd00::1/tcp/4001",
                "/memory/0"
            ])
        ).toEqual([]);
    });

    it("passes exactly-unspecified addrs through as the router's rewrite sentinel", () => {
        expect(
            announceableAddrs([
                "/ip4/0.0.0.0/tcp/4001",
                "/ip6/::/tcp/4001",
                "/ip4/0.0.0.1/tcp/4001", // "this network" but NOT the unspecified addr — still dropped
                "/ip4/192.168.1.2/tcp/4001"
            ])
        ).toEqual(["/ip4/0.0.0.0/tcp/4001", "/ip6/::/tcp/4001"]);
    });
});

describe("sentinelAddrs", () => {
    it("derives deduped wildcard sentinels from non-loopback interface addrs, keeping port/transport/p2p suffix", () => {
        expect(
            sentinelAddrs([
                "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAnnouncerPeer",
                "/ip4/192.168.1.7/tcp/4001/p2p/12D3KooWAnnouncerPeer",
                "/ip4/172.31.0.1/tcp/4001/p2p/12D3KooWAnnouncerPeer", // same port as above — dedupes
                "/ip4/192.168.1.7/tcp/4002/ws/p2p/12D3KooWAnnouncerPeer",
                "/ip6/fd00::1/tcp/4001/p2p/12D3KooWAnnouncerPeer"
            ])
        ).toEqual([
            "/ip4/0.0.0.0/tcp/4001/p2p/12D3KooWAnnouncerPeer",
            "/ip4/0.0.0.0/tcp/4002/ws/p2p/12D3KooWAnnouncerPeer",
            "/ip6/::/tcp/4001/p2p/12D3KooWAnnouncerPeer"
        ]);
    });

    it("derives nothing from loopback-only, already-unspecified, or non-IP addrs", () => {
        expect(
            sentinelAddrs([
                "/ip4/127.0.0.1/tcp/4001",
                "/ip6/::1/tcp/4001",
                "/ip4/0.0.0.0/tcp/4001",
                "/ip6/::/tcp/4001",
                "/dns4/example.libp2p.direct/tcp/443/tls/ws",
                "/memory/0"
            ])
        ).toEqual([]);
    });
});

describe("makeAnnouncer (node)", () => {
    it("PUTs one kubo-shape record per router with all keys batched, normalizing trailing slashes", async () => {
        const a = await startMockRouter();
        const b = await startMockRouter();
        try {
            const announcer = testAnnouncer({
                routerUrls: [a.url, b.url.replace(/\/$/, "")], // with and without trailing slash
                keys: async () => ["bafyCriteria1", "bafyRoot1", "bafyCriteria2", "bafyRoot2"]
            });
            announcer.start();
            announcer.notifyChange();
            await waitUntil(() => a.puts.length >= 1 && b.puts.length >= 1);
            announcer.stop();
            for (const router of [a, b]) {
                expect(router.puts).toHaveLength(1);
                const put = router.puts[0]!;
                expect(put.method).toBe("PUT");
                expect(put.url).toBe("/routing/v1/providers");
                expect(put.body.Providers).toHaveLength(1);
                const { Schema, Payload } = put.body.Providers[0]!;
                expect(Schema).toBe("peer");
                expect(Payload.ID).toBe("12D3KooWAnnouncerPeer");
                expect(Payload.Keys).toEqual(["bafyCriteria1", "bafyRoot1", "bafyCriteria2", "bafyRoot2"]);
                expect(Payload.Addrs).toEqual([PUBLIC_ADDR]); // loopback filtered client-side
            }
        } finally {
            await a.stop();
            await b.stop();
        }
    });

    it("coalesces a burst of notifyChange into one announce, then accepts the next trigger", async () => {
        const router = await startMockRouter();
        try {
            const announcer = testAnnouncer({ routerUrls: [router.url] });
            announcer.start();
            for (let i = 0; i < 5; i++) announcer.notifyChange();
            await waitUntil(() => router.puts.length >= 1);
            await new Promise((resolve) => setTimeout(resolve, 100)); // no straggler ticks
            expect(router.puts).toHaveLength(1);
            announcer.notifyChange();
            await waitUntil(() => router.puts.length >= 2);
            announcer.stop();
        } finally {
            await router.stop();
        }
    });

    it("re-announces on the periodic interval without any change trigger", async () => {
        const router = await startMockRouter();
        try {
            const announcer = testAnnouncer({ routerUrls: [router.url], intervalMs: 30 });
            announcer.start();
            await waitUntil(() => router.puts.length >= 2);
            announcer.stop();
        } finally {
            await router.stop();
        }
    });

    it("re-announces when the address set changes (self:peer:update)", async () => {
        const router = await startMockRouter();
        try {
            const libp2p = fakeLibp2p();
            const announcer = testAnnouncer({ routerUrls: [router.url], libp2p });
            announcer.start();
            expect(libp2p.listenerCount()).toBe(1);
            libp2p.fireAddressChange();
            await waitUntil(() => router.puts.length >= 1);
            announcer.stop();
            expect(libp2p.listenerCount()).toBe(0);
        } finally {
            await router.stop();
        }
    });

    it("announces wildcard sentinels when only private interface addrs exist (NAT/Docker-bridge, no config)", async () => {
        const router = await startMockRouter();
        try {
            const announcer = testAnnouncer({
                routerUrls: [router.url],
                libp2p: fakeLibp2p(["/ip4/127.0.0.1/tcp/4001", "/ip4/192.168.1.7/tcp/4001"])
            });
            announcer.start();
            announcer.notifyChange();
            await waitUntil(() => router.puts.length >= 1);
            announcer.stop();
            expect(router.puts[0]!.body.Providers[0]!.Payload.Addrs).toEqual(["/ip4/0.0.0.0/tcp/4001"]);
        } finally {
            await router.stop();
        }
    });

    it("announces nothing when only loopback addrs exist (not listening on any rewritable interface)", async () => {
        const router = await startMockRouter();
        try {
            const announcer = testAnnouncer({
                routerUrls: [router.url],
                libp2p: fakeLibp2p(["/ip4/127.0.0.1/tcp/4001", "/ip6/::1/tcp/4001"])
            });
            announcer.start();
            announcer.notifyChange();
            await new Promise((resolve) => setTimeout(resolve, 150));
            announcer.stop();
            expect(router.puts).toHaveLength(0);
        } finally {
            await router.stop();
        }
    });

    it("announces nothing when there are no keys (no joined contests)", async () => {
        const router = await startMockRouter();
        try {
            const announcer = testAnnouncer({ routerUrls: [router.url], keys: async () => [] });
            announcer.start();
            announcer.notifyChange();
            await new Promise((resolve) => setTimeout(resolve, 150));
            announcer.stop();
            expect(router.puts).toHaveLength(0);
        } finally {
            await router.stop();
        }
    });

    it("isolates a failing router: the healthy one still receives, the failure only reaches onError", async () => {
        const failing = await startMockRouter({ status: 503 });
        const healthy = await startMockRouter();
        try {
            const onError = vi.fn();
            const announcer = testAnnouncer({ routerUrls: [failing.url, healthy.url], onError });
            announcer.start();
            announcer.notifyChange();
            await waitUntil(() => healthy.puts.length >= 1 && onError.mock.calls.length >= 1);
            announcer.stop();
            expect(onError).toHaveBeenCalledWith(failing.url, expect.any(Error));
        } finally {
            await failing.stop();
            await healthy.stop();
        }
    });

    it("a hung router hits the per-router timeout instead of blocking the tick", async () => {
        const hung = await startMockRouter({ hang: true });
        const healthy = await startMockRouter();
        try {
            const onError = vi.fn();
            const announcer = testAnnouncer({ routerUrls: [hung.url, healthy.url], timeoutMs: 100, onError });
            announcer.start();
            announcer.notifyChange();
            await waitUntil(() => healthy.puts.length >= 1 && onError.mock.calls.length >= 1);
            announcer.stop();
            expect(onError.mock.calls[0]![0]).toBe(hung.url);
        } finally {
            await hung.stop();
            await healthy.stop();
        }
    });

    it("notifyChange before start is inert, and stop cancels a pending debounce", async () => {
        const router = await startMockRouter();
        try {
            const announcer = testAnnouncer({ routerUrls: [router.url], debounceMs: 50 });
            announcer.notifyChange(); // not started — inert
            announcer.start();
            announcer.notifyChange();
            announcer.stop(); // cancels the armed debounce before it fires
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(router.puts).toHaveLength(0);
        } finally {
            await router.stop();
        }
    });
});

/**
 * The production router's `cleanAddrs` (pkc-http-router lib/utils.ts), mirrored faithfully:
 * strip the nodejs `::ffff:` prefix from the source IP; rewrite ONLY the exactly-unspecified
 * leading component of the matching family to the source IP and drop the other family's
 * unspecified addrs; then drop any addr whose leading IP does not equal the source IP (except
 * `p2p-circuit` addrs). The one production step skipped is the final private-IP drop — the real
 * router's own `NO_IP_VALIDATE` test mode skips it for the same reason we must: a loopback test
 * connection's observed source IP is itself private.
 */
function cleanAddrsMirror(addrs: string[], reqIp: string): string[] {
    if (reqIp.startsWith("::ffff:")) reqIp = reqIp.slice("::ffff:".length);
    if (net.isIP(reqIp) === 4) {
        addrs = addrs.filter((a) => !a.startsWith("/ip6/::")).map((a) => a.replace(/^\/ip4\/0\.0\.0\.0(\/|$)/, `/ip4/${reqIp}$1`));
    } else if (net.isIP(reqIp) === 6) {
        addrs = addrs.filter((a) => !a.startsWith("/ip4/0.0.0.0")).map((a) => a.replace(/^\/ip6\/::(\/|$)/, `/ip6/${reqIp}$1`));
    }
    return addrs.filter((addr) => {
        const ip = addr.match(/^\/ip(?:4|6)\/([^/]+)/)?.[1];
        if (ip === undefined) return true; // dns etc — the production router passes them through
        return ip === reqIp || addr.includes("p2p-circuit");
    });
}

/** A mock router that applies {@link cleanAddrsMirror} at PUT time, storing what production would store. */
async function startRewritingRouter(): Promise<{
    url: string;
    records: Array<{ sourceIp: string; addrs: string[]; id: string; keys: string[] }>;
    stop: () => Promise<void>;
}> {
    const records: Array<{ sourceIp: string; addrs: string[]; id: string; keys: string[] }> = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            const sourceIp = req.socket.remoteAddress ?? "";
            const body = JSON.parse(raw) as ReceivedPut["body"];
            for (const provider of body.Providers) {
                records.push({
                    sourceIp: sourceIp.startsWith("::ffff:") ? sourceIp.slice("::ffff:".length) : sourceIp,
                    addrs: cleanAddrsMirror(provider.Payload.Addrs, sourceIp),
                    id: provider.Payload.ID,
                    keys: provider.Payload.Keys
                });
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ProvideResults: [] }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/`,
        records,
        stop: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            })
    };
}

describe("end-to-end against the production router's cleanAddrs semantics", () => {
    it("a NAT'd node's synthesized sentinels become the PUT's actual source IP; no unspecified addr survives", async () => {
        const router = await startRewritingRouter();
        try {
            // Only private interface addrs (the new-plebbit shape: loopback + a bridge), both
            // families — the announcer must synthesize /ip4/0.0.0.0 + /ip6/:: sentinels itself.
            const announcer = testAnnouncer({
                routerUrls: [router.url],
                libp2p: fakeLibp2p([
                    "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAnnouncerPeer",
                    "/ip4/172.31.0.1/tcp/4001/p2p/12D3KooWAnnouncerPeer",
                    "/ip6/fd00::1/tcp/4001/p2p/12D3KooWAnnouncerPeer"
                ]),
                keys: async () => ["bafyCriteria", "bafyRoot"]
            });
            announcer.start();
            announcer.notifyChange();
            await waitUntil(() => router.records.length >= 1);
            announcer.stop();

            const record = router.records[0]!;
            // The stored record carries the request's ACTUAL source IP where the sentinel stood...
            expect(record.sourceIp).not.toBe("");
            expect(record.addrs).toEqual([`/ip4/${record.sourceIp}/tcp/4001/p2p/12D3KooWAnnouncerPeer`]);
            // ...the cross-family /ip6/:: sentinel was dropped by the router (the PUT came over v4)...
            expect(record.addrs.join()).not.toContain("::");
            // ...and nothing unspecified leaked into what the router stores.
            expect(record.addrs.some((a) => a.includes("0.0.0.0"))).toBe(false);
            expect(record.id).toBe("12D3KooWAnnouncerPeer");
            expect(record.keys).toEqual(["bafyCriteria", "bafyRoot"]);
        } finally {
            await router.stop();
        }
    });

    it("a configured wildcard announce addr (kubo style) is rewritten the same way", async () => {
        const router = await startRewritingRouter();
        try {
            // addresses.announce = ['/ip4/0.0.0.0/tcp/4001'] makes getMultiaddrs() return the
            // wildcard verbatim — the pass-through path, no synthesis involved.
            const announcer = testAnnouncer({
                routerUrls: [router.url],
                libp2p: fakeLibp2p(["/ip4/0.0.0.0/tcp/4001/p2p/12D3KooWAnnouncerPeer"])
            });
            announcer.start();
            announcer.notifyChange();
            await waitUntil(() => router.records.length >= 1);
            announcer.stop();

            const record = router.records[0]!;
            expect(record.addrs).toEqual([`/ip4/${record.sourceIp}/tcp/4001/p2p/12D3KooWAnnouncerPeer`]);
            expect(record.addrs.some((a) => a.includes("0.0.0.0"))).toBe(false);
        } finally {
            await router.stop();
        }
    });
});

describe("makeAnnouncer (browser stub)", () => {
    it("is inert: start/notifyChange/stop never announce", async () => {
        const router = await startMockRouter();
        try {
            const announcer = makeBrowserAnnouncer({
                routerUrls: [router.url],
                libp2p: fakeLibp2p(),
                keys: async () => ["bafyCriteria"],
                debounceMs: 1,
                intervalMs: 5
            });
            announcer.start();
            announcer.notifyChange();
            await new Promise((resolve) => setTimeout(resolve, 100));
            announcer.stop();
            expect(router.puts).toHaveLength(0);
        } finally {
            await router.stop();
        }
    });
});
