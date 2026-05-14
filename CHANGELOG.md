# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.9.1 — 2026-05-14

### Bug Fixes

#### restore API.md and add missing v0.8.0+v0.9.0 endpoint documentation ([`46856ae`](https://github.com/waterworkshq/orcy/commit/46856ae7fabbd99802556a4f6992fd5bba9d4104))

1. Restore 2071 lines of API docs accidentally deleted in v0.9.0 release
2. Add Board Health section (GET /boards/:id/health, /health/history)
3. Add Board Tasks section (GET /boards/:id/tasks with sort/filter)
4. Add Prioritization section (rules CRUD + evaluate + report)
5. Add Scheduled Tasks section (8 endpoints: CRUD + run/enable/disable)
6. Add Feature Comments section (4 endpoints)
7. Add Audit Log Export section (export + summary + schedules)
8. Add apply-template route to Features section
9. Add 11 new SSE events (priority_changed, scheduled_task.*, feature.comment*)



## 0.9.0 — 2026-05-14

### Bug Fixes

#### add SLA deadline support to task scoring ([`70646d9`](https://github.com/waterworkshq/orcy/commit/70646d9cabf4d9e480805e2a5911836c3dfbac9d))

1. Add computeSlaUrgencyWeight() to taskScoring.ts reading feature.slaDeadlineAt
2. Integrate SLA urgency into scoreTask() sum with max weight of 35
3. Add SLA factors and reasons to taskSuggestion.ts SuggestionFactors
4. slaDeadlineAt null does not affect scores (backward compatible)
5. Fix duplicate SLA calculation in scoreWithFactors() — scoreTask already includes it



### Chores

#### gitignore exports/ and update remaining refactored files ([`d2c2cfc`](https://github.com/waterworkshq/orcy/commit/d2c2cfc091ef13fac9fb0ef3050b46ae2a1d64db))

1. Add packages/api/exports/ to .gitignore (test artifact output)
2. Update board repository with prioritizationSettings handling
3. Update test factory and dispatch tests for new actions



### Documentation

#### update all documentation for v0.9.0 release ([`8e38599`](https://github.com/waterworkshq/orcy/commit/8e38599f5a8acf45d8350d99a5b1b1db00f102e2))

1. ROADMAP.md: move v0.9.0 from Upcoming to Delivered, bump version
2. README.md: mark v0.9.0 complete, add v0.12 and v0.13 to preview
3. CAPABILITIES.md: add Task Board View, Prioritization, Recurring Tasks
4. SKILL.md: update MCP dispatch tables with new actions
5. API.md, DATABASE.md, ARCHITECTURE.md: add new endpoints, tables, services



### Features

#### add board-level task list route with server-side sorting ([`4f1f4b6`](https://github.com/waterworkshq/orcy/commit/4f1f4b692b8424aa3c9193f2e992cc2e1c7b8439))

1. Extend getTasksByBoardId() with sortBy/sortDirection params
2. Add GET /boards/:id/tasks route with sort and filter support
3. Change batch route auth from agentAuth to agentOrHumanAuth
4. Add useBoardTasks React Query hook
5. Add board tasks query key pattern


#### add task board view with sortable table and view toggle ([`df31527`](https://github.com/waterworkshq/orcy/commit/df31527addf9fab1267bc5baf52fa65a0937217c))

1. Install @tanstack/react-table v8 and @tanstack/react-virtual v3
2. Build reusable DataTable component (sort, select, column visibility)
3. Create TaskTableView with columns: priority, title, status, assignee, effort
4. Add TaskBulkActionBar for batch priority/status/delete operations
5. Add task-level selection state to Zustand store
6. Add Board/Table view toggle in FilterBar with ?view= URL param
7. Wire table/kanban conditional rendering in HabitatPage


#### add dynamic prioritization rules engine ([`0feb4c0`](https://github.com/waterworkshq/orcy/commit/0feb4c0e4bef4847373913bad4d26308f2e762eb))

1. Create prioritizationService following anomalyService pattern
2. 10 condition types with AND/OR combinators, 4 action types
3. Per-board JSON settings (prioritizationSettings on boards)
4. Background evaluation every 5 minutes via scheduler
5. GET/PUT /boards/:id/rules + POST /boards/:id/rules/evaluate
6. MCP: get-rules, update-rules, evaluate-rules on orcy_habitat
7. SSE: task.priority_changed event on rule fire


#### add prioritization rules editor in board settings ([`c256071`](https://github.com/waterworkshq/orcy/commit/c256071a55a0dddf9563f9e04cb533078eeaa831))

1. Create PrioritizationTab with JSON editor for rule configuration
2. Show rule template with all condition types and examples
3. Validate JSON before save, show inline errors
4. Enable/disable toggle for the entire rule engine
5. Register tab in HabitatSettingsDialog
6. Add api.boards.getPrioritizationRules/updatePrioritizationRules methods


#### add applyTemplate() to create features from templates ([`07b4d53`](https://github.com/waterworkshq/orcy/commit/07b4d53ee047f72a96c520576f49d577ce472c5b))

1. Implement applyTemplate() creating feature + child tasks from tasksTemplate
2. Add tasksTemplate field to CreateTemplateInput and UpdateTemplateInput
3. Add POST /templates/:id/apply route
4. Handle edge cases: missing template, empty tasksTemplate, template deleted


#### add recurring scheduled tasks with cron-based execution ([`b5e398d`](https://github.com/waterworkshq/orcy/commit/b5e398d61e873f35fb0890a8c85adeda14f219a0))

1. Create scheduledTaskService following retryService polling pattern
2. Implement processDueTasks() checking nextRunAt <= now every 60s
3. executeScheduledTask() creates feature via applyTemplate()
4. nextRunAt recomputed via cron-parser for cron schedules
5. Wire audit export schedules into shared polling loop
6. Add 8 CRUD routes: create, list, get, update, delete, run, enable, disable
7. MCP: list-scheduled-tasks, create-scheduled-task, run-scheduled-task on orcy_admin
8. SSE events: scheduled_task.executed, scheduled_task.failed, scheduled_task.created


#### add scheduled tasks management UI ([`4aae64d`](https://github.com/waterworkshq/orcy/commit/4aae64d05b54049a3ed194d8a2755ee59aff8827))

1. Create ScheduledTasksList with enable/disable toggle, run/delete buttons
2. Create ScheduledTaskForm with template selector and cron input
3. Add cron expression help text with common patterns
4. Register as Scheduled Tasks tab in board settings
5. Validate cron expressions and interval inputs before save



### Refactors

#### add shared infra — cron-parser, schema types, scheduled_tasks ([`c3277d0`](https://github.com/waterworkshq/orcy/commit/c3277d07d387b62dc4c468c190d16b2975cb8f5d))

1. Add cron-parser dependency to packages/api
2. Define PrioritizationSettings interface in shared types
3. Define TaskTemplateEntry type, fix tasksTemplate from unknown[]
4. Add prioritizationSettings JSON column on boards
5. Add scheduled_tasks table (24 columns, 3 indexes, 2 FKs)
6. Add task-level selection state to uiSlice
7. Single migration (0006) consolidates all v0.8.0+v0.9.0 schema changes



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
