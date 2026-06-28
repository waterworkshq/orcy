import type { PluginModule } from "../../packages/api/src/plugins/types.js";

/**
 * auto-label reference plugin (v0.22.0 stub).
 *
 * The v0.21 `KanbanPlugin` hook shape was removed in v0.22.0. The full rewrite
 * as a `lifecycleInterceptor` (post phase, `taskCreated`, requires `pulseWriter`)
 * lands in Phase 9. This stub exports a valid new-shape module that does nothing
 * so the loader accepts it and the typecheck stays green.
 */
const autoLabelPlugin: PluginModule = {
  manifest: {
    id: "auto-label",
    version: "0.22.0-stub",
    description: "Auto-label plugin (stub — full rewrite in Phase 9).",
    contributions: [],
  },
};

export default autoLabelPlugin;
