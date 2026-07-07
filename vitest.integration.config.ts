import { defineConfig } from "vitest/config";

/**
 * Integration suite: the two-node gossipsub test (`src/transport/integration/*.integration.test.ts`)
 * stands up real libp2p + Helia + `@libp2p/gossipsub` nodes over loopback TCP, so it is slow and
 * kept out of the default `npm test`. Run it with `npm run test:integration`. Generous timeouts
 * because mesh graft, peer-score decay ticks, and bitswap block transfer all settle on gossipsub
 * heartbeats — the tests poll for those conditions rather than sleeping a fixed amount.
 */
export default defineConfig({
    test: {
        include: ["src/**/*.integration.test.ts"],
        environment: "node",
        testTimeout: 60_000,
        hookTimeout: 60_000
    }
});
