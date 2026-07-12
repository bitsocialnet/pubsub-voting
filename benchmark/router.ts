import http from "node:http";
import { CID } from "multiformats/cid";

/**
 * A minimal **Delegated Routing V1** HTTP server — the benchmarks' stand-in for the HTTP content
 * routers a pkc-js host configures (`@helia/delegated-routing-v1-http-api-client`, no DHT). Two
 * sides, mirroring the production router (pkc-http-router):
 *
 *   - `GET /routing/v1/providers/{cid}` answers with the known provider records for that CID,
 *     after an artificial latency that models a real over-the-internet router lookup;
 *   - `PUT /routing/v1/providers` accepts kubo-shape unsigned announces
 *     (`{ Providers: [{ Payload: { ID, Addrs, Keys } }] }`) — this is what the seeder's
 *     `httpRouterUrls` announcer writes, so the cold-join bench exercises the announce path
 *     end-to-end instead of a hardcoded record.
 *
 * Keys are normalized by multihash exactly like the production router (`normalizeCid`:
 * `CID.create(1, dag-pb, cid.multihash)` on both announce and lookup), so dag-cbor criteria /
 * root / chunk CIDs round-trip. Unlike production there is NO source-IP address validation: the
 * bench announce arrives through an SSH reverse tunnel (source 127.0.0.1), which production's
 * `cleanAddrs` would misjudge — the announcer's own client-side filtering is under unit test
 * instead (src/transport/announce).
 *
 * Out-of-band control endpoints (never latency-charged, never logged as lookups):
 *   - `GET /_records` — every stored record, keyed by normalized CID (orchestrator readiness poll);
 *   - `GET /_requests` — the provider-lookup log, with epoch timestamps so another local process
 *     (the cold joiner) can map them onto its own clock;
 *   - `POST /_reset` — clear the lookup log and re-arm the one-time latency (between repeats).
 */

export interface RouterProvider {
    /** The provider's peer id (string form). */
    id: string;
    /** Dialable multiaddrs for the provider (announced, or seeded with `/p2p/<id>` included). */
    addrs: string[];
}

export interface RouterOptions {
    /**
     * Pre-seeded records: CID string → provider (the directory bench still hardcodes its records;
     * the cold-join bench starts empty and lets the seeder announce). Keys are normalized like
     * announced ones. Any unknown CID answers no providers.
     */
    providers?: Map<string, RouterProvider>;
    /** Artificial latency (ms) before a provider-hit lookup responds — paid once (see below). Default 1000. */
    latencyMs?: number;
}

/** One served provider lookup. `startMs`/`endMs` are process-local `performance.now()`; the epoch pair is for cross-process mapping. */
export interface RouterRequest {
    cid: string;
    startMs: number;
    endMs: number;
    startEpochMs: number;
    endEpochMs: number;
}

export interface RunningRouter {
    /** Base URL to hand `delegatedRoutingV1HttpApiClientContentRouting({ url })` — or the announcer. */
    url: string;
    port: number;
    /** Every provider lookup served, in order (for the cold-join latency breakdown). */
    requests: RouterRequest[];
    /** The stored records, keyed by normalized CID (in-process view of `GET /_records`). */
    records(): Map<string, RouterProvider[]>;
    /** The providers announced/seeded for `cid` (normalized lookup — the orchestrator's readiness poll). */
    providersFor(cid: string): RouterProvider[];
    /** Re-arm the one-time latency + clear the lookup log (in-process view of `POST /_reset`). */
    reset(): void;
    stop(): Promise<void>;
}

/** The production router's key normalization: same multihash → same storage key, codec-blind. */
function normalizeCid(cid: string): string {
    const parsed = CID.parse(cid);
    return CID.create(1, 0x70, parsed.multihash).toString();
}

/** Read a request body to completion (announce PUTs are small). */
function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => resolve(raw));
        req.on("error", reject);
    });
}

/** Start the local delegated-routing server on an ephemeral loopback port. */
export async function startRouter(options: RouterOptions = {}): Promise<RunningRouter> {
    const latencyMs = options.latencyMs ?? 1000;
    const requests: RouterRequest[] = [];
    /** normalized CID → one record per announcing/seeded peer (latest announce wins per peer). */
    const records = new Map<string, RouterProvider[]>();
    for (const [cid, provider] of options.providers ?? []) {
        records.set(normalizeCid(cid), [provider]);
    }
    // The simulated ~1s router round-trip is paid EXACTLY ONCE per reset — the initial provider
    // lookup that finds who runs the contest. After that, bitswap's IWANT takes over peer-to-peer,
    // so every later lookup (a repeat, or a block-CID probe now that chunks are announced too)
    // answers instantly and never re-adds latency.
    let paidLatency = false;
    const reset = (): void => {
        paidLatency = false;
        requests.length = 0;
    };

    const server = http.createServer((req, res) => {
        void (async () => {
            // --- out-of-band control endpoints (no latency, no lookup log) ---
            if (req.url === "/_records") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(Object.fromEntries(records)));
                return;
            }
            if (req.url === "/_requests") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(requests));
                return;
            }
            if (req.url === "/_reset" && req.method === "POST") {
                reset();
                res.writeHead(200).end();
                return;
            }

            // --- the announce path: unsigned kubo-shape PUT, one record per (key, peer) ---
            if (req.url === "/routing/v1/providers" && req.method === "PUT") {
                let body: { Providers?: Array<{ Payload?: { ID?: string; Addrs?: string[]; Keys?: string[] } }> };
                try {
                    body = JSON.parse(await readBody(req));
                } catch {
                    res.writeHead(400).end(JSON.stringify({ Error: "invalid JSON body" }));
                    return;
                }
                if (!Array.isArray(body?.Providers)) {
                    res.writeHead(400).end(JSON.stringify({ Error: 'invalid body, expected {"Providers": [...]}' }));
                    return;
                }
                try {
                    for (const provider of body.Providers) {
                        const { ID, Addrs, Keys } = provider.Payload ?? {};
                        if (typeof ID !== "string" || !Array.isArray(Addrs) || !Array.isArray(Keys)) continue;
                        if (Addrs.length === 0) continue; // production drops addr-less providers too
                        for (const key of Keys) {
                            const normalized = normalizeCid(key); // throws on garbage → 400 below
                            const existing = records.get(normalized) ?? [];
                            records.set(normalized, [...existing.filter((p) => p.id !== ID), { id: ID, addrs: Addrs }]);
                        }
                    }
                } catch (e) {
                    res.writeHead(400).end(JSON.stringify({ Error: (e as Error).message }));
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ProvideResults: [] }));
                return;
            }

            // --- the lookup path the joiner's contentRouting queries ---
            const match = req.url?.match(/^\/routing\/v1\/providers\/([^/?]+)/);
            if (!match || req.method !== "GET") {
                res.writeHead(404).end();
                return;
            }
            const cid = match[1]!;
            const startMs = performance.now();
            const startEpochMs = Date.now();
            let found: RouterProvider[] | undefined;
            try {
                found = records.get(normalizeCid(cid));
            } catch {
                found = undefined; // unparseable CID → no providers, like an unknown one
            }
            const bodyOut = JSON.stringify({
                Providers: (found ?? []).map((p) => ({ Schema: "peer", ID: p.id, Addrs: p.addrs }))
            });
            const delay = found?.length && !paidLatency ? latencyMs : 0;
            if (found?.length) paidLatency = true;
            setTimeout(() => {
                requests.push({ cid, startMs, endMs: performance.now(), startEpochMs, endEpochMs: Date.now() });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(bodyOut);
            }, delay);
        })().catch(() => {
            res.writeHead(500).end();
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    return {
        url: `http://127.0.0.1:${port}/`,
        port,
        requests,
        records: () => records,
        providersFor: (cid) => {
            try {
                return records.get(normalizeCid(cid)) ?? [];
            } catch {
                return [];
            }
        },
        reset,
        stop: () =>
            new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    };
}
