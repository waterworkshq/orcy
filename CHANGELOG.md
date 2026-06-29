# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.22.9 — 2026-06-29

### Features

#### webhook formatter contribution kind + 3 reference plugins ([`e025ceb`](https://github.com/waterworkshq/orcy/commit/e025ceb61d055cb924cd5fbf796939d313b96752))

1. First extraction using the v0.22.8 foundation (ADR-0021):

3. Add webhookFormatter as 6th contribution kind (system-scoped, pure
4. function handlers with no PluginContext — mirrors McpToolHandler
5. pattern). Handlers transform (enrichment, eventType, deliveryId)
6. into a provider-specific payload object.

8. Add formatterRegistry to pluginManager with getFormatterHandler()
9. export. Plugin-first lookup in webhook-dispatch.ts formatPayload()
10. with in-tree FORMATTER_REGISTRY as backward-compat fallback (gradual
11. migration, same pattern as notification channels).

13. 3 reference plugins: formatter-standard, formatter-slack,
14. formatter-discord — thin wrappers calling existing in-tree
15. formatXxxPayload functions.

17. Data-driven CAPABILITY_MATRIX entry: webhookFormatter has empty
18. allowed list (no capabilities needed).

20. Mock pluginManager in 2 webhook test files to prevent transitive
21. schema import chain from breaking existing mocks.



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
