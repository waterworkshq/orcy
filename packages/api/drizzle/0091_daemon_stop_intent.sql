-- Durable intent is distinct from a completed stop. A later heartbeat clears it.
ALTER TABLE daemon_instances ADD COLUMN stop_intent text;
