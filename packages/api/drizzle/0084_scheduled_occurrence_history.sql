-- Whole-history entitlement evidence. No FK: occurrence audit history survives
-- schedule/habitat deletion. Ordinals remain nonunique for legacy histories.
CREATE TABLE scheduled_occurrence_history (
  scheduled_task_id TEXT PRIMARY KEY NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  duplicate_ordinal_rows INTEGER NOT NULL DEFAULT 0,
  once_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT scheduled_occurrence_history_counts_nonnegative CHECK (
    total_count >= 0 AND duplicate_ordinal_rows >= 0 AND once_count >= 0 AND unknown_count >= 0
  ),
  CONSTRAINT scheduled_occurrence_history_trusted_boolean CHECK (trusted IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX idx_scheduled_occurrences_schedule_ordinal
  ON scheduled_occurrences (scheduled_task_id, ordinal);
--> statement-breakpoint
-- Exact original classification, including malformed snapshots and orphan IDs.
-- The production migration runner owns BEGIN IMMEDIATE across the backfill.
INSERT INTO scheduled_occurrence_history (
  scheduled_task_id, total_count, duplicate_ordinal_rows, once_count, unknown_count, trusted
)
SELECT scheduled_task_id, count(*), count(*) - count(DISTINCT ordinal),
  coalesce(sum(CASE WHEN json_valid(schedule_revision)
    THEN CASE WHEN json_extract(schedule_revision, '$.scheduleType') = 'once' THEN 1 ELSE 0 END
    ELSE 0 END), 0),
  coalesce(sum(CASE WHEN json_valid(schedule_revision)
    THEN CASE WHEN json_extract(schedule_revision, '$.scheduleType') IN ('once', 'interval', 'cron') THEN 0 ELSE 1 END
    ELSE 1 END), 0),
  1
FROM scheduled_occurrences
GROUP BY scheduled_task_id;
--> statement-breakpoint
-- REPLACE can suppress DELETE triggers. Poison every affected schedule before
-- the replacement, including absent summaries. ABORT rolls this work back;
-- unsupported IGNORE/UPSERT modes may conservatively retain untrusted evidence.
-- Explicit existence predicates avoid outer conflict-policy overrides of IGNORE.
CREATE TRIGGER scheduled_occurrence_history_conflict_insert
BEFORE INSERT ON scheduled_occurrences
WHEN EXISTS (SELECT 1 FROM scheduled_occurrences WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM scheduled_occurrences
    WHERE scheduled_task_id = NEW.scheduled_task_id AND scheduled_for = NEW.scheduled_for)
BEGIN
  INSERT INTO scheduled_occurrence_history (
    scheduled_task_id, total_count, duplicate_ordinal_rows, once_count, unknown_count, trusted
  )
  SELECT affected.scheduled_task_id, 0, 0, 0, 0, 0 FROM (
    SELECT NEW.scheduled_task_id AS scheduled_task_id
    UNION SELECT scheduled_task_id FROM scheduled_occurrences WHERE id = NEW.id
    UNION SELECT scheduled_task_id FROM scheduled_occurrences
      WHERE scheduled_task_id = NEW.scheduled_task_id AND scheduled_for = NEW.scheduled_for
  ) AS affected
  WHERE NOT EXISTS (SELECT 1 FROM scheduled_occurrence_history AS history
    WHERE history.scheduled_task_id = affected.scheduled_task_id);

  UPDATE scheduled_occurrence_history SET trusted = 0
  WHERE scheduled_task_id IN (
    SELECT NEW.scheduled_task_id
    UNION SELECT scheduled_task_id FROM scheduled_occurrences WHERE id = NEW.id
    UNION SELECT scheduled_task_id FROM scheduled_occurrences
      WHERE scheduled_task_id = NEW.scheduled_task_id AND scheduled_for = NEW.scheduled_for
  );
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_occurrence_history_conflict_update
BEFORE UPDATE OF id, scheduled_task_id, scheduled_for ON scheduled_occurrences
WHEN EXISTS (SELECT 1 FROM scheduled_occurrences WHERE id = NEW.id AND id <> OLD.id)
  OR EXISTS (SELECT 1 FROM scheduled_occurrences
    WHERE scheduled_task_id = NEW.scheduled_task_id AND scheduled_for = NEW.scheduled_for AND id <> OLD.id)
BEGIN
  INSERT INTO scheduled_occurrence_history (
    scheduled_task_id, total_count, duplicate_ordinal_rows, once_count, unknown_count, trusted
  )
  SELECT affected.scheduled_task_id, 0, 0, 0, 0, 0 FROM (
    SELECT OLD.scheduled_task_id AS scheduled_task_id
    UNION SELECT NEW.scheduled_task_id
    UNION SELECT scheduled_task_id FROM scheduled_occurrences WHERE id = NEW.id AND id <> OLD.id
    UNION SELECT scheduled_task_id FROM scheduled_occurrences
      WHERE scheduled_task_id = NEW.scheduled_task_id AND scheduled_for = NEW.scheduled_for AND id <> OLD.id
  ) AS affected
  WHERE NOT EXISTS (SELECT 1 FROM scheduled_occurrence_history AS history
    WHERE history.scheduled_task_id = affected.scheduled_task_id);

  UPDATE scheduled_occurrence_history SET trusted = 0
  WHERE scheduled_task_id IN (
    SELECT OLD.scheduled_task_id
    UNION SELECT NEW.scheduled_task_id
    UNION SELECT scheduled_task_id FROM scheduled_occurrences WHERE id = NEW.id AND id <> OLD.id
    UNION SELECT scheduled_task_id FROM scheduled_occurrences
      WHERE scheduled_task_id = NEW.scheduled_task_id AND scheduled_for = NEW.scheduled_for AND id <> OLD.id
  );
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_occurrence_history_insert
AFTER INSERT ON scheduled_occurrences
BEGIN
  -- Reconstruct from zero only when NEW is the schedule's sole history row.
  -- Missing evidence with other surviving rows stays missing/unknown.
  INSERT INTO scheduled_occurrence_history (
    scheduled_task_id, total_count, duplicate_ordinal_rows, once_count, unknown_count, trusted
  )
  SELECT NEW.scheduled_task_id, 0, 0, 0, 0, 1
  WHERE NOT EXISTS (SELECT 1 FROM scheduled_occurrence_history WHERE scheduled_task_id = NEW.scheduled_task_id)
    AND NOT EXISTS (SELECT 1 FROM scheduled_occurrences
      WHERE scheduled_task_id = NEW.scheduled_task_id AND id <> NEW.id);

  UPDATE scheduled_occurrence_history SET
    total_count = total_count + 1,
    duplicate_ordinal_rows = duplicate_ordinal_rows + EXISTS (
      SELECT 1 FROM scheduled_occurrences
      WHERE scheduled_task_id = NEW.scheduled_task_id AND ordinal = NEW.ordinal AND id <> NEW.id
    ),
    once_count = once_count + CASE WHEN json_valid(NEW.schedule_revision)
      THEN CASE WHEN json_extract(NEW.schedule_revision, '$.scheduleType') = 'once' THEN 1 ELSE 0 END
      ELSE 0 END,
    unknown_count = unknown_count + CASE WHEN json_valid(NEW.schedule_revision)
      THEN CASE WHEN json_extract(NEW.schedule_revision, '$.scheduleType') IN ('once', 'interval', 'cron') THEN 0 ELSE 1 END
      ELSE 1 END
  WHERE scheduled_task_id = NEW.scheduled_task_id AND trusted = 1;
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_occurrence_history_delete
AFTER DELETE ON scheduled_occurrences
BEGIN
  UPDATE scheduled_occurrence_history SET
    total_count = total_count - 1,
    duplicate_ordinal_rows = duplicate_ordinal_rows - EXISTS (
      SELECT 1 FROM scheduled_occurrences
      WHERE scheduled_task_id = OLD.scheduled_task_id AND ordinal = OLD.ordinal
    ),
    once_count = once_count - CASE WHEN json_valid(OLD.schedule_revision)
      THEN CASE WHEN json_extract(OLD.schedule_revision, '$.scheduleType') = 'once' THEN 1 ELSE 0 END
      ELSE 0 END,
    unknown_count = unknown_count - CASE WHEN json_valid(OLD.schedule_revision)
      THEN CASE WHEN json_extract(OLD.schedule_revision, '$.scheduleType') IN ('once', 'interval', 'cron') THEN 0 ELSE 1 END
      ELSE 1 END
  WHERE scheduled_task_id = OLD.scheduled_task_id AND trusted = 1;
END;
--> statement-breakpoint
CREATE TRIGGER scheduled_occurrence_history_update
AFTER UPDATE OF scheduled_task_id, ordinal, schedule_revision ON scheduled_occurrences
WHEN OLD.scheduled_task_id IS NOT NEW.scheduled_task_id OR OLD.ordinal IS NOT NEW.ordinal
  OR OLD.schedule_revision IS NOT NEW.schedule_revision
BEGIN
  -- The base row already has NEW's identity: exclude NEW.id for both groups.
  UPDATE scheduled_occurrence_history SET
    total_count = total_count - 1,
    duplicate_ordinal_rows = duplicate_ordinal_rows - EXISTS (
      SELECT 1 FROM scheduled_occurrences
      WHERE scheduled_task_id = OLD.scheduled_task_id AND ordinal = OLD.ordinal AND id <> NEW.id
    ),
    once_count = once_count - CASE WHEN json_valid(OLD.schedule_revision)
      THEN CASE WHEN json_extract(OLD.schedule_revision, '$.scheduleType') = 'once' THEN 1 ELSE 0 END
      ELSE 0 END,
    unknown_count = unknown_count - CASE WHEN json_valid(OLD.schedule_revision)
      THEN CASE WHEN json_extract(OLD.schedule_revision, '$.scheduleType') IN ('once', 'interval', 'cron') THEN 0 ELSE 1 END
      ELSE 1 END
  WHERE scheduled_task_id = OLD.scheduled_task_id AND trusted = 1;

  INSERT INTO scheduled_occurrence_history (
    scheduled_task_id, total_count, duplicate_ordinal_rows, once_count, unknown_count, trusted
  )
  SELECT NEW.scheduled_task_id, 0, 0, 0, 0, 1
  WHERE NOT EXISTS (SELECT 1 FROM scheduled_occurrence_history WHERE scheduled_task_id = NEW.scheduled_task_id)
    AND NOT EXISTS (SELECT 1 FROM scheduled_occurrences
      WHERE scheduled_task_id = NEW.scheduled_task_id AND id <> NEW.id);

  UPDATE scheduled_occurrence_history SET
    total_count = total_count + 1,
    duplicate_ordinal_rows = duplicate_ordinal_rows + EXISTS (
      SELECT 1 FROM scheduled_occurrences
      WHERE scheduled_task_id = NEW.scheduled_task_id AND ordinal = NEW.ordinal AND id <> NEW.id
    ),
    once_count = once_count + CASE WHEN json_valid(NEW.schedule_revision)
      THEN CASE WHEN json_extract(NEW.schedule_revision, '$.scheduleType') = 'once' THEN 1 ELSE 0 END
      ELSE 0 END,
    unknown_count = unknown_count + CASE WHEN json_valid(NEW.schedule_revision)
      THEN CASE WHEN json_extract(NEW.schedule_revision, '$.scheduleType') IN ('once', 'interval', 'cron') THEN 0 ELSE 1 END
      ELSE 1 END
  WHERE scheduled_task_id = NEW.scheduled_task_id AND trusted = 1;
END;
