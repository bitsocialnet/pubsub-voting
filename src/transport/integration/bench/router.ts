import http from "node:http";

/**
 * A minimal **Delegated Routing V1** HTTP server — the cold-join benchmark's stand-in for the HTTP
 * content routers a pkc-js host configures (`@helia/delegated-routing-v1-http-api-client`, no DHT).
 * It answers `GET /routing/v1/providers/{cid}` with a hardcoded provider record for the contest's
 * criteria CID, after an artificial latency that models a real over-the-internet router lookup.
 *
 * It deliberately answers ONLY the configured criteria CID (empty `Providers` otherwise), so a
 * cold node's bitswap block-CID lookups are not misdirected here — the benchmark isolates the ONE
 * routing call that matters: "who runs this contest?".
 */

export interface RouterProvider {
    /** The provider's peer id (string form). */
    id: string;
    /** Dialable multiaddrs for the provider (include `/p2p/<id>`). */
    addrs: string[];
}

export interface RouterOptions {
    /** criteria-CID string → the provider to return for it. Any other CID answers no providers. */
    providers: Map<string, RouterProvider>;
    /** Artificial latency (ms) before responding — models a real HTTP router. Default 1000. */
    latencyMs?: number;
}

/** One served provider lookup, timed with the process-wide `performance.now()` clock. */
export interface RouterRequest {
    cid: string;
    startMs: number;
    endMs: number;
}

export interface RunningRouter {
    /** Base URL to hand `delegatedRoutingV1HttpApiClientContentRouting({ url })`. */
    url: string;
    port: number;
    /** Every provider lookup served, in order (for the cold-join latency breakdown). */
    requests: RouterRequest[];
    stop(): Promise<void>;
}

/** Start the local delegated-routing server on an ephemeral loopback port. */
export async function startRouter(options: RouterOptions): Promise<RunningRouter> {
    const latencyMs = options.latencyMs ?? 1000;
    const requests: RouterRequest[] = [];
    // The simulated ~1s router round-trip is paid EXACTLY ONCE — the initial provider lookup that
    // finds who runs the contest. After that, bitswap's IWANT takes over peer-to-peer, so every
    // later lookup (a repeat, or a bitswap block probe) answers instantly and never re-adds latency.
    let paidLatency = false;

    const server = http.createServer((req, res) => {
        const match = req.url?.match(/^\/routing\/v1\/providers\/([^/?]+)/);
        if (!match) {
            res.writeHead(404).end();
            return;
        }
        const cid = match[1]!;
        const startMs = performance.now();
        const provider = options.providers.get(cid);
        const body = JSON.stringify({
            Providers: provider ? [{ Schema: "peer", ID: provider.id, Addrs: provider.addrs }] : []
        });
        const delay = provider && !paidLatency ? latencyMs : 0;
        if (provider) paidLatency = true;
        setTimeout(() => {
            requests.push({ cid, startMs, endMs: performance.now() });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(body);
        }, delay);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    return {
        url: `http://127.0.0.1:${port}/`,
        port,
        requests,
        stop: () =>
            new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    };
}
