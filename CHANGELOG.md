# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.17.2 — 2026-06-10

### Performance

#### add effort metrics recalculation and transition debouncing ([`a52c609`](https://github.com/waterworkshq/orcy/commit/a52c60989e17b41720c552f5ec827ab5494b734a))

1. This change implements automatic recalculation of effort metrics when tasks are completed or approved, ensuring consistent actualMinutes values. It also introduces transition recalculation debouncing via the ORCY_TRANSITION_RECALC_DEBOUNCE environment variable to optimize performance in high-frequency transition scenarios.

3. The implementation adds error handling for effort metric recalculations and includes comprehensive test coverage for the new functionality. Additionally, it defines which task actions trigger notifications via the notifyTaskEvent system to prevent inconsistencies.



## 0.17.1 — 2026-06-10

### Features

#### consolidate task transition side-effects and split API client domains ([`369bd1c`](https://github.com/waterworkshq/orcy/commit/369bd1c7c52a9dde2607e221641d29d4ad14b5b1))

1. This change introduces the TransitionEmitter module to consolidate the scattered task transition side-effect chain (DB write → event → SSE → watcher → mission recalc) into a single `emitTransition` function. It also implements the API Client Domain Split, defining 23 per-domain interfaces with `KanbanApiClient` as the typed facade, per-domain mock factories (33% → 100% method coverage), and extracts `getMissionContext` to a standalone orchestrator service.

3. The consolidation resolves a correctness gap where effort metrics recompute was inconsistent across task transitions, and normalizes a notification race condition that became visible after the new `notifyTaskEvent` gating was implemented.



## 0.17.0 — 2026-06-06

### Bug Fixes

#### improve tool schemas and error handling (P3-3, P3-4, P3-5, P3-6) ([`7624d07`](https://github.com/waterworkshq/orcy/commit/7624d070917d8badcc16575c88c3e34d94303975))


#### extract shared components, design tokens, error boundaries (P3-7, P3-8, P3-9, P3-10, P3-12, P3-13) ([`15a0a99`](https://github.com/waterworkshq/orcy/commit/15a0a99ddd219663da900c7bc77608a28d268481))


#### add confirmation dialog for sprint cancel (P3-11) ([`6dc291d`](https://github.com/waterworkshq/orcy/commit/6dc291d9b06414a1434f8407410b6d2fbe267ddc))

1. Sprint cancellation is destructive — it uncommits all missions and marks
2. the sprint as cancelled permanently. Added a ConfirmDialog with danger
3. variant that warns 'This will uncommit all missions and mark the sprint
4. as cancelled. This cannot be undone.' before proceeding.



### Documentation

#### add prominent prerelease warnings across all user-facing docs ([`69b65f1`](https://github.com/waterworkshq/orcy/commit/69b65f11e3e6a2819f1c165c3ee101aed457649d))

1. Orcy is in active 0.x prerelease. People landing on the repo need to
2. understand immediately that this is not production-ready software.
3. Added clear warnings at every major entry point:

5. README.md: Full prerelease warning block right after the intro,
6. plus a reminder callout in the Quick Start section
7. docs/INSTALL.md: Warning at the 'Production Install' section that
8. clarifies 'production' here means 'end-user self-hosted', not
9. 'customer-facing production workload'
10. docs/HUMAN-GUIDE.md: Warning at the top of the pod member guide
11. docs/ARCHITECTURE.md: Inline prerelease note
12. docs/API.md: Inline prerelease note at the API reference

14. All warnings link back to the main README warning via anchor link so
15. readers can find the full disclaimer from any doc.


#### add comprehensive schema workflow documentation ([`5e64d69`](https://github.com/waterworkshq/orcy/commit/5e64d698a2be370e75818ae96d6ef53b3ac5dd69))



### Features

#### add audit provenance foundation ([`4cf09e4`](https://github.com/waterworkshq/orcy/commit/4cf09e4b369f760732389f97faa7434efdc5a141))

1. Define shared canonical audit types, add request/MCP provenance context, centralize v0.17 audit event emission, normalize projected system actors, preserve mission events across mission deletion, and attribute integration-sync mission side effects.


#### add canonical audit exports and bundles ([`d447bfa`](https://github.com/waterworkshq/orcy/commit/d447bfa89f4b358b337db429513a54c5366c6547))

1. Project task, mission, effort, code evidence, provider, webhook, and health records into canonical AuditEvent rows; switch audit exports to canonical CSV/JSON/JSONL; add entity-scoped audit bundles; include completeness summaries and integrity-ready CSV fields; update archival to write canonical task/mission audit envelopes.


#### expose scoped audit bundle access ([`114975d`](https://github.com/waterworkshq/orcy/commit/114975dec50122ffc7c7f7d263b5786c4029fed4))

1. Add MCP audit provenance headers, forward canonical audit export filters, preserve existing admin audit tool exports, and expose task/mission get-audit-bundle actions through scoped dispatch tools.


#### add confidence-aware analytics forecasts ([`4c1674b`](https://github.com/waterworkshq/orcy/commit/4c1674ba5a232719e70c16e2a798f4444f0a457c))


#### add cumulative flow analytics and bottleneck detection ([`55a75a8`](https://github.com/waterworkshq/orcy/commit/55a75a8926c91d900cc13b8997390af33e63c845))

1. This commit introduces comprehensive flow analytics capabilities to the platform, enabling teams to visualize and optimize their workflow patterns. The implementation includes:

3. New database schema for cumulative flow snapshots to track task counts across columns over time
4. Services for generating cumulative flow diagrams and detecting bottlenecks in the workflow
5. Sprint analytics with metrics, burndown charts, and carry-over analysis
6. UI components for visualizing flow analytics and sprint performance
7. API endpoints to expose these analytics capabilities

9. The changes add significant value by providing teams with insights into their workflow efficiency, identifying bottlenecks, and helping improve delivery predictability.


#### add agent quality analytics and signals ([`cdd9d78`](https://github.com/waterworkshq/orcy/commit/cdd9d78e035924b68cf8a1562587a717d89441d9))

1. Adds comprehensive agent quality analytics to track performance signals across multiple dimensions including approval rates, evidence completeness, estimate accuracy, and consistency. Implements a new API endpoint at `/habitats/:habitatId/agent-quality` that returns informational quality signals with confidence levels and sample sizes.

3. The implementation includes:
4. New agent quality service with confidence-aware scoring
5. UI components to display quality signals with non-punitive caveats
6. MCP tools for accessing agent quality data
7. Analytics integration for habitat and sprint dashboards
8. Comprehensive test coverage for all new functionality

10. Agent quality signals are informational only and do not affect assignment, review, eligibility, or permissions.


#### add advanced analytics and audit trail v2 ([`645c6c2`](https://github.com/waterworkshq/orcy/commit/645c6c209bf896c0484a0d2d2dbf743494e6d080))

1. Introduces comprehensive analytics endpoints including forecasts, cumulative flow, bottleneck detection, agent quality signals, and sprint metrics. Adds audit trail v2 with canonical exports, scoped evidence bundles, and completeness tracking. Updates MCP tools to expose new analytics capabilities and audit bundle access. Enhances documentation across API, architecture, capabilities, and roadmap to reflect these new features.



### Refactors

#### optimize database schema and performance ([`8752fd3`](https://github.com/waterworkshq/orcy/commit/8752fd39d8891304b2f8a0de1fc1ed27b1c64f73))

1. Removes duplicate unique indexes from cumulative flow snapshots and updates mission comments to use soft deletes instead of cascading deletes. Improves query performance by optimizing the cumulative flow snapshot repository with a more efficient upsert pattern. Updates audit query service to support pagination and improves error handling across multiple services.


#### extract shared analytics date utility ([`58b01ee`](https://github.com/waterworkshq/orcy/commit/58b01ee1ae635c91232a6e8762712d19ebde095a))


#### migrate analytics services to shared date utility (P2-14) ([`e37d828`](https://github.com/waterworkshq/orcy/commit/e37d82877a4a8b7a28ad3602ff6944e8575e8600))

1. All analytics services now import MS_PER_DAY, utcDateKey, daysAgoISO,
2. utcNowISO, diffDays, daysUntil, confidenceForSample, and AnalyticsWarning
3. from the shared analyticsDate utility. Removes 7 local msDay definitions
4. and local confidenceForSample duplicates. Standardizes all analytics
5. date boundaries to UTC.

7. Services updated:
8. trendService
9. timeInColumnService
10. cumulativeFlowService
11. agentQualityService
12. boardHealthService
13. boardSummaryService
14. bottleneckService
15. capacityService
16. anomalyService
17. auditArchivalService
18. predictionService
19. sprintAnalyticsService


#### remove admin tool, move batch actions to task dispatch (P3-2) ([`a3c8fd0`](https://github.com/waterworkshq/orcy/commit/a3c8fd085c841e69f148b8c74261497355d3a490))

1. The orcy_admin dispatch tool exposed webhook/template/audit/scheduled-task
2. management to MCP. Since humans use CLI and WebUI for those operations,
3. and MCP is for programmatic/AI use, the admin tool has been removed from
4. tool registration.

6. The 3 agent-useful actions (batch-assign, batch-set-priority, batch-delete)
7. have been moved into the orcy_habitat_task dispatch tool. The taskIds
8. and assigneeId shared params are now available there. Required param
9. validation enforced via TASK_REQUIRED_PARAMS.

11. The admin dispatch tool file and exports are preserved for backward
12. compatibility and existing tests, but the tool is no longer registered
13. in ALL_TOOLS or wired into the MCP server's TOOL_HANDLERS.

15. Test updates:
16. tools.task.test.ts: now asserts batch actions live under orcy_habitat_task
17. tools.task-batch.test.ts: rewritten to use TASK_DISPATCH_HANDLER
18. task-dispatch.test.ts: counts updated from 36 to 39 actions


#### consolidate schema, fix snapshots, simplify test init (P2-15, P2-16 + cleanup) ([`09d24f4`](https://github.com/waterworkshq/orcy/commit/09d24f4a05c11cdead0e88fd55c1bf7a4b751693))
