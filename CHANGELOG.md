# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.11.1 — 2026-05-21

### Bug Fixes

#### enforce antiSelfReview, refactor ReviewRulesTab to React Query, optimize SprintDashboard ([`28543aa`](https://github.com/waterworkshq/orcy/commit/28543aa84e133d2b8a9d2d256bb3e679634cfc64))

1. Enforce antiSelfReview: exclude task creator from reviewer pool when flag enabled
2. ReviewRulesTab: replace manual useState+useEffect with useQuery/useMutation
3. and centralized queryKeys.reviewRules
4. SprintDashboard: shallow comparison on store selectors, useMemo for derived
5. data, fix velocity calculation (Math.floor), extract TERMINAL_STATUSES constant



## 0.11.0 — 2026-05-20

### Bug Fixes

#### address 10 critical/high review issues from v0.11 code review ([`6369bc7`](https://github.com/waterworkshq/orcy/commit/6369bc7d7d155072621e800a1c4193740c1c0f13))



### Features

#### v0.11 foundation — schema, migrations, repos, review assignment service ([`3167e2f`](https://github.com/waterworkshq/orcy/commit/3167e2f41c260ae6b22934ece61b154c555b5d31))

1. Phase 0 - Foundation:
2. Shared types: review.ts (ReviewRule, TaskReviewer), sprint.ts (Sprint, SprintMetrics)
3. SSE events: task.review_assigned, task.review_completed, sprint.created/started/completed
4. Schema: review_rules + task_reviewers tables, sprints table, sprintId on missions,
5. carryOverPolicy on habitats, notification preferences expansion
6. Migrations: 0009_review_rules, 0010_add_sprints, 0011_notifications_expand
7. Repositories: reviewRule (6 methods), taskReviewer (9 methods), sprint (10 methods)

9. Phase 1 slim slice - Review Assignment Service:
10. Rule matching by domain, labels, priority
11. Reviewer assignment via 5 strategies (domain_expert, round_robin, least_loaded, random, fixed)
12. Approval tracking (hasAssignedReviewers, isAssignedReviewer, recordApproval,
13. hasAllRequiredApprovals)
14. 16 unit tests, zero regressions (1308 total API tests passing)


#### sprint service — CRUD, state transitions, mission sync, carry-over ([`e1b8149`](https://github.com/waterworkshq/orcy/commit/e1b8149f6b487c4b2298a62766c6ecca19f376b4))

1. Sprint lifecycle: planning → active → completed, planning/active → cancelled
2. Mission-sprint sync: add/remove missions in planning, validates same habitat
3. Carry-over policies on complete: backlog, next_sprint, none (configurable per habitat)
4. Guard: only one active sprint per habitat, blocks structural edits on active sprints
5. SSE events: sprint.created, sprint.started, sprint.completed
6. 19 unit tests, zero regressions (1327 total API tests passing)
7. Fix: sprintRepo.getById returned undefined instead of null


#### review rules + sprint API routes and MCP dispatch tools ([`e8fed7f`](https://github.com/waterworkshq/orcy/commit/e8fed7fc515be927333128a91c59cf9cfde65868))

1. API Routes:
2. reviewRules.ts: 7 endpoints (list/create/update/delete rules, list/add/remove reviewers)
3. sprints.ts: 11 endpoints (CRUD + active + start/complete/cancel + add/remove mission)

5. MCP Dispatch:
6. review.ts + review-dispatch.ts: orcy_review tool (7 actions)
7. sprint.ts + sprint-dispatch.ts: orcy_sprint tool (11 actions)
8. 15 HTTP client methods added to MCP api.ts

10. Shared types:
11. Added sprintId: string | null to Mission interface

13. Test fixes:
14. Updated 11 test fixtures across API (2) and UI (9) for new sprintId field
15. 2570 tests passing, zero regressions


#### complete all v0.11 backend — lifecycle, scheduler, notifications, SSE ([`6a44e4c`](https://github.com/waterworkshq/orcy/commit/6a44e4cdfbd2e3920a86514217a9eb387ea347d5))

1. Task Lifecycle Integration (Step 1.2):
2. submitTask: assigns reviewers on submit, emits task.review_assigned SSE
3. approveTask: multi-approval gate, stays submitted until N approvals
4. completeTask: blocks with REVIEW_REQUIRED when reviews pending
5. Route handler: REVIEW_REQUIRED → 422
6. 12 integration tests, backward compatible (no rules = legacy)

8. Scheduler (Step 2.2):
9. autoCompleteSprints() in sprintService for expired sprints
10. 5-minute interval wired into scheduler.ts

12. Prediction (Step 2.3):
13. calculateVelocity/getBurndown accept optional sprintId filter
14. Burndown uses sprint date range when sprintId provided

16. Notifications (Step 3.1):
17. Email templates: priorityChangedTemplate, reviewAssignedTemplate
18. Notification types: task.priority_changed, task.review_assigned
19. Prefs repo + route schema: taskReviewAssigned, taskPriorityChanged toggles

21. SSE Wiring (Step 5.1):
22. broadcaster: sprint. prefix in webhook dispatch
23. broadcaster: notification triggers for review_assigned + priority_changed

25. 1339 tests passing, zero regressions


#### add review rules management and task reviewer UI ([`5140b4d`](https://github.com/waterworkshq/orcy/commit/5140b4d9ab5099bc16050b181a1e04d1f0add95a))

1. Add review rules API endpoints and types for CRUD operations
2. Implement ReviewRulesTab component for managing review rules in habitat settings
3. Enhance ReviewPanel to display task reviewers with status badges and icons
4. Update useTaskReview hook to fetch reviewers and current user context
5. Add query keys for reviewers and user profile
6. Include test coverage for ReviewPanel component


#### sprint management UI — selector, planning panel, dashboard, badge ([`74b9237`](https://github.com/waterworkshq/orcy/commit/74b9237f6a06c2ad7f5c95ad7ee9b696db29f6d9))

1. SprintSelector: header dropdown with active sprint name + days remaining
2. SprintPlanningPanel: drawer with sprint CRUD, start/complete/cancel,
3. mission add/remove, inline dashboard with burndown chart
4. SprintDashboard: metrics cards (missions, tasks, days, velocity) reusing
5. existing BurndownChart with sprint date filter
6. SprintBadge: status-colored sprint indicator pill
7. MissionCard: sprint indicator when feature has sprintId
8. api.sprints: 8 API client methods (list, getActive, create, start,
9. complete, cancel, addMission, removeMission)
10. queryKeys.sprints: list, active, detail
11. Mocked SprintSelector/SprintPlanningPanel in 5 HabitatPage test files
12. 1219 UI tests pass, typecheck clean


#### visual rule builder — data-driven PrioritizationTab rewrite ([`f814a1f`](https://github.com/waterworkshq/orcy/commit/f814a1fa524ee49521f26baa2b33067f4a4d04db))

1. Replace JSON textarea with sortable rule cards using @dnd-kit/sortable.
2. Data-driven config tables (CONDITIONS/ACTIONS) with generic renderField<T>()
3. eliminate switch-case blocks. Adding a new condition/action type = one
4. config entry, zero code changes elsewhere.

6. SortableRuleCard: drag handle, enable toggle, collapsed preview, expand
7. to edit condition/action editors side-by-side
8. ConditionEditor: 10 leaf condition types with dynamic parameter fields
9. ActionEditor: 4 action types with dynamic value inputs
10. Composite condition (and/or) warning with replace-to-leaf dropdown
11. Advanced Mode (JSON): collapsible textarea for power users
12. Grid layout for dependency_count (greaterThan + direction side-by-side)
13. 18 tests: rendering, add/edit/delete, drag reorder, composite warning,
14. advanced JSON validation, save via ref
15. 1225 UI tests pass, typecheck clean, zero regressions


#### complete v0.11 UI — mobile table, notifications, SSE, integration tests ([`e7a8b80`](https://github.com/waterworkshq/orcy/commit/e7a8b80d81324f24da94931880164aed058b18e7))

1. TaskCardList: mobile card-based table view with useIsMobile conditional
2. NotificationsTab: taskReviewAssigned + taskPriorityChanged toggles
3. useSSE: cache invalidation for review/sprint/priority events (5 cases)
4. NotificationPreferences UI type synced with backend
5. Cross-feature integration tests: sprint+review lifecycle (5 tests)



## 0.10.2 — 2026-05-19

### Bug Fixes

#### fix prioritization template naming, enrich priority_changed SSE event, add self-approval deprecation warning ([`c095214`](https://github.com/waterworkshq/orcy/commit/c095214638f5535a4198215d3129c49a05020ad1))

1. PrioritizationTab RULE_TEMPLATE: feature_status → mission_status, label fix
2. prioritizationService: capture old priority before action, only emit
3. task.priority_changed when priority actually changes, include
4. oldPriority/newPriority in SSE event data
5. task-lifecycle: add deprecation warning when agents self-complete
6. tasks without human review (gated enforcement in v0.11 review rules)
7. shared/events: update task.priority_changed discriminated union type
