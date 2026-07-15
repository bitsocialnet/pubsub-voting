/**
 * Provider-record announcer types (see DESIGN.md "Deferred pkc-js work", provider-record
 * announces). The announcer is the write side of the delegated-routing seam: querying rides the
 * injected node's `libp2p.contentRouting` (the host wires its routers into `libp2p.services`), but
 * the pinned js stack has NO working announce path — `@helia/delegated-routing-v1-http-api-client`'s
 * `provide()` is a literal noop — so provider records only get written by a direct
 * `PUT /routing/v1/providers` to each router. This library is the node that actually holds the
 * state (topic membership, fetch responder, blockstore), so its records are always truthful and
 * current; `PubsubVoterOptions.httpRouterUrls` exists ONLY because announcing cannot ride the
 * `contentRouting` seam.
 *
 * The implementation is Node-only: the browser build swaps `node.js` for the inert `browser.js`
 * stub via the package.json `browser` field (the same remap as `src/storage/`), because a browser
 * peer is not dialable and must never announce.
 */

/**
 * The slice of the injected node's libp2p the announcer reads, declared structurally (a running
 * `Libp2p` satisfies it). `self:peer:update` fires when the node's address set changes — an
 * AutoTLS certificate landing, a WebRTC-Direct certhash rotation — and triggers a re-announce so
 * records never carry stale addresses for more than a debounce window.
 */
export interface AnnouncerLibp2p {
    peerId: { toString(): string };
    getMultiaddrs(): Array<{ toString(): string }>;
    addEventListener(type: "self:peer:update", listener: () => void): void;
    removeEventListener(type: "self:peer:update", listener: () => void): void;
}

export interface AnnouncerOptions {
    /** Delegated Routing V1 base URLs to PUT provider records to. Empty means never announce. */
    routerUrls: readonly string[];
    /** The injected node's libp2p (peer id, current addresses, address-change events). */
    libp2p: AnnouncerLibp2p;
    /**
     * The CIDs to announce, collected fresh per tick: every joined contest's criteria CID plus its
     * current checkpoint root + chunk CIDs, batched into ONE record (`Keys` is an array) so a
     * directory host costs one request per router per tick. An empty list skips the tick.
     */
    keys(): Promise<string[]>;
    /** Re-announce cadence (ms). Test seam; defaults to hourly (see `ANNOUNCE_INTERVAL_MS`). */
    intervalMs?: number;
    /** Change-coalescing window (ms). Test seam; defaults to `ANNOUNCE_DEBOUNCE_MS`. */
    debounceMs?: number;
    /** Per-router PUT deadline (ms). Test seam; defaults to `ANNOUNCE_ROUTER_TIMEOUT_MS`. */
    timeoutMs?: number;
    /**
     * Per-router failure hook (timeout, non-2xx, network error). Purely observational — a failing
     * router never throws into the voter and is not retried; the next tick covers it.
     */
    onError?(url: string, error: unknown): void;
}

/** The voter-facing announcer handle. All methods are synchronous and idempotent. */
export interface Announcer {
    /**
     * Begin announcing: subscribe to address changes and arm the periodic re-announce. Called when
     * the voter's first topic joins (symmetric with the lazy fetch-responder lifecycle). Does not
     * announce by itself — the join that triggered it also calls {@link notifyChange}.
     */
    start(): void;
    /**
     * Stop announcing and drop timers/listeners. Called when the last topic is left. Records
     * already written age out by the router's TTL; there is no un-announce.
     */
    stop(): void;
    /**
     * Coalesced re-announce trigger: a contest joined, a checkpoint root changed, or the address
     * set changed. The first call arms one debounce timer; further calls within the window ride
     * it, so a gossip burst (or a directory-wide join) costs one announce.
     */
    notifyChange(): void;
}
