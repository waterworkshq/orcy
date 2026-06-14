-- v0.19 Phase D: Add remoteAssignedParticipantId column to tasks for
-- per-remote-participant claim tracking. The existing assignedAgentId has a
-- foreign key to agents(id) which only knows about local agents; remote
-- participants are NOT stored in the agents table by design (see techspec
-- §2.2). This column lets task state track remote claimers without
-- violating that boundary.
--
-- The column is intentionally NOT a foreign key — remote_participants is a
-- separate principal model and adding a FK here would create a cross-table
-- link that misrepresents the data model.

ALTER TABLE `tasks` ADD COLUMN `remote_assigned_participant_id` text;
--> statement-breakpoint

-- Backfill any existing rows that already used the participant id pattern
-- in assignedAgentId. In practice this is unlikely since the FK would have
-- blocked it, but this keeps the migration idempotent and safe.
UPDATE `tasks`
SET `remote_assigned_participant_id` = `assigned_agent_id`
WHERE `assigned_agent_id` IS NOT NULL
  AND `assigned_agent_id` NOT IN (SELECT `id` FROM `agents`);
--> statement-breakpoint

CREATE INDEX `idx_tasks_remote_assigned_participant` ON `tasks` (`remote_assigned_participant_id`);
