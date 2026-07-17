-- 0056: Event-delivery dedupe key on automation_rule_runs (T4C Phase 2).
--
-- Adds a DEDICATED nullable column `event_dedupe_key` that is populated ONLY
-- by event-delivery runs (the `task.created` automation path). A partial
-- unique index `(event_dedupe_key, rule_id) WHERE event_dedupe_key IS NOT NULL`
-- enforces "concurrent two-worker delivery of the same (eventId, ruleId)
-- creates exactly one Run reservation" — the DB-invariant the kernel requires.
--
-- WHY a new column instead of reusing `trigger_event_id`:
--   `trigger_event_id` is overloaded — real Lifecycle Event IDs (event
--   delivery) AND stable synthetic keys that scans reuse every period for
--   cooldown (`scan:…`, `orphan:…`, `cluster:…`). A unique index on
--   `trigger_event_id` would break periodic scans: the 2nd period's scan
--   reuses the same synthetic key → collision → `created:false` → scan never
--   re-runs. The reservation is scoped to EVENT DELIVERY ONLY via this
--   separate column; scans / manual / skip paths never populate it → column
--   stays NULL → partial index excludes them → zero behavior change.
--
-- Nullable with no default: callers that don't opt in (all existing callers)
-- leave it NULL → excluded from the partial unique index → always created.
ALTER TABLE automation_rule_runs ADD COLUMN event_dedupe_key TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_event_dedupe
  ON automation_rule_runs (event_dedupe_key, rule_id)
  WHERE event_dedupe_key IS NOT NULL;
