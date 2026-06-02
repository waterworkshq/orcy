ALTER TABLE code_evidence_completeness ADD COLUMN created_at text NOT NULL DEFAULT (datetime('now'));
