# Plugin Storage — Dedicated Enrollments, Runs, In-Memory Quarantine, Env Allowlist

Status: proposed · 2026-06-28

Depends on: ADR-0011 (Plugin Manifest V1), ADR-0012 (Plugin Capability Whitelist), ADR-0014 (Lifecycle Interceptor Contract — pre-veto / post-emit invokes plugin runs), ADR-0015 (Detector Execution — triggers `plugin_runs` rows)

## Context

Constraint #6 locks "per-habitat enable + global allowlist (`ORCY_DETECTOR_ALLOWLIST`)" for detectors. Constraint #8 locks "Audit Trail V2 + dedicated `plugin_runs` table." Grilling Q7 confirmed the storage shape — both where enrollment state lives and where per-invocation telemetry lives.

Two reference precedents in the codebase:
- v0.18.1 stored per-habitat automation settings as a `habitats.automation_settings` JSON column (per Memory). v0.21 followed the same pattern with `habitats.wiki_settings`. Both worked because the settings were single-blob habitat-level config.
- v0.18 introduced `automation_rule_runs` as a dedicated per-run telemetry table (status / fingerprint / started_at / finished_at / skip_reason / action_results). That table is the shape v0.22's `plugin_runs` needs.

The two questions: should plugin enrollment use the JSON-column pattern or a dedicated table, and should plugin activity telemetry reuse `automation_rule_runs` or get a dedicated table?

## Decision

**Three storage components, mutually inseparable:**

### A. `plugin_enrollments` — dedicated table (NOT a JSON column on `habitats`)

```sql
CREATE TABLE plugin_enrollments (
  id TEXT PRIMARY KEY,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  contribution_id TEXT NOT NULL,
  contribution_kind TEXT NOT NULL,    -- 'signalDetector' | 'lifecycleInterceptor'
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT,                        -- validated against manifest's contributionConfigSchema
  enrolled_by TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (habitat_id, plugin_id, contribution_id)
);

CREATE INDEX idx_plugin_enrollments_habitat ON plugin_enrollments(habitat_id, enabled);
CREATE INDEX idx_plugin_enrollments_plugin ON plugin_enrollments(plugin_id);
```

Per-contribution enrollment (not per-plugin): a Mixed Plugin's habitat-scoped contributions enroll independently of its system-scoped ones (consistent with ADR-0011's per-contribution `scope`). The `UNIQUE (habitat_id, plugin_id, contribution_id)` constraint is the deduplication guarantee — re-enroll upserts config + bumps `updated_at`; previous row is not deleted, history lives via the audit projection.

REST routes (habitat-scoped, admin-or-human-auth):
- `POST /api/habitats/:habitatId/plugins/enrollments` — body `{ pluginId, contributionId, config? }`; validates against the manifest's `contributionConfigSchema` (Zod); creates enrollment row at `enabled=0`; returns the enrollment row.
- `PATCH /api/habitats/:habitatId/plugins/enrollments/:enrollmentId` — body `{ enabled?, config? }`; toggles enabled OR updates config; bumps `updated_at`; sets `disabled_at` when transitioning to enabled=0. Audit event `plugin.enrollment_toggled` emitted.
- `GET /api/habitats/:habitatId/plugins/enrollments` — list enrollments for the habitat, joined to manifest data (plugin label, contribution label).
- `DELETE /api/habitats/:habitatId/plugins/enrollments/:enrollmentId` — admin-only; removes the enrollment row. Used for "un-enroll entirely" (vs disable which keeps the row for re-enable). Audit event `plugin.enrollment_removed`.

The loader consults `plugin_enrollments` at every trigger event via a cached query — for each enrolled-and-enabled contribution on the habitat, dispatch to the handler. Cache invalidates on `plugin.enrollment_toggled` and `plugin.quarantined` audit events (same SSE-channel pattern as v0.18 automation settings invalidation).

### B. `plugin_runs` — dedicated per-invocation telemetry table

```sql
CREATE TABLE plugin_runs (
  id TEXT PRIMARY KEY,                -- runId (uuid), stamped on detected-signal metadata.detectorRunId
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  contribution_id TEXT NOT NULL,
  contribution_kind TEXT NOT NULL,    -- 'signalDetector' | 'lifecycleInterceptor'
  trigger_event_id TEXT,              -- source event id (pulseId, taskId, etc.); null for pre-interceptors that fire before commit
  trigger_type TEXT NOT NULL,         -- "pulseCreated" / "taskSubmitted" / "taskClaimed:pre" / "taskApproved:post" etc.
  status TEXT NOT NULL,               -- "running" | "succeeded" | "failed" | "rate_limited" | "skipped" -- "skipped" for quarantine/disable short-circuit
  fingerprint TEXT NOT NULL,          -- habitatId:pluginId:contributionId:triggerType:triggerEventId — for future cooldown/dedup use (not enforced in v0.22)
  signals_emitted INTEGER,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_plugin_runs_habitat_plugin ON plugin_runs(habitat_id, plugin_id, started_at DESC);
CREATE INDEX idx_plugin_runs_habitat_status ON plugin_runs(habitat_id, status, started_at DESC);
```

Rows are inserted by the loader at handler invocation start (`status: "running"`) and updated at completion (`status: "succeeded"` + `signals_emitted`, OR `"failed"` + `error`, OR `"rate_limited"` with no handler invocation, OR `"skipped"` for quarantine / enrollment-disabled short-circuits with no handler work). The audit projection emits the matching `AuditEvent{ auditSource: "plugin", source: "plugin:<pluginId>", runId }` rows per ADR-0012 — the `plugin_runs` row carries the heavy telemetry (started_at, signals_emitted, finished_at, error) that audit-history consumers reference by `runId`.

Two tables, not one — because:
- Audit projection serves operator-facing audit queries (which plugin ran, when, source). Optimized for cross-source audit history navigation (webhook + integration + scheduler + plugin together). Reads via the existing audit endpoints.
- `plugin_runs` serves debug queries (which detectors fired for this habitat, what was emitted, what errored). Optimized for per-plugin per-habitat recent-activity slices. Reads via the new `GET /api/habitats/:habitatId/plugins/runs` REST route in v0.22.0 (list with filters: pluginId, status, since).

### C. Auto-quarantine state = in-memory only

No `plugin_quarantines` table in v0.22. Per-plugin error counter lives in `pluginManager` (in-memory `Map<pluginId, { errorCount, windowStartAt }>`). Threshold breach (default N=10 errors in M=5 minutes; configurable via `ORCY_PLUGIN_QUARANTINE_THRESHOLD` env) triggers:

1. The in-memory counter is reset.
2. `plugin.quarantined` audit event fired (audit projection handles visibility).
3. `pluginManager.setQuarantined(pluginId)` flips every loaded plugin with that id to `quarantined=true` — a transient load-time flag separate from `enabled` on enrollments. Quarantined plugins DO NOT receive trigger dispatches (loader short-circuits to `plugin_runs` row with `status: "skipped"`).
4. SSE `plugin.quarantined` event invalidates enrollment caches (all habitats because quarantine is server-wide).
5. Habitat admins can re-enable via `PATCH .../enrollments/:id` with `{ enabled: true }` — this resets the in-memory counter and clears the quarantine flag.

Persistence across restarts is lost (a quarantined plugin becomes active again on restart until it errs sufficiently to re-quarantine). v0.22.1+ deepening can add a `plugin_quarantines` table with `(autoReEnableAt)` field if operators need persistence during dev-side validation. v0.22.0 ships with in-memory-only; dev-side validation phase (Constraint #1) doesn't need cross-restart quarantine persistence.

### D. Global detector allowlist = `ORCY_DETECTOR_ALLOWLIST` env, filtered at LOADER time

Server-wide env list (comma-separated plugin ids). The loader refuses to enroll a detector plugin whose id is not in `ORCY_DETECTOR_ALLOWLIST`:
- `POST /api/habitats/:habitatId/plugins/enrollments` returns 403 with `{ error: "Plugin '<pluginId>' not allowed by ORCY_DETECTOR_ALLOWLIST" }` if the plugin id isn't on the env list OR the env var is unset (which defaults to "no detectors allowed anywhere" — fail-closed).
- Operators who want all detectors allowed set `ORCY_DETECTOR_ALLOWLIST=*`. This is the open-by-default mode.
- The env affects only detector-scoped contributions. Notification channel contributions (system-scoped) are unaffected — the existing `PLUGINS_ENABLED` env already gates them at boot.

Not a DB table — env is server-boot-config, not habitat-runtime state.

## Rationale

- **`plugin_enrollments` as a dedicated table (not JSON column) because per-contribution enrollment is the unit.** A JSON column on `habitats` would force an array of `{ pluginId, contributionId, enabled, config }` entries inside JSON; queries like "which habitats have detector X enrolled" require JSON extraction in-vendored-sqlite (slower than indexed SELECT). The v0.18.1 / v0.21 JSON-column pattern worked for single-blob habitat-level config; per-contribution enrollments are first-class queryable state, not blob settings.

- **`plugin_runs` separated from `audit_events` because query patterns differ.** Audit-history reads are cross-source ("what happened in this habitat recently" — webhook + integration + scheduler + plugin together). Plugin-run reads are per-plugin per-habitat ("which detectors fired today, what was emitted, what errored"). Query optimization differs; collapsing into one table loses both access patterns. The `runId` joins them.

- **Auto-quarantine in-memory only because v0.22 is dev-side-only (Constraint #1).** Restart clears quarantine; a re-quarantining plugin re-earns its disable. Operator re-enable via REST resets the counter, not "persists across restart until threshold-breach clears." Adding `plugin_quarantines` table with persistence adds a migration + a query path + a UI tab for no v0.22.0 operator demand. Deepening candidate.

- **Allowlist at loader time (fail-closed default) because the alternative is "any installed detector plugin can be enrolled."** That's the wrong default for a prerelease — a habitat admin shouldn't be able to enable a detector the server operator hasn't explicitly approved. `ORCY_DETECTOR_ALLOWLIST=*` opts into open-by-default; the hard default is "detectors not on the list cannot be enrolled."

- **Mixed Model (env + DB): allowlist (env) bounds boot-time; enrollments (DB) bound runtime.** Same separation v0.18.1 used — `automationSettings.executeActions` (DB habitat-level) on top of `ORCY_AUTOMATION_EXECUTE_ACTIONS` (env server-wide). The env is the outer gate; the per-habitat row is the inner gate.

## Alternatives considered

- **Enrollment as `habitats.plugin_settings` JSON column (reject).** Per-contribution enrollment+config is structured state, not habitat-level setting blob. Loses query patterns, lifecycle history, per-contribution toggling. Forces JSON extraction in SQLite, defeats indexes.

- **`plugin_runs` collapsed into `audit_events` (reject).** Cross-source audit projection is optimized for "navigate across all audit sources." Plugin-run telemetry is heavier (started_at, finished_at, signals_emitted) than most audit rows; collapsing makes audit rows fat and plugin-run queries slow. Two tables joined by `runId` is the proven pattern.

- **No `plugin_runs`, audit events only (reject).** Loses per-plugin per-habitat debug query (the "which detectors fired recently" panel). Audit projection query UX is built for cross-source navigation, not plugin activity debug. Constraint #8 explicitly asked for the dedicated table.

- **`plugin_quarantines` persistent table in v0.22 (reject).** Cross-restart quarantine persistence matters in production operator deployments, which Constraint #1 excludes from v0.22. Adds a migration + REST surface + UI tab for zero v0.22.0 users.

- **Allowlist as DB table populated by server operator (reject).** The env-var pattern is the precedent (`PLUGINS_ENABLED` gates system-scoped plugins; `ORCY_DETECTOR_ALLOWLIST` gates which detectors can be habitat-enrolled). A DB table adds operator-write surface and habitat-admin confusion ("why can't I enroll X?" — because the server operator hasn't allowedlist-toggled the row).

- **Allowlist empty-by-default vs `*`-by-default (chose empty; considered `*` default).** Empty is fail-closed — operators have to explicitly opt detectors in. `*` is open — operators have to explicitly deny detectors they don't want enrolled. Chose fail-closed for a prerelease phase: the cost of "operators enabling a malicious detector by accident" is higher than "operators having to add their reference detectors to env once."

## Consequences

- New migration `0038_plugin_enrollments.sql` — creates `plugin_enrollments` table + index (per the schema sketch above; concrete column types and final index list land in PRD).
- New migration `0039_plugin_runs.sql` — creates `plugin_runs` table + the two indexes + the `fingerprint` column (NOT NULL, no unique constraint in v0.22 — cooldown / dedup use deferred).
- `packages/api/src/db/schema/plugin.ts` (new) — drizzle schema definitions for both tables, exported alongside the existing schema modules.
- `packages/api/src/repositories/pluginEnrollment.ts` (new) — CRUD + `listEnabledByHabitat(habitatId)` for the loader cache + `listByPlugin(pluginId)` for the admin "where is this plugin enrolled?" query.
- `packages/api/src/repositories/pluginRun.ts` (new) — `startRun(...)`, `finishRun(id, status, signalsEmitted, error)`, `listByHabitat(habitatId, filter)`.
- `packages/api/src/services/pluginEnrollmentService.ts` (new) — REST-layer service; validates config against the manifest's `contributionConfigSchema`; emits audit events on enrollment toggle / removal; returns 403 if the plugin_id is not in `ORCY_DETECTOR_ALLOWLIST` (or the env var is unset) for detector-kind contributions.
- `packages/api/src/routes/plugins.ts` (new) — REST routes for enrollment CRUD + plugin-run listing. Sits alongside the existing `GET /plugins` route (which stays as-is — it lists loaded plugins; the new routes are habitat-scoped enrollments).
- `packages/api/src/plugins/pluginManager.ts` — builds the in-memory enrollment cache at boot (load all enabled rows) and refreshes on `plugin.enrollment_toggled` audit-event-emit. Holds the per-plugin in-memory error counter and the `quarantined` set. Holds the per-habitat per-detector concurrency caps and the deferred-trigger queues (per ADR-0015).
- `packages/api/src/plugins/context.ts` (new) — constructs the `PluginContext` per invocation, applies the capability whitelist per ADR-0012, passes `runId` (joined to `plugin_runs` row) into the capability surfaces for provenance injection.
- `packages/shared/src/types/plugin.ts` — already owns manifest types from ADR-0011; adds `PluginEnrollment`, `PluginRun`, `PluginRunStatus`. The shared types are the cross-package contract — `@orcy/mcp` and `@orcy/ui` import them via the built shared package.
- `packages/api/src/services/auditProjection.ts` — adds `auditSource: "plugin"` handling. Audit rows from plugin activity look like `"source: \"plugin:<pluginId>\"", runId` plus per-source-payload. Existing audit endpoints (`/api/audit/habitats/:id/events`, etc.) automatically include plugin rows in cross-source audit history. No new audit endpoint needed for v0.22.0; the per-plugin debug query is via `GET /api/habitats/:habitatId/plugins/runs`.
- New SSE events: `plugin.enrollment_toggled`, `plugin.enrollment_removed`, `plugin.quarantined`. UI handlers for each (UI is a Phase 9 deliverable per execution-loop, but the SSE event types land in `@orcy/shared/events.ts` in Phase 8 alongside the rest of the wiring).
- `ORCY_DETECTOR_ALLOWLIST`, `ORCY_PLUGIN_QUARANTINE_THRESHOLD`, `ORCY_DETECTOR_MAX_CONCURRENT`, `ORCY_DETECTOR_QUEUE_MAX` — new env vars. Documented in `docs/CONFIGURATION.md` per the v0.21.2 release-tooling precedent.
- Tests must cover: enrollment CRUD REST paths; config schema validation (Zod rejection path); allowlist gate (env unset → all detector enrollments return 403); auto-quarantine threshold breach → quarantine audit event + skipped plugin_runs; admin re-enable resets counter; loader cache invalidation on enrollment SSE events; plugin_runs lifecycle rows written for every invocation; audit event rows emitted alongside plugin_runs.

## Risk

- **`plugin_runs` table row growth.** A high-throughput detector in a busy habitat can write thousands of rows per day. Mitigation: an operator-configurable retention sweep (similar to `audit_events` retention in v0.18.1 — `plugin_runs.retention_days` setting; default deletes after 30 days). Not in v0.22.0 scope; documented in PRD as a day-1 operator knob via env.

- **Allowlist unset = ALL detectors blocked.** Operators upgrading from v0.21 to v0.22 with `PLUGINS_ENABLED` including detector plugins but no `ORCY_DETECTOR_ALLOWLIST` set will see "every detector enrollment returns 403." v0.22 release notes must call this out: "set `ORCY_DETECTOR_ALLOWLIST=*` to allow any loaded detector to be enrolled, or list specific plugin ids." Document explicitly in `docs/CONFIGURATION.md` and the v0.22 CHANGELOG entry.

- **In-memory quarantine lost on restart.** A plugin that was auto-quarantined becomes active again on restart until its error rate re-triggers quarantine. Acceptable for v0.22 dev-side phase (Constraint #1). Mitigation: explicit disable via REST persists (`plugin_enrollments.enabled = 0`) — operators can pre-emptively disable a problematic plugin via REST after restart, which the loader reads.

- **Loader cache stale window.** Between an enrollment patch and the cache refresh, a just-disabled detector might run one more trigger or a just-enabled detector might miss one trigger. Acceptable in dev-side phase; production deployments need tighter cache invalidation (e.g. synchronous cache update on the REST write). v0.22.0 ships with the SSE-event-driven refresh, same pattern as v0.18.1 automation settings; documented in PRD.

- **Two tables write path on every invocation.** Each detector run inserts one `plugin_runs` row + emits one `audit_events` row via the audit projection. Roughly 2 INSERTs per detector invocation. Compared to existing per-event insertion cost (each pulse already writes ~3 rows across pulse / habitat_skill_signals / audit), this is ~66% overhead per detection. Acceptable during dev-side validation; production-cost viability assessed at v0.22.1 deepening with the per-detector-run benchmark in `perfWorkflow.test.ts`.