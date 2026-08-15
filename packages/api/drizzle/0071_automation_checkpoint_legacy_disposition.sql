-- Reclassify checkpoints coerced by 0070. 0070 collapsed historically
-- `proved` rows (the action DID execute) that lacked the durable receipt the
-- new CHECK requires onto `failed:missing_receipt`, making them
-- indistinguishable from genuinely-failed actions: successor generations
-- carry forward only `proved` checkpoints, so an action that already fired
-- became silently re-runnable under a generic duplicate-risk ack. The
-- distinct label lets the successor path demand explicit acknowledgement
-- before re-running a known-fired action.
--
-- Do not edit 0070; this is its additive successor.

UPDATE automation_delivery_action_checkpoints
SET terminal_disposition = 'failed:legacy_proved_no_receipt'
WHERE state = 'failed' AND terminal_disposition = 'failed:missing_receipt';
--> statement-breakpoint

-- 0070's COALESCE only filled NULL dispositions: a coerced row that already
-- carried a non-failed disposition (e.g. 'succeeded' from the legacy proved
-- write path) kept it and escaped the relabel above, staying silently
-- re-runnable on a successor. Widen the predicate: any failed row with
-- neither receipt nor proved_at that does not declare a failed:* disposition
-- is a historically-proved checkpoint. (Over-inclusion errs safe — it gates
-- the re-run behind explicit acknowledgement rather than enabling it.)
UPDATE automation_delivery_action_checkpoints
SET terminal_disposition = 'failed:legacy_proved_no_receipt'
WHERE state = 'failed'
  AND receipt IS NULL
  AND proved_at IS NULL
  AND terminal_disposition IS NOT NULL
  AND terminal_disposition NOT LIKE 'failed:%';
