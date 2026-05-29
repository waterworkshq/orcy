-- S3: Add CHECK constraints on strength ranges
ALTER TABLE habitat_skill_signals ADD CHECK (strength >= 0 AND strength <= 1);
ALTER TABLE habitat_skills ADD CHECK (avg_strength >= 0 AND avg_strength <= 1);
