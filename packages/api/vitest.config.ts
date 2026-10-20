import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/test/**/*.test.ts"],
    // Run-scoped coordinator: compiles the api package ONCE per run and
    // publishes it atomically for every compiled consumer. A run that selects
    // no compiled consumer does not build at all.
    globalSetup: ["src/test/compiledApiGlobalSetup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/services/**/*.ts", "src/repositories/**/*.ts", "src/config/**/*.ts"],
    },
  },
});
