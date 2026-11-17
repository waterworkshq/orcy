import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run-scoped wire coordinator: compiles shared/daemon/api/mcp ONCE per
    // run, before any worker spawns, when a wire test is selected. Without
    // this, parallel wire files each rebuild the same dist/ trees from their
    // beforeAll hooks and the spawned API child can link a half-written
    // module (empty file -> missing named export) while the other build is
    // still emitting.
    globalSetup: ["src/test/wireGlobalSetup.ts"],
  },
});
