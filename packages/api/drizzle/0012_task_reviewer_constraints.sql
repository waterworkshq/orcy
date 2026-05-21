CREATE UNIQUE INDEX uq_task_reviewers_task_reviewer ON task_reviewers(task_id, reviewer_id);
--> statement-breakpoint
CREATE INDEX idx_task_reviewers_task_status ON task_reviewers(task_id, status);
