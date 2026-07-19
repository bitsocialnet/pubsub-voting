import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        // Integration tests stand up real libp2p nodes and are slow; they run only via
        // `npm run test:integration` (vitest.integration.config.ts), never in the unit suite.
        exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
        environment: "node",
        coverage: {
            provider: "v8",
            include: ["src/**"],
            // Test infrastructure, not shipped code: the shared fixtures and the integration
            // harness (the latter is only exercised by the integration suite anyway).
            exclude: ["src/**/*.test.ts", "src/test-fixtures.ts", "src/transport/integration/**"],
            // Hold the line at the measured baseline (see `npm run test:coverage`), with a small
            // margin so unrelated changes don't flake the gate. A drop below these means new
            // code landed untested — add tests, don't lower the numbers.
            thresholds: {
                statements: 95,
                branches: 87,
                functions: 93,
                lines: 96
            }
        }
    }
});
