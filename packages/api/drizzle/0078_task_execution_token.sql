-- Execution token (claim-epoch identity): one nullable token per Task claim
-- epoch, mirrored on the daemon session created in the same transaction.
-- NULL = pre-migration / released / terminal (legacy rows are deliberately
-- NOT backfilled — a status-only pair UPDATE is unsafe with multiple/old
-- active sessions; the 30-min stale sweep covers pre-migration claims).
ALTER TABLE `tasks` ADD COLUMN `execution_token` TEXT;--> statement-breakpoint
ALTER TABLE `daemon_sessions` ADD COLUMN `execution_token` TEXT;
