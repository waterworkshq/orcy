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

INSERT INTO finding_triage_evidence_0073 (
  finding_triage_id, pulse_id, habitat_id, role, admitted_by_triage_mission_id,
  admitted_by_investigation_task_id, admitted_at, created_at
)
SELECT
  e.finding_triage_id, e.pulse_id, ft.habitat_id, e.role, e.admitted_by_triage_mission_id,
  e.admitted_by_investigation_task_id, e.admitted_at, e.created_at
FROM finding_triage_evidence e
JOIN finding_triage ft ON ft.id = e.finding_triage_id;
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
