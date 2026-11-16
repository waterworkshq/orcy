-- Add the documented domain CHECKs with per-column swaps except for the
-- zero-inbound-FK task_events rebuild explicitly permitted below.
-- The staged production runner applies each marked column section in its own
-- transaction. A dirty section rolls back at its temporary zero-anomaly guard,
-- receives a persisted dirty attestation, and does not block clean sections.

-- orcy-guarded-column: tasks.priority tasks_priority_check
CREATE TEMP TABLE __enum_check_guard_0090 (
  anomaly_count INTEGER NOT NULL CHECK (anomaly_count = 0)
);
--> statement-breakpoint
INSERT INTO __enum_check_guard_0090 (anomaly_count)
SELECT COUNT(*) FROM tasks
WHERE priority IS NULL OR priority NOT IN ('low', 'medium', 'high', 'critical');
--> statement-breakpoint
CREATE TABLE tasks_priority_0090 (
  id TEXT PRIMARY KEY NOT NULL,
  priority TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO tasks_priority_0090 (id, priority)
SELECT id, priority FROM tasks;
--> statement-breakpoint
DROP INDEX idx_tasks_priority;
--> statement-breakpoint
ALTER TABLE tasks DROP COLUMN priority;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium' NOT NULL
  CONSTRAINT tasks_priority_check CHECK (priority IN ('low', 'medium', 'high', 'critical'));
--> statement-breakpoint
UPDATE tasks
SET priority = (SELECT priority FROM tasks_priority_0090 WHERE tasks_priority_0090.id = tasks.id);
--> statement-breakpoint
DROP TABLE tasks_priority_0090;
--> statement-breakpoint
CREATE INDEX idx_tasks_priority ON tasks(priority);
--> statement-breakpoint
DROP TABLE __enum_check_guard_0090;
--> statement-breakpoint

-- orcy-guarded-column: tasks.status tasks_status_check
CREATE TEMP TABLE __enum_check_guard_0090 (
  anomaly_count INTEGER NOT NULL CHECK (anomaly_count = 0)
);
--> statement-breakpoint
INSERT INTO __enum_check_guard_0090 (anomaly_count)
SELECT COUNT(*) FROM tasks
WHERE status IS NULL OR status NOT IN
  ('pending', 'claimed', 'in_progress', 'submitted', 'approved', 'rejected', 'done', 'failed');
--> statement-breakpoint
CREATE TABLE tasks_status_0090 (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO tasks_status_0090 (id, status)
SELECT id, status FROM tasks;
--> statement-breakpoint
DROP INDEX idx_tasks_status;
--> statement-breakpoint
ALTER TABLE tasks DROP COLUMN status;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'pending' NOT NULL
  CONSTRAINT tasks_status_check CHECK (status IN
    ('pending', 'claimed', 'in_progress', 'submitted', 'approved', 'rejected', 'done', 'failed'));
--> statement-breakpoint
UPDATE tasks
SET status = (SELECT status FROM tasks_status_0090 WHERE tasks_status_0090.id = tasks.id);
--> statement-breakpoint
DROP TABLE tasks_status_0090;
--> statement-breakpoint
CREATE INDEX idx_tasks_status ON tasks(status);
--> statement-breakpoint
DROP TABLE __enum_check_guard_0090;
--> statement-breakpoint

-- orcy-guarded-column: agents.type agents_type_check
CREATE TEMP TABLE __enum_check_guard_0090 (
  anomaly_count INTEGER NOT NULL CHECK (anomaly_count = 0)
);
--> statement-breakpoint
INSERT INTO __enum_check_guard_0090 (anomaly_count)
SELECT COUNT(*) FROM agents
WHERE type IS NULL OR type NOT IN ('claude-code', 'codex', 'opencode', 'cursor', 'gemini');
--> statement-breakpoint
CREATE TABLE agents_type_0090 (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT
);
--> statement-breakpoint
INSERT INTO agents_type_0090 (id, type)
SELECT id, type FROM agents;
--> statement-breakpoint
-- Existing rows otherwise see the new column as NULL and reject this ADD.
-- Disable checks only for that statement; the runner also forces OFF on exit.
PRAGMA ignore_check_constraints = ON;
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN type_new TEXT
  CONSTRAINT agents_type_check CHECK (
    type_new IS NOT NULL AND type_new IN ('claude-code', 'codex', 'opencode', 'cursor', 'gemini')
  );
--> statement-breakpoint
PRAGMA ignore_check_constraints = OFF;
--> statement-breakpoint
UPDATE agents
SET type_new = (SELECT type FROM agents_type_0090 WHERE agents_type_0090.id = agents.id);
--> statement-breakpoint
ALTER TABLE agents DROP COLUMN type;
--> statement-breakpoint
ALTER TABLE agents RENAME COLUMN type_new TO type;
--> statement-breakpoint
DROP TABLE agents_type_0090;
--> statement-breakpoint
DROP TABLE __enum_check_guard_0090;
--> statement-breakpoint

-- orcy-guarded-column: agents.status agents_status_check
CREATE TEMP TABLE __enum_check_guard_0090 (
  anomaly_count INTEGER NOT NULL CHECK (anomaly_count = 0)
);
--> statement-breakpoint
INSERT INTO __enum_check_guard_0090 (anomaly_count)
SELECT COUNT(*) FROM agents
WHERE status IS NULL OR status NOT IN ('idle', 'working', 'offline');
--> statement-breakpoint
CREATE TABLE agents_status_0090 (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO agents_status_0090 (id, status)
SELECT id, status FROM agents;
--> statement-breakpoint
DROP INDEX idx_agents_status;
--> statement-breakpoint
ALTER TABLE agents DROP COLUMN status;
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'idle' NOT NULL
  CONSTRAINT agents_status_check CHECK (status IN ('idle', 'working', 'offline'));
--> statement-breakpoint
UPDATE agents
SET status = (SELECT status FROM agents_status_0090 WHERE agents_status_0090.id = agents.id);
--> statement-breakpoint
DROP TABLE agents_status_0090;
--> statement-breakpoint
CREATE INDEX idx_agents_status ON agents(status);
--> statement-breakpoint
DROP TABLE __enum_check_guard_0090;
--> statement-breakpoint

-- orcy-guarded-column: team_members.role team_members_role_check
CREATE TEMP TABLE __enum_check_guard_0090 (
  anomaly_count INTEGER NOT NULL CHECK (anomaly_count = 0)
);
--> statement-breakpoint
INSERT INTO __enum_check_guard_0090 (anomaly_count)
SELECT COUNT(*) FROM team_members
WHERE role IS NULL OR role NOT IN ('owner', 'admin', 'member');
--> statement-breakpoint
CREATE TABLE team_members_role_0090 (
  id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO team_members_role_0090 (id, role)
SELECT id, role FROM team_members;
--> statement-breakpoint
ALTER TABLE team_members DROP COLUMN role;
--> statement-breakpoint
ALTER TABLE team_members ADD COLUMN role TEXT DEFAULT 'member' NOT NULL
  CONSTRAINT team_members_role_check CHECK (role IN ('owner', 'admin', 'member'));
--> statement-breakpoint
UPDATE team_members
SET role = (SELECT role FROM team_members_role_0090 WHERE team_members_role_0090.id = team_members.id);
--> statement-breakpoint
DROP TABLE team_members_role_0090;
--> statement-breakpoint
DROP TABLE __enum_check_guard_0090;
--> statement-breakpoint

-- orcy-guarded-column: users.role users_role_check
CREATE TEMP TABLE __enum_check_guard_0090 (
  anomaly_count INTEGER NOT NULL CHECK (anomaly_count = 0)
);
--> statement-breakpoint
INSERT INTO __enum_check_guard_0090 (anomaly_count)
SELECT COUNT(*) FROM users
WHERE role IS NULL OR role NOT IN ('admin', 'editor', 'viewer');
--> statement-breakpoint
CREATE TABLE users_role_check_0090 (
  id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO users_role_check_0090 (id, role)
SELECT id, role FROM users;
--> statement-breakpoint
ALTER TABLE users DROP COLUMN role;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'editor' NOT NULL
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'editor', 'viewer'));
--> statement-breakpoint
UPDATE users
SET role = (SELECT role FROM users_role_check_0090 WHERE users_role_check_0090.id = users.id);
--> statement-breakpoint
DROP TABLE users_role_check_0090;
--> statement-breakpoint
DROP TABLE __enum_check_guard_0090;
--> statement-breakpoint

-- task_events is deliberately last: it is the largest table and has zero inbound
-- FKs, making this the one table where a full rebuild cannot cascade children.
-- orcy-guarded-column: task_events.actor_type task_events_actor_type_check task_events_orphans_0090
-- orcy-archive-statement
-- The runner commits these idempotent archive statements BEFORE the guarded
-- rebuild so a dirty guard cannot roll back the preservation inventory.
CREATE TABLE IF NOT EXISTS task_events_orphans_0090 (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_column_id TEXT,
  to_column_id TEXT,
  from_status TEXT,
  to_status TEXT,
  metadata TEXT NOT NULL,
  execution_token TEXT,
  timestamp TEXT DEFAULT '(datetime(''now''))' NOT NULL
);
--> statement-breakpoint
-- orcy-archive-statement
INSERT INTO task_events_orphans_0090 (
  id, task_id, actor_type, actor_id, action, from_column_id, to_column_id,
  from_status, to_status, metadata, execution_token, timestamp
)
SELECT
  id, task_id, actor_type, actor_id, action, from_column_id, to_column_id,
  from_status, to_status, metadata, execution_token, timestamp
FROM task_events e
WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = e.task_id)
  AND NOT EXISTS (SELECT 1 FROM task_events_orphans_0090 o WHERE o.id = e.id);
--> statement-breakpoint
CREATE TEMP TABLE __enum_check_guard_0090 (
  anomaly_count INTEGER NOT NULL CHECK (anomaly_count = 0)
);
--> statement-breakpoint
INSERT INTO __enum_check_guard_0090 (anomaly_count)
SELECT COUNT(*) FROM task_events e
WHERE e.actor_type IS NULL OR e.actor_type NOT IN
  ('human', 'agent', 'system', 'remote_human', 'remote_orcy', 'remote_pod')
  OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = e.task_id);
--> statement-breakpoint
CREATE TABLE task_events_new (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CONSTRAINT task_events_actor_type_check CHECK (actor_type IN
    ('human', 'agent', 'system', 'remote_human', 'remote_orcy', 'remote_pod')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_column_id TEXT,
  to_column_id TEXT,
  from_status TEXT,
  to_status TEXT,
  metadata TEXT NOT NULL,
  execution_token TEXT,
  timestamp TEXT DEFAULT '(datetime(''now''))' NOT NULL
);
--> statement-breakpoint
INSERT INTO task_events_new (
  id, task_id, actor_type, actor_id, action, from_column_id, to_column_id,
  from_status, to_status, metadata, execution_token, timestamp
)
SELECT
  id, task_id, actor_type, actor_id, action, from_column_id, to_column_id,
  from_status, to_status, metadata, execution_token, timestamp
FROM task_events e
-- Mirror the orphan archive predicate so no replacement FK can abort the copy.
WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = e.task_id);
--> statement-breakpoint
DROP TABLE task_events;
--> statement-breakpoint
ALTER TABLE task_events_new RENAME TO task_events;
--> statement-breakpoint
CREATE INDEX idx_task_events_task_id ON task_events(task_id);
--> statement-breakpoint
CREATE INDEX idx_task_events_timestamp ON task_events(timestamp);
--> statement-breakpoint
CREATE INDEX idx_task_events_actor ON task_events(actor_type, actor_id);
--> statement-breakpoint
CREATE INDEX idx_task_events_from_column_time ON task_events(from_column_id, timestamp);
--> statement-breakpoint
CREATE INDEX idx_task_events_to_column_time ON task_events(to_column_id, timestamp);
--> statement-breakpoint
CREATE INDEX idx_task_events_transition_time
  ON task_events(from_column_id, to_column_id, timestamp);
--> statement-breakpoint
DROP TABLE __enum_check_guard_0090;
