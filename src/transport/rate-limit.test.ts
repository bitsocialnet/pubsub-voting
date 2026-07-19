import { describe, it, expect, vi, afterEach } from "vitest";
import { makeRateLimiter } from "./rate-limit.js";

describe("makeRateLimiter (per-peer fixed window)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("allows exactly `limit` messages in one window, then refuses the rest", () => {
        const allow = makeRateLimiter({ limit: 3, intervalMs: 10_000 });
        expect(allow("peer1")).toBe(true);
        expect(allow("peer1")).toBe(true);
        expect(allow("peer1")).toBe(true);
        // The flood past the cap is refused — the gate maps this to `ignore`, no penalty.
        expect(allow("peer1")).toBe(false);
        expect(allow("peer1")).toBe(false);
    });

    it("tracks each peer independently (one flooder cannot starve the others)", () => {
        const allow = makeRateLimiter({ limit: 1, intervalMs: 10_000 });
        expect(allow("flooder")).toBe(true);
        expect(allow("flooder")).toBe(false);
        expect(allow("honest")).toBe(true); // unaffected by the flooder's exhausted window
    });

    it("opens a fresh window (and full allowance) once the interval elapses", () => {
        vi.useFakeTimers();
        const allow = makeRateLimiter({ limit: 2, intervalMs: 10_000 });
        expect(allow("peer1")).toBe(true);
        expect(allow("peer1")).toBe(true);
        expect(allow("peer1")).toBe(false);
        // Just short of the boundary the window (and its refusal) still holds...
        vi.advanceTimersByTime(9_999);
        expect(allow("peer1")).toBe(false);
        // ...at the boundary the window resets and the peer is admitted again.
        vi.advanceTimersByTime(1);
        expect(allow("peer1")).toBe(true);
        expect(allow("peer1")).toBe(true);
        expect(allow("peer1")).toBe(false);
    });
});
