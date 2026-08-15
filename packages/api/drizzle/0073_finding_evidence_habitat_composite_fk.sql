-- Composite foreign key on finding_triage_evidence: the evidence row's
-- habitat must BE the referenced finding's habitat. The three FKs were
-- independent, so a row pairing a finding from habitat A with habitat B's id
-- passed every constraint while deleting B cascaded away A's authoritative
-- evidence. Write paths already derive the habitat from the finding; this is
-- schema-level defense in depth. The copy re-derives habitat_id from the
-- finding (the same coercion 0068 used), so any dirty pair is repaired
-- instead of aborting the rebuild.
--
-- Do not edit 0068; this is its additive successor.

-- Parent side: UNIQUE (id, habitat_id) so the composite FK can reference it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_triage_id_habitat
  ON finding_triage(id, habitat_id);
--> statement-breakpoint

CREATE TABLE finding_triage_evidence_0073 (
  finding_triage_id TEXT NOT NULL,
  pulse_id TEXT NOT NULL REFERENCES pulses(id) ON DELETE RESTRICT,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('source', 'corroborating', 'legacy_observed')),
  admitted_by_triage_mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  admitted_by_investigation_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  admitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (finding_triage_id, pulse_id),
  FOREIGN KEY (finding_triage_id, habitat_id)
    REFERENCES finding_triage(id, habitat_id) ON DELETE RESTRICT
);
--> statement-breakpoint

-- Preserve orphaned evidence rows (referenced finding missing — only
-- possible if foreign-key enforcement was off historically) instead of
-- silently dropping them: the join below filters them out before the DROP.
-- Normally empty; anything it captures needs explicit remediation.
CREATE TABLE IF NOT EXISTS finding_triage_evidence_orphans_0073 AS
SELECT e.*
FROM finding_triage_evidence e
-- Archive every row that cannot satisfy the REPLACEMENT foreign keys: a
-- missing finding, a missing pulse, or a non-null dangling admitted_by
-- reference (each only possible where foreign-key enforcement was off
-- historically). The copy below excludes exactly these rows.
WHERE NOT EXISTS (SELECT 1 FROM finding_triage ft WHERE ft.id = e.finding_triage_id)
   OR NOT EXISTS (SELECT 1 FROM pulses p WHERE p.id = e.pulse_id)
   OR (e.admitted_by_triage_mission_id IS NOT NULL AND
       NOT EXISTS (SELECT 1 FROM missions m WHERE m.id = e.admitted_by_triage_mission_id))
   OR (e.admitted_by_investigation_task_id IS NOT NULL AND
       NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = e.admitted_by_investigation_task_id));
--> statement-breakpoint

INSERT INTO finding_triage_evidence_0073 (
  finding_triage_id, pulse_id, habitat_id, role, admitted_by_triage_mission_id,
  admitted_by_investigation_task_id, admitted_at, created_at
)
SELECT
  e.finding_triage_id, e.pulse_id, ft.habitat_id, e.role, e.admitted_by_triage_mission_id,
  e.admitted_by_investigation_task_id, e.admitted_at, e.created_at
FROM finding_triage_evidence e
JOIN finding_triage ft ON ft.id = e.finding_triage_id
JOIN pulses p ON p.id = e.pulse_id
-- Mirror the archive predicate: rows with missing parents are archived
-- above and excluded here so no replacement foreign key can abort the
-- rebuild.
WHERE (e.admitted_by_triage_mission_id IS NULL OR
       EXISTS (SELECT 1 FROM missions m WHERE m.id = e.admitted_by_triage_mission_id))
  AND (e.admitted_by_investigation_task_id IS NULL OR
       EXISTS (SELECT 1 FROM tasks t WHERE t.id = e.admitted_by_investigation_task_id));
--> statement-breakpoint

DROP TABLE finding_triage_evidence;
--> statement-breakpoint

ALTER TABLE finding_triage_evidence_0073
  RENAME TO finding_triage_evidence;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_finding
  ON finding_triage_evidence(finding_triage_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_pulse
  ON finding_triage_evidence(pulse_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_role
  ON finding_triage_evidence(role);
