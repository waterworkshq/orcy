# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.22.4 — 2026-06-29

### Bug Fixes

#### quarantine key mismatch, pre-interceptor run leak, detected signal pipeline ([`33ee6c7`](https://github.com/waterworkshq/orcy/commit/33ee6c7c392f66d916b2f45eee811f47f1ea5db5))

1. v0.22.4 Plugin Review Fixes: Runtime & Pipeline:
