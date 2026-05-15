# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.9.2 — 2026-05-15

### Bug Fixes

#### review round 2 — 20 issues from v0.9.0 post-release audit ([`dc476fc`](https://github.com/waterworkshq/orcy/commit/dc476fc351ab360765724d4773fb8e7577cbdc80))

1. Fix broken notExists subquery in getAvailableTasksForAgent (correlated to outer task)
2. Add claimExecution CAS guard to prevent duplicate scheduled task execution
3. Restrict agent access to team boards in verifyTaskBoardAccess
4. Remove eager loading of all board features in HabitatPage
5. Preserve tab component state via CSS hidden instead of conditional rendering
6. Fix stale closure in TaskTableView row selection sync
7. Add proper Zod discriminatedUnion validation for prioritization rules
8. Fix virtualized table rows using proper tr/td instead of divs
9. Fix double-counted domain match bonus in task suggestions
10. Deduplicate overdue SSE events with notified ID tracking
11. Sanitize boardId in audit export file paths
12. Add 300ms debounce on task table search input
13. Verify template-board association in applyTemplate route
14. Add confirmation dialog for bulk task deletion
15. Isolate per-task errors in prioritization applyPrioritization loop
16. Add error state for failed task loading in TaskTableView
17. Disable once-type scheduled tasks after first execution
18. Escape LIKE wildcards in task search queries
19. Add crypto.randomUUID fallback for non-secure contexts + cap notifications at 100
20. Add IANA timezone select with validation in ScheduledTaskForm


#### correct git-cliff releaseNotes hook for unreleased tags ([`cd0c863`](https://github.com/waterworkshq/orcy/commit/cd0c863ac2348a02ec198124afe86c6b50238c15))



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
