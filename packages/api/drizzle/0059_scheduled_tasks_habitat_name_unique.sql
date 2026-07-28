-- IMP-3: Wiki scheduler name-based dedupe race window.
-- Two concurrent spawnAuthoringTask calls for the same (habitatId, name) can
-- both miss the pre-insert lookup and both insert. Add a UNIQUE partial index
-- to enforce dedup at the DB level. The application code catches the
-- UNIQUE-collision and re-reads the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_tasks_habitat_name
  ON `scheduled_tasks` (`habitat_id`, `name`);
