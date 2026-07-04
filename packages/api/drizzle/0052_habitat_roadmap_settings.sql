-- v0.25.4 "Scoring Strategy": per-habitat roadmap scoring algorithm selection.
-- Stores a RoadmapSettings JSON blob (scoringAlgorithm). NULL = default (fanout).
ALTER TABLE habitats ADD COLUMN roadmap_settings TEXT;
