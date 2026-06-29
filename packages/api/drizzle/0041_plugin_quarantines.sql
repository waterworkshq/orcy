-- v0.22.3: Persistent plugin quarantine state (ADR-0016).
-- Survives API restart so quarantined plugins don't re-offend on next boot.
-- plugin_key is the `${pluginId}:${contributionId}` composite key used by quarantineSet.
CREATE TABLE IF NOT EXISTS plugin_quarantines (
  `plugin_key` text PRIMARY KEY NOT NULL,
  `plugin_id` text NOT NULL,
  `quarantined_at` text NOT NULL,
  `reason` text
);
