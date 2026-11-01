/**
 * Dedicated vitest config for the seeded-harness safety suite (#147).
 * The shared vitest.config.ts excludes e2e/** (Playwright specs are not
 * vitest tests); this config opts in ONLY the safety suite, with the node
 * environment — no browser, no servers, no builds required.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/playwright.seeded.safety.test.ts"],
  },
});
