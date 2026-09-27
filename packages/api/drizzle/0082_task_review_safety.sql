/*
    Durable review-safety first slice (review-safety ticket + revised
    technical contract with the 2026-09-27 amendment).

    Additive only — four new tables, no column changes to existing tables:

      - task_review_requirements: one row per Task (task_id PK, FK cascade).
        The complete state matrix is enforced by DB CHECKs:
          uncaptured      — never-claimed pending: floors/effective NULL,
                            no claimant, no snapshot linkage, no proof.
          legacy_unknown  — historical uncertainty: non_overridden_floor and
                            effective_count NULL; prospective policy may only
                            accumulate known_policy_floor; no approval proof.
          known_zero      — explicit zero: non_overridden_floor 0,
                            known_policy_floor 0, effective_count 0.
          required        — positive baseline
                            max(non_overridden_floor, known_policy_floor) > 0;
                            effective_count >= baseline unless an audited
                            active_override_id is set (may lower to zero, the
                            state is still `required`, never relabeled zero).
        approved_generation IS NULL or equals review_generation (committed
        terminal-approval proof). Typed claimant is nullness-paired.

      - task_review_snapshots: append-only immutable claim-policy evidence,
        exactly one per successful-claim generation (UNIQUE task_id,
        review_generation): copied winning-rule predicates/order/count/
        strategy/anti-self/fixed ids plus winning task domain/labels/priority
        and the typed claimant, or the explicit no-match record.

      - task_review_decisions: append-only typed reviewer decisions keyed to
        (generation, round). Deliberately NO FK to task_reviewers — a
        removable assignment never deletes decision evidence (identity is
        (reviewer_type, reviewer_id); evidence survives until Task deletion).

      - task_review_overrides: append-only human recovery evidence (actor,
        old/new state and count, expected versions, generation, reason).

    In-migration classifier (same file): EVERY pre-existing Task receives a
    legal row without inventing review history —
      - pending + no persisted assignee + no claim evidence (no claimed_at,
        no `claimed` event) -> origin legacy_unverified, state uncaptured;
      - everything else (ALL approved/done/failed, assigned/claimed/
        in_progress/submitted/rejected, ambiguous pending) ->
        legacy_unverified/legacy_unknown with NULL floor/effective and NO
        approval proof; a single unambiguous persisted assignment records
        typed CUSTODY ONLY (never a claim snapshot or historical floor).
*/
CREATE TABLE `task_review_requirements` (
	`task_id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`state` text NOT NULL,
	`non_overridden_floor` integer,
	`known_policy_floor` integer NOT NULL DEFAULT 0,
	`effective_count` integer,
	`requirement_version` integer NOT NULL DEFAULT 1,
	`review_generation` integer NOT NULL DEFAULT 0,
	`review_round` integer NOT NULL DEFAULT 0,
	`claimant_type` text,
	`claimant_id` text,
	`approved_generation` integer,
	`active_override_id` text,
	`selected_rule_id` text,
	`updated_at` text NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `trr_origin_chk` CHECK (`origin` IN ('ordinary', 'legacy_unverified', 'preset_historical')),
	CONSTRAINT `trr_state_chk` CHECK (`state` IN ('uncaptured', 'legacy_unknown', 'known_zero', 'required')),
	CONSTRAINT `trr_claimant_type_chk` CHECK (`claimant_type` IS NULL OR `claimant_type` IN ('local_agent', 'remote_participant')),
	CONSTRAINT `trr_claimant_pair_chk` CHECK ((`claimant_type` IS NULL AND `claimant_id` IS NULL) OR (`claimant_type` IS NOT NULL AND `claimant_id` IS NOT NULL)),
	CONSTRAINT `trr_floors_nonneg_chk` CHECK (`known_policy_floor` >= 0 AND (`non_overridden_floor` IS NULL OR `non_overridden_floor` >= 0) AND (`effective_count` IS NULL OR `effective_count` >= 0)),
	CONSTRAINT `trr_counters_chk` CHECK (`requirement_version` >= 1 AND `review_generation` >= 0 AND `review_round` >= 0),
	CONSTRAINT `trr_approved_gen_chk` CHECK (`approved_generation` IS NULL OR `approved_generation` = `review_generation`),
	CONSTRAINT `trr_override_scope_chk` CHECK (`active_override_id` IS NULL OR `state` = 'required'),
	CONSTRAINT `trr_uncaptured_chk` CHECK (`state` <> 'uncaptured' OR (`non_overridden_floor` IS NULL AND `effective_count` IS NULL AND `claimant_type` IS NULL AND `claimant_id` IS NULL AND `approved_generation` IS NULL AND `active_override_id` IS NULL AND `selected_rule_id` IS NULL)),
	CONSTRAINT `trr_legacy_unknown_chk` CHECK (`state` <> 'legacy_unknown' OR (`non_overridden_floor` IS NULL AND `effective_count` IS NULL AND `approved_generation` IS NULL AND `active_override_id` IS NULL)),
	CONSTRAINT `trr_known_zero_chk` CHECK (`state` <> 'known_zero' OR (`non_overridden_floor` = 0 AND `known_policy_floor` = 0 AND `effective_count` = 0 AND `active_override_id` IS NULL)),
	CONSTRAINT `trr_required_chk` CHECK (`state` <> 'required' OR (`non_overridden_floor` IS NOT NULL AND (CASE WHEN `non_overridden_floor` >= `known_policy_floor` THEN `non_overridden_floor` ELSE `known_policy_floor` END) > 0 AND `effective_count` IS NOT NULL AND (`active_override_id` IS NOT NULL OR `effective_count` >= (CASE WHEN `non_overridden_floor` >= `known_policy_floor` THEN `non_overridden_floor` ELSE `known_policy_floor` END))))
);
--> statement-breakpoint
CREATE TABLE `task_review_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`review_generation` integer NOT NULL,
	`claimant_type` text NOT NULL,
	`claimant_id` text NOT NULL,
	`matched` integer NOT NULL,
	`required_count` integer NOT NULL CHECK (`required_count` >= 0),
	`rule_id` text,
	`rule_updated_at` text,
	`rule_priority` integer,
	`rule_match_domain` text,
	`rule_match_labels` text,
	`rule_match_priority` text,
	`rule_assignment_strategy` text,
	`rule_anti_self_review` integer,
	`rule_fixed_reviewer_ids` text,
	`task_domain` text,
	`task_labels` text,
	`task_priority` text,
	`captured_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `trs_claimant_type_chk` CHECK (`claimant_type` IN ('local_agent', 'remote_participant'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_review_snapshots_task_gen` ON `task_review_snapshots` (`task_id`,`review_generation`);
--> statement-breakpoint
CREATE INDEX `idx_task_review_snapshots_task` ON `task_review_snapshots` (`task_id`);
--> statement-breakpoint
CREATE TABLE `task_review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`review_generation` integer NOT NULL,
	`review_round` integer NOT NULL,
	`reviewer_type` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`decision` text NOT NULL,
	`decided_at` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`provenance` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `trd_reviewer_type_chk` CHECK (`reviewer_type` IN ('human', 'agent')),
	CONSTRAINT `trd_decision_chk` CHECK (`decision` IN ('approved', 'rejected')),
	CONSTRAINT `trd_actor_type_chk` CHECK (`actor_type` IN ('human', 'agent', 'system', 'remote_human', 'remote_orcy', 'remote_pod'))
);
--> statement-breakpoint
CREATE INDEX `idx_task_review_decisions_task_gen` ON `task_review_decisions` (`task_id`,`review_generation`);
--> statement-breakpoint
CREATE INDEX `idx_task_review_decisions_reviewer` ON `task_review_decisions` (`task_id`,`review_generation`,`reviewer_type`,`reviewer_id`,`decided_at`);
--> statement-breakpoint
CREATE TABLE `task_review_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`review_generation` integer NOT NULL,
	`kind` text NOT NULL,
	`requirement_version_before` integer NOT NULL,
	`task_version` integer NOT NULL,
	`old_state` text NOT NULL,
	`new_state` text NOT NULL,
	`old_effective_count` integer,
	`new_effective_count` integer,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `tro_kind_chk` CHECK (`kind` IN ('resolve_unknown', 'relax_baseline'))
);
--> statement-breakpoint
CREATE INDEX `idx_task_review_overrides_task` ON `task_review_overrides` (`task_id`);
--> statement-breakpoint
INSERT INTO `task_review_requirements` (`task_id`, `origin`, `state`, `non_overridden_floor`, `known_policy_floor`, `effective_count`, `requirement_version`, `review_generation`, `review_round`, `claimant_type`, `claimant_id`, `approved_generation`, `active_override_id`, `selected_rule_id`, `updated_at`)
SELECT
	t.`id`,
	'legacy_unverified',
	CASE
		WHEN t.`status` = 'pending'
			AND t.`assigned_agent_id` IS NULL
			AND t.`remote_assigned_participant_id` IS NULL
			AND t.`claimed_at` IS NULL
			AND NOT EXISTS (SELECT 1 FROM `task_events` e WHERE e.`task_id` = t.`id` AND e.`action` = 'claimed')
		THEN 'uncaptured'
		ELSE 'legacy_unknown'
	END,
	NULL,
	0,
	NULL,
	1,
	0,
	0,
	CASE
		WHEN t.`assigned_agent_id` IS NOT NULL AND t.`remote_assigned_participant_id` IS NULL THEN 'local_agent'
		WHEN t.`assigned_agent_id` IS NULL AND t.`remote_assigned_participant_id` IS NOT NULL THEN 'remote_participant'
		ELSE NULL
	END,
	CASE
		WHEN t.`assigned_agent_id` IS NOT NULL AND t.`remote_assigned_participant_id` IS NULL THEN t.`assigned_agent_id`
		WHEN t.`assigned_agent_id` IS NULL AND t.`remote_assigned_participant_id` IS NOT NULL THEN t.`remote_assigned_participant_id`
		ELSE NULL
	END,
	NULL,
	NULL,
	NULL,
	datetime('now')
FROM `tasks` t;
