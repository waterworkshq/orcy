/*
    Chat review decisions through the canonical lifecycle (REC-06, first
    bounded ticket) — workspace anchor + explicit speaker mapping.

    Additive only:

      - chat_integrations.provider_workspace_id: NULLABLE trusted anchor
        (Slack team_id / Discord guild_id) entered by the operator. Existing
        rows stay NULL and therefore PUSH-ONLY — a review decision can never
        resolve against them (resolution requires provider + signed
        workspace + non-null channel, exact tuple; ambiguity refuses).
        Never inferred from a request body; never an env fallback.

      - chat_speaker_mappings: explicit per-integration attribution of a
        provider speaker (workspace-scoped) to a LOCAL user. The mapping is
        the attribution of the actual speaker, not an impersonation claim;
        habitat_id is DERIVED from the integration row (never the request),
        so a mapping cannot live in a foreign habitat. Integration deletion
        cascades its mappings; local-user deletion is RESTRICTED (pinned by
        test) — attribution never silently orphans. Composite UNIQUE
        (integration_id, provider_workspace_id, provider_speaker_id):
        workspace-scoped speaker ids cannot collide across workspaces.
*/
ALTER TABLE `chat_integrations` ADD `provider_workspace_id` text;
--> statement-breakpoint
CREATE TABLE `chat_speaker_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_workspace_id` text NOT NULL,
	`provider_speaker_id` text NOT NULL,
	`local_user_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`integration_id`) REFERENCES `chat_integrations`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`local_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_speaker_mappings_identity` ON `chat_speaker_mappings` (`integration_id`,`provider_workspace_id`,`provider_speaker_id`);
--> statement-breakpoint
CREATE INDEX `idx_chat_speaker_mappings_habitat` ON `chat_speaker_mappings` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_chat_speaker_mappings_integration` ON `chat_speaker_mappings` (`integration_id`);
