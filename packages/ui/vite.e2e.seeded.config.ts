/**
 * TEST-ONLY Vite preview config for the seeded Learning Loop Playwright run
 * (#147). Wraps the production `vite.config.ts` unchanged and overrides ONLY
 * the preview proxy/port so the browser harness talks to its own short-lived
 * API server — no production config edit, no new production env variable.
 *
 * Ports come from the shared side-effect-free `seeded.harness.constants.ts`,
 * so the Playwright constants and this preview proxy cannot drift apart.
 */
import { defineConfig, type UserConfig } from "vite";
import baseConfig from "./vite.config.ts";
import { API_PORT, UI_PORT } from "./seeded.harness.constants.ts";

const E2E_API_TARGET = `http://127.0.0.1:${API_PORT}`;

export default defineConfig(async (args) => {
  const base = (await baseConfig(args)) as UserConfig;
  return {
    ...base,
    preview: {
      ...base.preview,
      port: UI_PORT,
      proxy: {
        "/api": { target: E2E_API_TARGET, changeOrigin: true },
        "/sse": { target: E2E_API_TARGET, changeOrigin: true },
      },
    },
  };
});
