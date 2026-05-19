# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.10.0 — 2026-05-19

### Bug Fixes

#### update audit export schedule tests with destination_config column ([`b47c10d`](https://github.com/waterworkshq/orcy/commit/b47c10dd7c702e37dde5985a06e13319284847c1))

1. Add destination_config column to audit_export_schedules INSERT statements in
2. scheduledTaskService tests to match schema changes. Update uiSlice test type
3. annotations for better TypeScript compatibility with Mock types.


#### update test assertions and mocks for habitat terminology ([`f1fb2d4`](https://github.com/waterworkshq/orcy/commit/f1fb2d414af3523cefd8b57c18a1a5b04c22d02a))

1. Update test files and type definitions to use consistent habitat terminology
2. across the UI package. This includes renaming test IDs, mock functions, and
3. API method references from board/feature to habitat/mission terminology.



### Chores

#### update docs, seed script, and plugin for v0.10.0 naming unification ([`6808427`](https://github.com/waterworkshq/orcy/commit/6808427a0a1de5af93720f5c747668e114816682))

1. docs/ARCHITECTURE.md: update ~50 references from board/feature to habitat/mission
2. scripts/seed.ts: rewrite to use createHabitat + createMission + missionId
3. plugins/auto-label/index.ts: fix type error (labels not on UpdateTaskInput)
4. README.md: add orcy.dev link



### Documentation

#### update roadmap with v0.9.4 patch fixes and v0.11 features ([`88b526e`](https://github.com/waterworkshq/orcy/commit/88b526e0c9b3185ff7b17647ec662b613ffd3113))

1. Update README.md and docs/ROADMAP.md to reflect v0.9.4 release and
2. enhance v0.11 feature list with visual rule builder and mobile table view.
3. Add patch fixes summary for v0.9.1–v0.9.4 releases.



### Features

#### rename board routes to habitat routes and update API endpoints ([`e74a205`](https://github.com/waterworkshq/orcy/commit/e74a205e470616ade2fc86feef525e57537662e1))

1. This commit completes the renaming of board-related routes to habitat routes throughout the API layer, following the database schema changes. The changes include:

3. Renaming route files: `boards.ts` → `habitats.ts`, `features.ts` → `missions.ts`, `featureComments.ts` → `missionComments.ts`
4. Updating all route path parameters from `:id` to `:habitatId` and `:missionId`
5. Modifying route registration in `index.ts` to use the new route modules
6. Updating all repository and service imports to reflect the new naming convention
7. Adjusting test files to use the new route names and parameter schemas

9. This is a breaking change that affects all API endpoints that previously used `/boards/*` and `/features/*` paths.


#### update mission decomposition API to return proposals structure ([`f0c45d6`](https://github.com/waterworkshq/orcy/commit/f0c45d62ea933a4a0d7ed1cc03ed574f47ba73da))

1. This commit updates the mission decomposition functionality to return a consistent
2. response structure across both MCP and UI packages. The decomposition result now
3. includes a `proposals` array and `parentMission` object instead of the previous
4. `tasks` and `mission` structure.

6. Changes include:
7. Updated `MissionDecompositionResult` type to use `proposals` and `parentMission`
8. Modified `MissionDetailPanel` to handle new response structure
9. Updated API response handling in MCP tools and UI components
10. Ensured consistent naming across all decomposition-related code

12. This is a non-breaking change that improves API consistency and clarity.



### Refactors

#### rename boards/missions to habitats/missions across schema and types ([`1eb51b6`](https://github.com/waterworkshq/orcy/commit/1eb51b6ae484407a767d33eefc0a76dddd8d3bd5))

1. This commit implements a comprehensive renaming of database tables and columns from "board/feature" terminology to "habitat/mission" terminology. The changes include:

3. Renaming the `boards` table to `habitats` and `features` table to `missions`
4. Updating all foreign key references and column names throughout the schema
5. Renaming related tables: `feature_dependencies` → `mission_dependencies`, `feature_events` → `mission_events`, etc.
6. Updating TypeScript types in the shared package to reflect the new naming
7. Modifying repository and service code to use the new terminology
8. Adding the migration file `0007_column_renames.sql` to apply these changes to the database

10. This is a breaking change that affects the database schema and all code that references these tables and types.


#### rename board-related variables to habitat in API and MCP packages ([`d1325dc`](https://github.com/waterworkshq/orcy/commit/d1325dc0d876a31bab5a3ff8b316529670cc408c))

1. This commit continues the renaming of board-related terminology to habitat throughout the API and MCP packages, focusing on variable names, function parameters, and internal identifiers rather than route paths.

3. Changes include:
4. Renaming `boardId` parameters to `habitatId` in repositories, services, and MCP tools
5. Updating function names like `getBoardById` to `getHabitatById`
6. Renaming `feature` references to `mission` in task and mission-related services
7. Updating MCP tool names from `orcy_habitat_*` to `orcy_*` for cleaner naming
8. Adjusting test files to use new variable names and function signatures

10. This is a non-breaking internal refactoring that maintains API compatibility while improving code consistency.


#### rename board-related components and hooks to habitat terminology ([`62a0847`](https://github.com/waterworkshq/orcy/commit/62a0847e5dcd6fa1286440d5fdc30fd70389ed39))

1. This commit continues the renaming of board-related terminology to habitat throughout the UI package, focusing on component names, hook parameters, and internal state management.

3. Changes include:
4. Renaming `Board` component to `Habitat` and updating all references
5. Updating hook parameters from `boardId` to `habitatId` across components
6. Renaming `useBoardStore` to `useHabitatStore` and related state selectors
7. Updating route parameters from `boardId` to `habitatId` in App.tsx and tests
8. Renaming `FeatureCommentSection` to `MissionCommentSection` and deleting old file
9. Adding new `habitatSlice.ts` and `missionSlice.ts` store slices
10. Deleting deprecated `boardSlice.ts` and `featureSlice.ts` files
11. Updating all component prop interfaces and test mocks accordingly

13. This is a non-breaking internal refactoring that maintains UI compatibility while improving code consistency.



### Tests

#### ensure user existence and improve error handling in tests ([`fe8b0dd`](https://github.com/waterworkshq/orcy/commit/fe8b0dd519e762fe449bfb98496be84ab8011c5b))

1. Update API tests to verify user existence before operations and handle
2. errors consistently. Add error handler to auth-validation tests and
3. ensure user existence in boardAccess, multiTenant, and realtimeAuth tests.
4. Refactor UI tests to mock additional components and icons for better
5. isolation and coverage.

7. Remove unnecessary ROLLBACK in auth setup route
8. Add error handler to auth-validation tests
9. Ensure user existence in boardAccess, multiTenant, and realtimeAuth tests
10. Mock HealthScoreWidget, FilterBar, and other components in UI tests
11. Add icon mocks to MissionDetailPage tests
12. Update HabitatSettingsDialog tests with QueryClient provider



## 0.9.4 — 2026-05-15

### Bug Fixes

#### generate single-version release notes for GitHub releases ([`98e2863`](https://github.com/waterworkshq/orcy/commit/98e28634d517c2c5acecff8f4b4339efb087b33b))

1. Use git-cliff --current -o - instead of -o /dev/null so release-it
2. captures the current version's notes only for the GitHub release body.


#### add token hints to scheduled task form ([`a1aad58`](https://github.com/waterworkshq/orcy/commit/a1aad58d38ebf03943fd8d1f553190a7537d2ffc))

1. Add TokenHints component to display available tokens ({{date}}, {{counter}}) with examples below Feature Title and Description inputs. Include test IDs for verification and ensure form submission works correctly with token syntax.

3. Include unit tests for token hint rendering and form submission behavior.



## 0.9.3 — 2026-05-15

### Bug Fixes

#### complete R16 React Query unification with review fixes ([`5d5b369`](https://github.com/waterworkshq/orcy/commit/5d5b3695a94211e58a064ada2c8d82230aee88cd))

1. Migrate all 17 UI components from useEffect+api/Zustand patterns to
2. React Query. Includes review round 1 fixes: mutation hooks for
3. CreateMissionForm/CreateTaskForm, cache invalidation in
4. FeatureCommentSection, standardized query keys, expanded test coverage,
5. and ConfirmDialog migration.
