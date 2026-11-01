/**
 * TEST-ONLY Vite preview config for the seeded Learning Loop Playwright run
 * (#147). Wraps the production `vite.config.ts` unchanged and overrides ONLY
 * the preview proxy/port so the browser harness talks to its own short-lived
 * API server — no production config edit, no new production env variable.
 *
 * `127.0.0.1:3147` is the `API_PORT` constant in `playwright.seeded.config.ts`
 * (and `5147` its `UI_PORT`); keep them in lockstep when either changes.
 */
import { defineConfig, type UserConfig } from "vite";
import baseConfig from "./vite.config.ts";

const E2E_API_TARGET = "http://127.0.0.1:3147";

export default defineConfig(async (args) => {
  const base = (await baseConfig(args)) as UserConfig;
  return {
    ...base,
    preview: {
      ...base.preview,
      port: 5147,
      proxy: {
        "/api": { target: E2E_API_TARGET, changeOrigin: true },
        "/sse": { target: E2E_API_TARGET, changeOrigin: true },
      },
    },
  };
});
