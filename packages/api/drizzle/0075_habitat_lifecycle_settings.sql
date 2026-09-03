-- v0.42.0 "Task transition budget": per-habitat lifecycle settings blob.
-- Stores a LifecycleSettings JSON blob (taskTransitionCeiling). NULL = default ceiling.
ALTER TABLE habitats ADD COLUMN lifecycle_settings TEXT;
