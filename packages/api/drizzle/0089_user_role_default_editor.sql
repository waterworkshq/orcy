-- Default new users to editor instead of admin. Preserve every existing role
-- while replacing only the column definition, leaving the users table and all
-- inbound foreign keys in place.
CREATE TABLE `users_role_0089` (
  `id` text PRIMARY KEY NOT NULL,
  `role` text NOT NULL
);
--> statement-breakpoint

INSERT INTO `users_role_0089` (`id`, `role`)
SELECT `id`, `role` FROM `users`;
--> statement-breakpoint

ALTER TABLE `users` DROP COLUMN `role`;
--> statement-breakpoint

ALTER TABLE `users` ADD COLUMN `role` text DEFAULT 'editor' NOT NULL;
--> statement-breakpoint

UPDATE `users`
SET `role` = (
  SELECT `role` FROM `users_role_0089` WHERE `users_role_0089`.`id` = `users`.`id`
);
--> statement-breakpoint

DROP TABLE `users_role_0089`;
