-- v0.19 Pod Bridge: provider-backed identity, pod trust, scoped grants,
-- remote credentials, idempotency, and remote webhook endpoints.
-- Local-only deployments are unaffected; these tables are only used when
-- shared habitat access is explicitly configured.

CREATE TABLE `identity_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`issuer` text,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_identity_providers_habitat` ON `identity_providers` (`habitat_id`, `enabled`);
--> statement-breakpoint
CREATE INDEX `idx_identity_providers_kind` ON `identity_providers` (`habitat_id`, `kind`);
--> statement-breakpoint

CREATE TABLE `identity_provider_auth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`state` text NOT NULL,
	`nonce` text,
	`pkce_verifier` text,
	`invite_id` text,
	`context` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `identity_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_identity_provider_auth_states_state` ON `identity_provider_auth_states` (`state`);
--> statement-breakpoint
CREATE INDEX `idx_identity_provider_auth_states_provider` ON `identity_provider_auth_states` (`provider_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_identity_provider_auth_states_expires` ON `identity_provider_auth_states` (`status`, `expires_at`);
--> statement-breakpoint

CREATE TABLE `external_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`external_subject` text NOT NULL,
	`account_login` text,
	`account_name` text,
	`email` text,
	`profile_data` text DEFAULT '{}' NOT NULL,
	`local_user_id` text,
	`remote_participant_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `identity_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`local_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_identities_provider_subject` ON `external_identities` (`provider_id`, `external_subject`);
--> statement-breakpoint
CREATE INDEX `idx_external_identities_habitat` ON `external_identities` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_external_identities_local_user` ON `external_identities` (`local_user_id`);
--> statement-breakpoint

CREATE TABLE `remote_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`invite_type` text NOT NULL,
	`baseline_standing` text NOT NULL,
	`baseline_scopes` text DEFAULT '[]' NOT NULL,
	`token_hash` text,
	`provider_id` text,
	`invited_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text,
	`accepted_at` text,
	`accepted_by` text,
	`revoked_at` text,
	`revoked_by` text,
	`revoke_reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_invites_habitat_status` ON `remote_invites` (`habitat_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_invites_token_hash` ON `remote_invites` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_remote_invites_provider` ON `remote_invites` (`provider_id`);
--> statement-breakpoint

CREATE TABLE `remote_pods` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`trust_metadata` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`default_standing` text DEFAULT 'remote_observer' NOT NULL,
	`invite_id` text,
	`provider_pod_identity` text,
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	`revoke_reason` text,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_pods_habitat_status` ON `remote_pods` (`habitat_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_pods_invite` ON `remote_pods` (`invite_id`);
--> statement-breakpoint

CREATE TABLE `remote_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`remote_pod_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`participant_type` text NOT NULL,
	`display_name` text NOT NULL,
	`standing` text DEFAULT 'remote_observer' NOT NULL,
	`proposed_capabilities` text DEFAULT '[]' NOT NULL,
	`proposed_domains` text DEFAULT '[]' NOT NULL,
	`approved_capabilities` text DEFAULT '[]' NOT NULL,
	`approved_domains` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`external_identity_id` text,
	`registered_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`suspended_at` text,
	`revoked_at` text,
	FOREIGN KEY (`remote_pod_id`) REFERENCES `remote_pods`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_participants_pod` ON `remote_participants` (`remote_pod_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_participants_habitat` ON `remote_participants` (`habitat_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_participants_standing` ON `remote_participants` (`habitat_id`, `standing`);
--> statement-breakpoint

CREATE TABLE `remote_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`remote_participant_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`credential_type` text NOT NULL,
	`secret_hash` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`rotated_from_id` text,
	`rotated_at` text,
	`rotated_by` text,
	`revoked_at` text,
	`revoked_by` text,
	`revoke_reason` text,
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`remote_participant_id`) REFERENCES `remote_participants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_credentials_participant` ON `remote_credentials` (`remote_participant_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_credentials_type` ON `remote_credentials` (`habitat_id`, `credential_type`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_credentials_hash` ON `remote_credentials` (`secret_hash`);
--> statement-breakpoint

CREATE TABLE `remote_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`remote_pod_id` text NOT NULL,
	`remote_participant_id` text,
	`grant_type` text NOT NULL,
	`standing` text NOT NULL,
	`action_scopes` text DEFAULT '[]' NOT NULL,
	`eligibility_mode` text DEFAULT 'allowlist' NOT NULL,
	`include_future_matches` integer DEFAULT false NOT NULL,
	`grace_window_hours` integer DEFAULT 24 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text,
	`expired_at` text,
	`revocation_mode` text,
	`revoked_at` text,
	`revoked_by` text,
	`revoke_reason` text,
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`remote_pod_id`) REFERENCES `remote_pods`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`remote_participant_id`) REFERENCES `remote_participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_grants_habitat` ON `remote_grants` (`habitat_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_grants_pod` ON `remote_grants` (`remote_pod_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_grants_participant` ON `remote_grants` (`remote_participant_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_grants_type` ON `remote_grants` (`habitat_id`, `grant_type`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_grants_expires` ON `remote_grants` (`status`, `expires_at`);
--> statement-breakpoint

CREATE TABLE `remote_grant_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `remote_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_grant_targets_grant` ON `remote_grant_targets` (`grant_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_grant_targets_unique` ON `remote_grant_targets` (`grant_id`, `target_type`, `target_id`);
--> statement-breakpoint

CREATE TABLE `remote_grant_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`domains` text DEFAULT '[]' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`time_window_start` text,
	`time_window_end` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `remote_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_grant_rules_grant` ON `remote_grant_rules` (`grant_id`);
--> statement-breakpoint

CREATE TABLE `remote_grant_task_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`task_id` text NOT NULL,
	`matched_at` text NOT NULL,
	`match_reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `remote_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_grant_task_snapshots_grant` ON `remote_grant_task_snapshots` (`grant_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_grant_task_snapshots_unique` ON `remote_grant_task_snapshots` (`grant_id`, `task_id`);
--> statement-breakpoint

CREATE TABLE `remote_idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`remote_participant_id` text NOT NULL,
	`remote_credential_id` text,
	`action` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`error_message` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_idempotency_keys_key` ON `remote_idempotency_keys` (`remote_participant_id`, `action`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_remote_idempotency_keys_expires` ON `remote_idempotency_keys` (`status`, `expires_at`);
--> statement-breakpoint

CREATE TABLE `remote_webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`remote_pod_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`secret_hash` text,
	`last_test_at` text,
	`last_test_status` text,
	`approved_by` text,
	`approved_at` text,
	`enabled_by` text,
	`enabled_at` text,
	`rejected_at` text,
	`rejected_by` text,
	`reject_reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`remote_pod_id`) REFERENCES `remote_pods`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_remote_webhook_endpoints_pod` ON `remote_webhook_endpoints` (`remote_pod_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_remote_webhook_endpoints_habitat` ON `remote_webhook_endpoints` (`habitat_id`, `status`);
