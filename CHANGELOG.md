# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.9.3 — 2026-05-15

### Bug Fixes

#### complete R16 React Query unification with review fixes ([`5d5b369`](https://github.com/waterworkshq/orcy/commit/5d5b3695a94211e58a064ada2c8d82230aee88cd))

1. Migrate all 17 UI components from useEffect+api/Zustand patterns to
2. React Query. Includes review round 1 fixes: mutation hooks for
3. CreateMissionForm/CreateTaskForm, cache invalidation in
4. FeatureCommentSection, standardized query keys, expanded test coverage,
5. and ConfirmDialog migration.



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
