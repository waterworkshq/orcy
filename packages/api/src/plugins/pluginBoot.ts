import type { FastifyInstance } from "fastify";
import * as pluginManager from "./pluginManager.js";

/**
 * Two-regime plugin boot contract: `loadPlugins` failures are non-fatal (a
 * malformed plugin is recorded in pluginErrors; the server boots without it)
 * while `initializePlugins` failures are fatal. The two regimes MUST NOT share
 * a catch — the shared "continuing without plugins" message lies for the fatal
 * case.
 *
 * Since ADR-0050, `initializePlugins` no longer executes plugin code at mount
 * time: it hands the pre-validated route catalog to the core installer, so a
 * failure there is a core registration fault (still boot-fatal), not a plugin
 * handler fault. The superseded ADR-0041 crash-loud unrestricted-callback
 * mount case no longer exists.
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
