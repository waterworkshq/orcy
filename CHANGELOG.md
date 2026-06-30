# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.22.13 — 2026-06-30

### Refactors

#### optional scheduleType, deduplicate getHabitatId, export BadgeVariant ([`1d58a59`](https://github.com/waterworkshq/orcy/commit/1d58a59a95c2f99cd98600eb5246d434988f4ee5))

1. Make scheduleType optional in WikiSettings and SetCadenceInput, moving validation
2. into schema refine so it's only required when enabled is true. Extract currentHabitatId
3. once in approveTask instead of calling getHabitatId multiple times.

5. Replace JSON.parse(JSON.stringify) with structuredClone in MCP config writing.
6. Simplify duration parsing by removing the redundant ms-unit guard in parseDurationWindow.

8. Switch tests to vi.useFakeTimers for deterministic clock control instead of spin-waiting.
9. Export BadgeVariant from Badge.tsx and import it in formatting.ts and MissionCard to
10. remove the `as any` type cast. Apply consistent single-quote formatting across
11. affected UI files and remove DOM.Iterable from ui tsconfig.



## 0.22.12 — 2026-06-29

### Bug Fixes

#### shared write cap counter, action quarantine, PluginRun type widening ([`06c37aa`](https://github.com/waterworkshq/orcy/commit/06c37aa5622974d2f51138eb3dba21db21823dc7))

1. Code review fixes for the plugin extraction arc (v0.22.8–v0.22.11):



## 0.22.11 — 2026-06-29

### Features

#### automation action contribution kind + write capabilities (taskWriter activated) ([`9a0d06a`](https://github.com/waterworkshq/orcy/commit/9a0d06adfdb63c797fcfa66d1f826a69cec7d08d))

1. Third and final extraction in the plugin extraction arc (ADR-0023):

3. Add 'plugin' variant to AutomationAction union: { type: plugin,
4. actionId, params }. Plugin actions dispatch to registered handlers
5. with full PluginContext (write capabilities).

7. Add automationAction as 8th contribution kind (system-scoped, requires
8. taskWriter/notificationSender/webhookCaller per handler declaration).
9. CAPABILITY_MATRIX entry allows all 3 write capabilities.

11. ACTIVATE taskWriter (ADR-0020) — dormant since v0.22.8, now reachable
12. via automationAction contribution kind. Full write path tested.

14. Add notificationSender capability: wraps enqueueNotificationForRecipients
15. with habitat scoping, provenance stamping, rate cap.

17. Add webhookCaller capability: wraps fetch() with SSRF guard (same
18. patterns as in-tree executeCallWebhook), banned headers blocklist,
19. rate cap, habitat scoping.

21. dispatchActionHandler in pluginManager: startPluginRun + withTimeout
22. + finishRun — full run tracking for plugin actions.

24. Executor case 'plugin' dispatches via dynamic import (avoids circular
25. dependency). Simulation previewAction also handles 'plugin' case.

27. Reference plugin: action-create-followup (creates a follow-up task
28. using taskWriter.createTask, demonstrates params + evaluationCtx).
