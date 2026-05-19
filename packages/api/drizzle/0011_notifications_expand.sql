ALTER TABLE notification_preferences ADD COLUMN task_review_assigned INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE notification_preferences ADD COLUMN task_priority_changed INTEGER NOT NULL DEFAULT 1;
