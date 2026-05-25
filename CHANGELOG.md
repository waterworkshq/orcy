# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.12.1 — 2026-05-25

### Chores

#### replace __dirname with import.meta.dirname, rename unused reply params, add no-underscore-dangle allow list ([`03a3c01`](https://github.com/waterworkshq/orcy/commit/03a3c016fabcc637ea74c20585103bff1b2416f3))

1. Replace __dirname/fileURLToPath with import.meta.dirname in 6 files
2. Rename unused reply → _reply in 133 Fastify route/middleware handlers
3. Rename _onmessage/_onerror → messageHandler/errorHandler in SSE test
4. Add 20-entry allow list for test mock helpers and module-private singletons

6. 567 warnings → 366 warnings (201 cleared, 0 errors introduced)


#### remove unused imports and parameters, migrate to ES2023 array methods ([`9667019`](https://github.com/waterworkshq/orcy/commit/96670191e35c507583c0d1946777d90d1d86484e))

1. Replace `.sort()` with `.toSorted()` and `.reverse()` with `.toReversed()`
2. Fix variable shadowing in `.reduce()` callbacks (rename `sum` to `acc`)
3. Remove unused imports across multiple files
4. Prefix unused parameters with underscore
5. Update `tsconfig.json` lib from ES2022 to ES2023
6. Move inline test helper functions to top-level scope in test files
7. Remove unused variables and dead code


#### clear all remaining lint warnings — 0 warnings, 0 errors ([`ccdd061`](https://github.com/waterworkshq/orcy/commit/ccdd061edb91c828c1a5cae5a954f5539a30b879))

1. Function scoping:
2. Extract 16 inner functions to module level (boardSummaryService, CommentSection,
3. MissionMetrics, MissionCommentSection, TeamsPage, PredictionSection, DashboardCharts,
4. CycleTimeChart, Skeleton.test, featureStatusDerivation.test, AgentsPage.test,
5. scheduler.test, plugins.test)

7. Event listeners:
8. Replace onmessage/onerror/onload with addEventListener in useSSE.ts, ImportHabitatDialog.tsx

10. Dead code removal:
11. Remove unused imports across ~80 files (drizzle-orm, react, lucide, types, services)
12. Remove unused variable declarations and dead calculations
13. Remove unused function declarations and dead code paths

15. 237 warnings → 0 warnings, 0 errors (was 567 warnings + 3 errors at start)



## 0.12.0 — 2026-05-25

### Features

#### Add v0.12 external integrations ([`0349187`](https://github.com/waterworkshq/orcy/commit/0349187228ef48e339aa8fae7bb474aaf95c37fb))

1. Add integration connection, sync run, and external issue tables
2. Implement GitHub OAuth device flow and webhook verification
3. Add sync service with per-issue import and adapter interface
4. Create integration settings tab and mission detail link badges
5. Document intake architecture and security threat model
6. Add external integrations architecture and GitHub sync



## 0.11.3 — 2026-05-21

### Bug Fixes

#### unique reviewer constraint, sprint overlap validation, human-readable email events, empty email null coercion ([`db1268e`](https://github.com/waterworkshq/orcy/commit/db1268e469962f48beb51012bb0be8ed3d105ab5))

1. P0-5: Add unique index on (task_id, reviewer_id) via migration 0012
2. P0-13: Add composite index (task_id, status) on task_reviewers
3. P2-13: Sprint date overlap validation via getOverlappingForHabitat
4. P3-11: EVENT_TYPE_LABELS mapping for human-readable watching emails
5. P3-13: updateUserEmail coerces empty string to null
