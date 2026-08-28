import type { HttpRuntimeHandle } from "../httpApp.js";
import * as pluginManager from "./pluginManager.js";

/**
 * Two-regime plugin boot contract: `loadPlugins` failures are non-fatal (a
 * malformed plugin is recorded in pluginErrors; the server boots without it)
 * while catalog installation / detector-hook failures are fatal. The two
 * regimes MUST NOT share a catch — the shared "continuing without plugins"
 * message lies for the fatal case.
 *
 * Since ADR-0050, no plugin code executes at mount time: operational
 * discovery (`loadPlugins`) has already validated the route catalog, and the
 * staged HTTP assembly (ADR-0049) is the single route installer — this
 * function hands the validated catalog to the assembly's one-shot
 * `installPluginRoutes` lifecycle step and then activates the operational
 * detector hooks. A failure in either is a core registration fault (still
 * boot-fatal), not a plugin handler fault.
 *
 * Extracted verbatim from `index.ts` so the two catch regimes are unit-testable
 * without spawning the full compiled server (see pluginBoot.test.ts). The boot
 * sequence order (loadPlugins → install → registerDetectorHooks) is identical
 * to the pre-extraction code; `index.ts` calls this at exactly the point the
 * inline try/catches used to live (after `loadQuarantinesFromDb`, before
 * `initDaemonWiring`).
 *
 * @returns Resolves on the non-fatal path (boot continues). On the fatal path
 *          `process.exit(1)` is invoked and the function never resolves.
 */
export async function runPluginBoot(app: HttpRuntimeHandle): Promise<void> {
  try {
    await pluginManager.loadPlugins();
  } catch (err) {
    app.log.error({ err }, "Failed to load plugins - continuing without plugins");
  }

  try {
    await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
    pluginManager.registerDetectorHooks();
    const loaded = pluginManager.getLoadedPlugins();
    if (loaded.length > 0) {
      app.log.info({ plugins: loaded }, "Plugins loaded");
    }
  } catch (err) {
    app.log.error({ err }, "Plugin route initialization failed - server cannot boot");
    process.exit(1);
  }
}
