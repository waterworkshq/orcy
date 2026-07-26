import type { FastifyInstance } from "fastify";
import * as pluginManager from "./pluginManager.js";

/**
 * Crash-loud activation contract (ADR-0041): `loadPlugins` failures are
 * non-fatal (a malformed plugin is recorded in pluginErrors; the server
 * boots without it) while `initializePlugins` failures are fatal (a throwing
 * `routeHandlers` poisons the Fastify instance and the server cannot boot).
 * The two regimes MUST NOT share a catch — the shared "continuing without
 * plugins" message lies for the fatal case.
 *
 * Extracted verbatim from `index.ts` so the two catch regimes are unit-testable
 * without spawning the full compiled server. The boot sequence order
 * (loadPlugins → initializePlugins) is identical to the pre-extraction code;
 * `index.ts` calls this at exactly the point the inline try/catches used to
 * live (after `loadQuarantinesFromDb`, before `initDaemonWiring`).
 *
 * @returns Resolves on the non-fatal path (boot continues). On the fatal path
 *          `process.exit(1)` is invoked and the function never resolves.
 */
export async function runPluginBoot(fastify: FastifyInstance): Promise<void> {
  try {
    await pluginManager.loadPlugins();
  } catch (err) {
    fastify.log.error({ err }, "Failed to load plugins - continuing without plugins");
  }

  try {
    await pluginManager.initializePlugins(fastify);
    const loaded = pluginManager.getLoadedPlugins();
    if (loaded.length > 0) {
      fastify.log.info({ plugins: loaded }, "Plugins loaded");
    }
  } catch (err) {
    fastify.log.error({ err }, "Plugin route initialization failed - server cannot boot");
    process.exit(1);
  }
}
