CREATE TABLE sprints (
  id TEXT PRIMARY KEY,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning', 'active', 'completed', 'cancelled')),
  committed_mission_ids TEXT NOT NULL DEFAULT '[]',
  completed_mission_ids TEXT NOT NULL DEFAULT '[]',
  capacity_minutes INTEGER DEFAULT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX idx_sprints_habitat ON sprints(habitat_id);
--> statement-breakpoint
CREATE INDEX idx_sprints_status ON sprints(status);
--> statement-breakpoint
CREATE INDEX idx_sprints_dates ON sprints(start_date, end_date);
--> statement-breakpoint
ALTER TABLE missions ADD COLUMN sprint_id TEXT;
--> statement-breakpoint
CREATE INDEX idx_missions_sprint ON missions(sprint_id);
--> statement-breakpoint
ALTER TABLE habitats ADD COLUMN carry_over_policy TEXT NOT NULL DEFAULT 'backlog';
