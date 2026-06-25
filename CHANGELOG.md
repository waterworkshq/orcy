# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.20.3 — 2026-06-25

### Chores

#### update package license and reorganize documentation ([`def6e4e`](https://github.com/waterworkshq/orcy/commit/def6e4e0f790240ba413d9f1fc43e2886ead5cc2))

1. Add MIT license field to package.json
2. Add "Agnostic by design" section and restructure external integrations into categorized sections in README
3. Add comprehensive comparison guide in docs/COMPARISON.md
4. Update architecture docs with corrected tool count and added blank lines around code blocks



### Performance

#### optimize test database initialization with snapshot caching ([`3e12d0f`](https://github.com/waterworkshq/orcy/commit/3e12d0f9da45f224741a138d82486d7e82c85723))

1. Refactor `initTestDb()` to cache sql.js WASM module, bcrypt admin hash, and a snapshot of the seeded database. Per-test calls now restore from the snapshot instead of running full migrations and seed operations, reducing the API test suite runtime from ~190s to ~12s.

3. Cache sql.js factory to avoid WASM recompilation per call
4. Cache bcrypt admin hash to avoid ~46ms bcrypt.hash overhead per call
5. Cache database snapshot bytes and restore via `new SQL.Database(bytes)` for cheap per-test isolation
6. Move `fileParallelism: false` from vitest.config.ts to the `test:perf` script so parallel test execution is preserved by default
7. Update test scripts to exclude perf benchmarks from the main `pnpm test` command
8. Document the snapshot model and `foreign_keys` pragma gotcha in TESTING.md



## 0.20.2 — 2026-06-24

### Refactors

#### inline watcher pass-throughs and remove dead task-movement code ([`db413de`](https://github.com/waterworkshq/orcy/commit/db413de4565d0d517648334a93e792897945425e))

1. Remove `task-movement.ts` which exported `moveTask` and `reorderTask`
2. with zero production callers — the reorder function was a no-op and
3. moveTask was superseded by the lifecycle service long ago. Delete
4. the accompanying test file.

6. Inline three watcherService forwarding functions (`unwatchTask`,
7. `isWatching`, `getWatchers`) into their sole callers in the
8. watcher route handler and `task-details.ts` via direct `watcherRepo`
9. imports, reducing the service surface to `watchTask` and
10. `notifyWatchers` only. Remove the unused re-export aliases
11. `assembleHabitatContext` and `assembleCrossHabitatDependencies` from
12. `task-details.ts` (zero import sites). Bump ROADMAP to v0.20.2.



## 0.20.1 — 2026-06-24

### Bug Fixes

#### activate rule execution across event ingestion and scheduled scans ([`81122c5`](https://github.com/waterworkshq/orcy/commit/81122c590616c298481e46ea7f1d2f927cc909ee))

1. Connect `executeAndRecordRuleRun` to `automationEventService.ingestEvent`
2. and the four `automationScanService` scan functions, closing a v0.18 defect where matched rules recorded "succeeded" runs without firing any configured actions. The new function encapsulates start→context→kill switch→execute→record→hook, giving both call sites a single async entry-point instead of the previous sync start→finish(succeeded) stub.

4. Adds a two-tier kill switch: per-habitat `automation_settings.executeActions`
5. (new JSON column via drizzle migration 0034) and the
6. `ORCY_AUTOMATION_EXECUTE_ACTIONS` env-var override, both defaulting to enabled so existing consumers see no regression when the toggle is absent.

8. Subscribes `workflowService` to `onAutomationRunCompleted` and
9. implements `handleAutomationRunCompleted` to satisfy unsatisfied `on_automation` gates when matching rule runs complete, completing the originally-planned six-type gate set.

11. Moves `SkillCategory` and the `SKILL_CATEGORIES` array to
12. `@orcy/shared` (packages/api, cli, and mcp now import from the single source), adds the `anti_patterns` value for `sidetracked` experience signals, and enables the `on_automation` gate type in the workflow
13. editor with its `AutomationMatch` form fields (rule ID, outcome, target type/scope).


#### expose per-habitat automation execution toggle and enable on_automation workflow gate ([`6166404`](https://github.com/waterworkshq/orcy/commit/616640426e53ebd864c1ef5277b81df37f67d298))

1. Complete the deferred on_automation gate that was held back in v0.20 due to the executor wiring gap.
2. The executor now subscribes to rule-run completions, satisfies downstream gates whose match config references the completed rule (including outcome filtering), and records run history for auditability.

4. Introduce an `automationSettings.executeActions` flag persisted on the habitat model.
5. When the flag is off the executor still matches rules and records runs but suppresses all side effects; the UI surfaces a toggle with a warning banner in the settings dialog, the CLI exposes it under `habitat update-settings --automation-execution`, and the
6. REST PATCH endpoint accepts the new field. A global override via
7. `ORCY_AUTOMATION_EXECUTE_ACTIONS=false` env var is also supported.

9. Update CAPABILITIES.md to list six active gate types, revise
10. ARCHITECTURE.md decision notes to reflect that the gate ships in v0.20, and remove the v0.20.1 roadmap row from README.md.
