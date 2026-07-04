/**
 * A per-peer fixed-window rate gate for the forward-gate. Bounds how many messages one peer
 * can make us validate per window, capping the resource cost of a flood of plausible-looking
 * announcements (the residual "resource exhaustion, not incorrectness" concern in DESIGN.md
 * "Transport"). Over-rate returns `false`, which the gate maps to `ignore` — dropped without
 * a peer-score penalty, since being briefly over a local rate is not provable misbehavior.
 */
export function makeRateLimiter(opts: { limit: number; intervalMs: number }): (peer: string) => boolean {
    const windows = new Map<string, { count: number; start: number }>();
    return (peer: string): boolean => {
        const now = Date.now();
        const window = windows.get(peer);
        if (!window || now - window.start >= opts.intervalMs) {
            windows.set(peer, { count: 1, start: now });
            return true;
        }
        window.count += 1;
        return window.count <= opts.limit;
    };
}
