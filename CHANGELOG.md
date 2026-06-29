# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.22.8 — 2026-06-29

### Features

#### data-driven capability matrix, startPluginRun utility, taskWriter write capability ([`c1cdf7d`](https://github.com/waterworkshq/orcy/commit/c1cdf7de4ad1479a53ed4c5bf9e270ee15160345))

1. Foundation for plugin extraction arc (v0.22.8–v0.22.11):

3. Replace hardcoded capabilityMatrixViolation if/else chain with
4. CAPABILITY_MATRIX table-driven lookup. Fixes latent v0.22.6 bug where
5. notificationChannel contributions were rejected for requiring
6. chatIntegrationReader.

8. Extract startPluginRun() utility from 3 dispatchers (channel, detector,
9. interceptor). Consolidates duplicated startRun + buildPluginContext
10. boilerplate into one call.

12. Add taskWriter write capability (ADR-0020): TaskWriter interface with
13. createTask, assignTask, releaseTask, updatePriority. Follows write-
14. capability pattern: habitat scoping, provenance stamping (plugin:ID),
15. structured logging, rate cap (ORCY_PLUGIN_WRITE_CAP default 50).
16. Ships DORMANT — no contribution kind in CAPABILITY_MATRIX allows it
17. yet; unreachable until v0.22.11 wires it into automationAction.



## 0.22.7 — 2026-06-29

### Bug Fixes

#### path traversal guard, timeout suppressor, scan sourceId, null habitat guard ([`98aa8e7`](https://github.com/waterworkshq/orcy/commit/98aa8e73da4118a0d609b28572c641453bf5974e))

1. v0.22.7 Loose Ends — final TIER 3 cleanup from v0.22 code review:

3. W19: realpath check in loadPlugins prevents symlink path traversal
4. W20: withTimeout .catch suppressor prevents unhandledRejection
5. W21: createDetectedSignal throws on null habitatId (was invalid FK)
6. W22: createPulseAndNotify broadcast contract documented in JSDoc
7. W23: task event sourceId now taskId:action (consistent live + scan)
8. W24: InterceptorVeto.details widened to string | Record<string, unknown>

10. API 3612 pass / 2 skipped, MCP 581 pass.

12. v0.22 code review complete: 9 CRITICAL + 15 WARNING + 6 TIER 3 resolved.



## 0.22.6 — 2026-06-29

### Features

#### add chatIntegrationReader capability and 4 channel migration plugins ([`15db80f`](https://github.com/waterworkshq/orcy/commit/15db80fe2eafe66c9c70f67ff64713b57662a9ae))

1. v0.22.6 Channel Migration:

3. ADR-0019: chatIntegrationReader capability (6th on PluginContext whitelist)
4. enables channel plugins to resolve per-habitat webhook URLs
5. ChatIntegrationView strips botToken (security boundary)
6. NotificationChannelContribution.requires widened from [] to PluginCapabilityName[]
7. 4 channel plugin modules created as thin wrappers calling existing deliverXxx
8. Gradual migration: hardcoded switch retained as backward-compat fallback
9. (dead code in production, active in test environments)
10. Plugins auto-load by default (PLUGINS_ENABLED unset → load all)

12. API 3612 pass / 2 skipped, MCP 581 pass.
