# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.22.10 — 2026-06-29

### Features

#### automation condition contribution kind + reference plugin ([`9abc949`](https://github.com/waterworkshq/orcy/commit/9abc949ba4889f5ee4e904941bba642b92c3cc4d))

1. Second extraction using the v0.22.8 foundation (ADR-0022):

3. Add 'plugin' variant to AutomationCondition union: { type: plugin,
4. conditionId, params }. Plugin conditions are leaf nodes in the recursive
5. condition tree (and/or/not composition stays in-tree).

7. Add automationCondition as 7th contribution kind (system-scoped, no
8. capabilities, no enrollment — condition handlers are stateless pure
9. functions, the automation rule provides per-habitat scoping).

11. Condition handlers are SYNCHRONOUS (evaluator + all callers are sync).
12. No PluginContext — evaluation context passed directly as argument
13. (same pattern as formatters).

15. PluginEvaluationContext strips agent apiKeyHash/rateLimitPerMinute,
16. uses PluginHabitatView for habitat, minimal projections for
17. mission/sprint. Task passed as-is (no auth-bearing fields).

19. Fail-safe contract: missing handler or handler error returns
20. { matched: false } — critical because evaluateCondition runs on the
21. workflow gate evaluation path where a throw would block transitions.

23. Reference plugin: condition-rejection-spike (matches tasks with N+
24. rejections, demonstrates params passing).
