/*
    Daemon worker contract (REC-05) — release-provenance pointer.

    Additive only: one nullable column on `tasks`, symmetric with the T2
    failure pointer (0079) but an INDEPENDENT provenance stream — a release
    and a failure are never conflated on one pointer.

      - tasks.last_release_event_id: written by releaseTaskWithEffects' act-tx
        (the `released` event row id). The receipt-path workflow_gates
        consumer fences the release's spawn/gate mutation on
        `status='pending' AND execution_token IS NULL AND
        last_release_event_id = :eventId`; every writer that moves the task
        back to that unclaimed shape (repo releaseTask convergence incl.
        deleteAgent/stale/automation callers, releaseTaskForRemote's inline
        tx, executeRetry, escalateToHuman, claim mint, import reset) clears
        it. Never inferred, never set through any wire input.
*/
ALTER TABLE `tasks` ADD `last_release_event_id` text;
--> statement-breakpoint
CREATE INDEX `idx_tasks_last_release_event` ON `tasks` (`last_release_event_id`);
