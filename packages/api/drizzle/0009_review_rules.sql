CREATE TABLE review_rules (
  id TEXT PRIMARY KEY,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  match_domain TEXT DEFAULT NULL,
  match_labels TEXT NOT NULL DEFAULT '[]',
  match_priority TEXT DEFAULT NULL,
  assignment_strategy TEXT NOT NULL DEFAULT 'domain_expert'
    CHECK (assignment_strategy IN ('domain_expert', 'round_robin', 'least_loaded', 'random', 'fixed')),
  required_reviews INTEGER NOT NULL DEFAULT 1,
  anti_self_review INTEGER NOT NULL DEFAULT 1,
  fixed_reviewer_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX idx_review_rules_habitat ON review_rules(habitat_id);
--> statement-breakpoint
CREATE TABLE task_reviewers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('human', 'agent')),
  reviewer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT DEFAULT NULL,
  review_note TEXT DEFAULT NULL
);
--> statement-breakpoint
CREATE INDEX idx_task_reviewers_task ON task_reviewers(task_id);
--> statement-breakpoint
CREATE INDEX idx_task_reviewers_reviewer ON task_reviewers(reviewer_id);
