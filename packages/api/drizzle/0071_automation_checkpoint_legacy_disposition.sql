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
