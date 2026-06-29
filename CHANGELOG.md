# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.22.5 — 2026-06-29

### Bug Fixes

#### reader scope, veto timing, auth, dead hook bus, boot order ([`fc2f74c`](https://github.com/waterworkshq/orcy/commit/fc2f74c5c501ae615c063c7a5ab7b84c6f163ed7))

1. v0.22.5 Plugin Review Fixes: Security & Wiring:
