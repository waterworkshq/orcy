# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.13.1 — 2026-05-28

### Tests

#### add unit tests for services, webhooks, repositories, and event modules ([`3286176`](https://github.com/waterworkshq/orcy/commit/3286176cfe2b7264c1e05cc62daeba688bb0b05b))



## 0.13.0 — 2026-05-26

### Features

#### add Jira & Linear adapters, OAuth, and intake review UI ([`a1fe61f`](https://github.com/waterworkshq/orcy/commit/a1fe61f81259b604c614962aab9452a78dce04ba))

1. Adds Jira Cloud and Linear issue adapters, extending the external intake
2. system from v0.12 with full provider-specific implementations:

4. Jira Cloud adapter: JQL search, ADF text extraction, API token/basic auth
5. and OAuth 3LO flows with environment-level client secret configuration
6. Linear adapter: GraphQL queries, cursor pagination, OAuth PKCE public-client
7. flow (no client secret required)
8. Shared OAuth infrastructure: callback server (port 17530), PKCE state store,
9. code verifier management
10. Intake candidate review UI: promote/ignore/clarify actions with dedicated
11. habitat filter view
12. CLI `orcy integrations connect` and `orcy integrations guide` subcommands
13. Provider connection panels for Jira and Linear in Habitat Settings UI
14. New API routes and repositories for intake candidates and OAuth orchestration
15. Updated documentation (README, CONFIGURATION, SECURITY, ROADMAP to v0.13)
16. Test coverage for all new modules and route handlers



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
