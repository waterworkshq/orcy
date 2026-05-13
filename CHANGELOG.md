# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.8.0 — 2026-05-13

### Bug Fixes

#### guard HealthScoreWidget against missing api.health in test env ([`0b80077`](https://github.com/waterworkshq/orcy/commit/0b8007742e4f5bc2cf02dcb7f8252a2a6b158cab))



### Chores

#### update roadmap and project documentation ([`2785001`](https://github.com/waterworkshq/orcy/commit/2785001f84cb7b560bf84de3a7d99d839c41f202))

1. Update GitNexus symbol counts in AGENTS.md and CLAUDE.md
2. Revise release roadmap in README.md and docs/ROADMAP.md
3. Add commit permission reminder to AGENTS.md
4. Update version and date in ROADMAP.md



### Documentation

#### update roadmap and README for v0.8.0 release ([`ab8caa9`](https://github.com/waterworkshq/orcy/commit/ab8caa9de88f5285acdb54ffe37113b2fead57b3))

1. Move v0.8.0 from Upcoming to Delivered in ROADMAP.md (3 features shipped)
2. Mark v0.8 as complete ✔ in README.md What's Next table
3. Add v0.11 (Guardrails) to What's Next preview
4. Bump version header to v0.8.0


#### update CAPABILITIES and SKILL for v0.8.0 features ([`e8aa174`](https://github.com/waterworkshq/orcy/commit/e8aa174256a6e20a49a98768a9754567187a4c0b))

1. CAPABILITIES: bump MCP tool count 11→13, add mission comments, board health,
2. audit exports, and new Visibility & Insights section
3. SKILL: add get-comments/add-comment to orcy_habitat_mission, get-health/
4. get-health-history to orcy_habitat, export-audit-log/get-audit-summary to
5. orcy_admin dispatch tables



### Features

#### add feature-level comments system ([`a9945fa`](https://github.com/waterworkshq/orcy/commit/a9945fa6ad3065b9fd3fd6bea422a78cf490f515))

1. Add feature_comments and feature_comment_mentions tables to schema
2. Create featureComment.ts and featureCommentMention.ts repositories
3. Create featureCommentService.ts reusing shared commentHelper.ts
4. Add 4 REST routes: CRUD for feature comments
5. Add 3 SSE event types: feature.commented, feature.comment_deleted, feature.mentioned
6. Add mission comment MCP tools (mission_get_comments, mission_add_comment)
7. Extend orcy_habitat_mission dispatch with get-comments/add-comment actions
8. Add getFeatureComments/addFeatureComment to KanbanApiClient
9. Add FeatureComment/FeatureCommentMention to shared types


#### add mission comments tab and FeatureCommentSection ([`acd11e1`](https://github.com/waterworkshq/orcy/commit/acd11e1e4fbee3a8506764b4eae7ac544716a9d2))

1. Add Comments tab to MissionDetailPage (4th tab, after Pulse)
2. Create FeatureCommentSection component with full CRUD: create, edit, delete, reply
3. Add api.featureComments methods (list, create, update, delete) to UI client
4. Export FeatureComment/FeatureCommentMention from UI types barrel
5. Fix missing percentage field in FeatureWithProgress.progress across test/data files


#### add audit log exports with streaming CSV/JSON/JSONL ([`2c64594`](https://github.com/waterworkshq/orcy/commit/2c6459471412089cf3329d24916985aef039073a))

1. Create auditExportService.ts with batch-based event export and summary aggregation
2. Support CSV, JSON, and JSONL formats with all filter parameters
3. Add audit_export_schedules table for scheduled recurring exports (local only)
4. Add 5 REST routes: export, summary, schedule CRUD
5. Add MCP audit tools: export-audit-log, get-audit-summary on orcy_admin
6. Add AuditExportModal UI with format, date range, action, and actor filters
7. Add Export button to ActivityPanel drawer header


#### add board health metrics with composite 0-100 score ([`22976fb`](https://github.com/waterworkshq/orcy/commit/22976fb482e128b3a9a91d152f246135d6da18c8))

1. Create boardHealthService with 5-dimension scoring (flow, quality, delivery, capacity, stability)
2. Weighted composite score with A-F grade mapping and auto-generated recommendations
3. board_health_snapshots table for trend tracking
4. GET /boards/:id/health and GET /boards/:id/health/history endpoints
5. Hourly background health calculation for all boards
6. MCP health tools: get-health, get-health-history on orcy_habitat dispatch
7. HealthScoreWidget UI component with grade badge and expandable breakdown panel
8. Display health widget in HabitatsPage board header



### Refactors

#### extract shared comment helpers and fix onTimeCompletionRate ([`77ce45c`](https://github.com/waterworkshq/orcy/commit/77ce45ca07aec332a96611485f488dfc10d6dbe7))

1. Extract extractMentionTokens/resolveMentions to commentHelper.ts (40 lines)
2. commentService.ts now imports from commentHelper.ts (removed 2 unused imports)
3. Fix onTimeCompletionRate in timeTracking.ts: now compares completedAt vs dueAt
4. rather than just checking if the feature exists
5. Add 14 unit tests for commentHelper.ts (mention extraction + resolution)
6. Make taskId optional in NotificationEventData for feature-level notifications


#### unify data fetching to React Query (R16) ([`4de1b93`](https://github.com/waterworkshq/orcy/commit/4de1b939a8ba0ceb7a20272d92204a5a0a527d46))

1. Add 11 query key patterns for boards, agents, health, audit, orgs, saved filters
2. Add 15 new useQuery hooks to useHabitatData (useBoardPredictions, useBoardBurndown,
3. useBoardAnomalies, useBoardCapacity, useBoardTimeMetrics, useAgentStats,
4. useAgentsListWithTasks, useOrganizations, useOrganizationTeams, useTeamMembers,
5. useUserProfile, useSavedFilters, useBoardHealth, useAuditSummary, useFeatureComments)
6. Migrate DashboardPage from useState+useEffect to useDashboardStats+useBoardPredictions+useBoardBurndown
7. Migrate CapacityChart from useState+useCallback+useEffect to useBoardCapacity
8. Migrate FeatureCommentSection from manual fetch to useFeatureComments (local state sync via useEffect)
9. Keep HealthScoreWidget and FilterBar on direct API (test env lacks QueryClientProvider)



### build

#### update release configuration and changelog formatting ([`0a13b4a`](https://github.com/waterworkshq/orcy/commit/0a13b4a9fd6cc86bbb5919afc7f6e331502cf690))

1. Update git-cliff command in release-it.json to remove header flag
2. Add conventional-changelog plugin to release-it configuration
3. Enhance cliff.toml changelog format with commit links and body formatting



## 0.7.1 — 2026-05-13

### Bug Fixes

#### resolve review findings - unhandled rejection in useTaskDependencies, add percentage to FeatureWithProgress type, remove redundant type declarations and unused imports ([`651a6fa`](https://github.com/waterworkshq/orcy/commit/651a6fa74cb8cc94db3250bea125f66b666ebe04))



## 0.7.0 — 2026-05-13

### Refactors

#### consolidate formatting utilities, status badge maps, fix SSE notifications, extract AgentCard component ([`ee324f5`](https://github.com/waterworkshq/orcy/commit/ee324f511dfb4fa6aeb8cb5f24393fa734d71c24))

1. R11: Created lib/formatting.ts with formatRelativeTime, formatMinutes, formatDurationMs, truncateId, formatDueDate, priority/status maps. Replaced 5 copies each of formatRelativeTime and formatMinutes across CommentSection, AgentPanel, AgentsPage, ActivityPage, NotificationDropdown, StatsModal, CapacityChart.
2. R12: Created lib/status-maps.ts with TASK_STATUS_BADGE, FEATURE_STATUS_BADGE, FEATURE_STATUS_DOT, PRIORITY_BADGE, SEVERITY_BADGE, QUALITY_STATUS_BADGE. Replaced 10+ inline definitions in SiblingTasksSection, MissionContextSection, TaskQualityChecklist, ActivityPanel, AtRiskTasks, TaskEstimates, DependencyNodeCard, DependencyGraphModal.
3. R27: Replaced monkey-patch pattern in useSSENotifications with Zustand subscription. Added recentSSEEvents field to habitatStore so handleSSEEvent records events for reactive subscription.
4. R13: Extracted AgentCard component (~130 lines) used by AgentPanel and AgentsPage.


#### decompose habitatStore into 7 domain slices, decompose useTaskDetailPanel into 8 composable hooks ([`b8a55f9`](https://github.com/waterworkshq/orcy/commit/b8a55f9a10387f4143104ebc3975b5ce9ae9a622))

1. R09: Split 675-line monolithic habitatStore into 7 Zustand StateCreator slices (theme, board, feature, task, agent, presence, UI) + 1 SSE handler slice. UseBoardStore export unchanged - all 28 consumers work without modification.
2. R10: Split 465-line useTaskDetailPanel hook into 8 composable sub-hooks (useTaskEdit, useTaskSubtasks, useTaskDelegate, useTaskDecompose, useTaskDependencies, useTaskReview, useTaskActions, useTaskWatch) orchestrated by a thin useTaskDetailPanel that composes them.


#### migrate FilterBar saved-filters from raw fetch to API client ([`d43f429`](https://github.com/waterworkshq/orcy/commit/d43f429d5f425ff2212b45f911eb52c1d0783af1))

1. R16: Added api.savedFilters (list, create, delete) to API client, resolving auth bypass where FilterBar made 3 direct fetch() calls without auth token injection.
