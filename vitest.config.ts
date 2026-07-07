import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        // Integration tests stand up real libp2p nodes and are slow; they run only via
        // `npm run test:integration` (vitest.integration.config.ts), never in the unit suite.
        exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
        environment: "node"
    }
});
