-- Foreign key on mission_dependencies.mission_id: the SOURCE side of a
-- dependency edge must reference an existing Mission. The destination side
-- (depends_on_id) already cascades; mission_id carried no FK, and mission
-- deletion neither blocked nor cleaned source-side edges — deleting a
-- Mission that owned dependencies left permanent dangling rows (reads skip
-- them, but the rows accumulate forever). This rebuild adds the symmetric
-- ON DELETE CASCADE: deleting a Mission removes the edges it owns, exactly
-- as deleting a depended-on Mission already removes the edges pointing at
-- it. Write paths are unchanged; this is schema-level defense in depth.

CREATE TABLE mission_dependencies_0086 (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  PRIMARY KEY(mission_id, depends_on_id)
);
--> statement-breakpoint

-- Preserve orphaned rows (either endpoint Mission missing — only possible
-- where foreign-key enforcement was off, or from the historical source-side
-- deletion gap this migration closes) instead of silently dropping them:
-- the join below filters them out before the DROP. Normally empty; anything
-- it captures needs explicit remediation.
CREATE TABLE IF NOT EXISTS mission_dependencies_orphans_0086 AS
SELECT d.*
FROM mission_dependencies d
-- Archive every row that cannot satisfy the REPLACEMENT foreign keys: a
-- missing source or destination Mission. The copy below excludes exactly
-- these rows.
WHERE NOT EXISTS (SELECT 1 FROM missions m WHERE m.id = d.mission_id)
   OR NOT EXISTS (SELECT 1 FROM missions m WHERE m.id = d.depends_on_id);
--> statement-breakpoint

INSERT INTO mission_dependencies_0086 (mission_id, depends_on_id)
SELECT d.mission_id, d.depends_on_id
FROM mission_dependencies d
-- Mirror the archive predicate: rows with a missing endpoint are archived
-- above and excluded here so no replacement foreign key can abort the
-- rebuild.
WHERE EXISTS (SELECT 1 FROM missions m WHERE m.id = d.mission_id)
  AND EXISTS (SELECT 1 FROM missions m WHERE m.id = d.depends_on_id);
--> statement-breakpoint

DROP TABLE mission_dependencies;
--> statement-breakpoint

ALTER TABLE mission_dependencies_0086
  RENAME TO mission_dependencies;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_mission_deps_depends_on
  ON mission_dependencies(depends_on_id);
