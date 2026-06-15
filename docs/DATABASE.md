# Database Documentation

Schema reference for the Orcy database.

The API uses **Drizzle ORM** with **better-sqlite3** for production. A separate `sql.js` driver is used for test environments only. Data is persisted to a file at the path configured via `DB_PATH` (default: `orcy.db` in the workspace root).

**Key characteristics:**

- Zero external database dependency in development
- File-based persistence via SQLite WAL mode
- In-memory during runtime (fast reads via sqlite_vec potentially)
- Single writer (SQLite limitation)
- PostgreSQL supported via `setDriver('postgres')` in dialect helpers

**Drizzle configuration:**

```typescript
// packages/api/drizzle.config.ts
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
});
```

**Database initialization (`packages/api/src/db/index.ts`):**

- `initDb(dbPath?)` — initializes with `better-sqlite3`, sets WAL mode + foreign keys ON
- `initTestDb()` — initializes with `sql.js` (for tests)
- `getDb()` — returns the singleton DrizzleDB instance
- `DB_PATH` env var controls database file location

---

## Schema Reference

The schema is defined in `packages/api/src/db/schema.ts` using Drizzle ORM. Schema uses `camelCase` TypeScript property names mapped to `snake_case` SQL column names via Drizzle column inference.

### Entity-Relationship Diagram (62 tables)

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ organizations     │────<│ teams            │────<│ team_members     │
│                  │     │                  │     │                  │
│ id (PK)          │     │ id (PK)          │     │ id (PK)          │
│ name             │     │ organizationId   │     │ teamId (FK)      │
│ slug (unique)     │     │ name             │     │ userId (FK)      │
│ createdAt        │     │ slug (unique)    │     │ role             │
└──────────────────┘     │ createdAt        │     │ joinedAt         │
                           └──────────────────┘     └──────────────────┘
                                 │
                                 │ (teamId)
                                 ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ habitats         │────<│ columns         │     │ agents          │
│                  │     │                  │     │                  │
│ id (PK)          │     │ id (PK)          │     │ id (PK)          │
│ name             │     │ boardId (FK)     │     │ name (unique)    │
│ description      │     │ name             │     │ type             │
│ retrySettings    │     │ order            │     │ domain           │
│ anomalySettings │     │ wipLimit         │     │ capabilities     │
│ autoAssignSettings│   │ autoAdvance      │     │ status           │
│ codeReviewSettings│    │ requiresClaim    │     │ currentTaskId    │
│ eventRetentionDays│    │ nextColumnId     │     │ apiKey (plain)  │
│ ciCdSettings    │     │ isTerminal       │     │ lastHeartbeat    │
│ gitWorktreeSettings│    └──────────────────┘     │ metadata         │
│ teamId (FK→teams)│          │                  │ rateLimitPerMin  │
│ createdAt        │          │ (columnId)        │ createdAt        │
│ updatedAt        │          ▼                  └──────────────────┘
└──────────────────┘   ┌──────────────────┐            │
│ missions         │            │
                        │                  │────────────┘
                        │ id (PK)          │  (no direct FK)
                        │ boardId (FK)     │
                        │ columnId (FK)    │
                        │ title            │
                        │ description      │
                        │ acceptanceCriteria│
                        │ priority         │
                        │ labels (JSON)    │
                        │ status           │
                        │ displayOrder    │
                        │ dependsOn (JSON) │
                        │ blocks (JSON)   │
                        │ dueAt           │
                        │ slaMinutes      │
                        │ slaDeadlineAt   │
                        │ isArchived      │
                        │ createdBy       │
                        │ version         │
                        └────────┬─────────┘
                                 │ (featureId)
                                 ▼
                        ┌──────────────────┐     ┌──────────────────┐
                        │ tasks            │────<│ task_subtasks    │
                        │                  │     │                  │
                        │ id (PK)          │     │ id (PK)          │
                        │ featureId (FK)   │     │ taskId (FK)      │
                        │ title            │     │ title            │
                        │ description      │     │ completed       │
                        │ priority         │     │ order            │
                        │ assignedAgentId │     │ assigneeId (FK)  │
                        │ requiredDomain  │     └──────────────────┘
                        │ requiredCapabilities│
                        │ status          │   ┌──────────────────┐
                        │ claimedAt       │   │ feature_watchers │
                        │ startedAt       │   │                  │
                        │ submittedAt     │   │ featureId (FK)   │
                        │ completedAt     │   │ userId (FK)      │
                        │ rejectedCount   │   └──────────────────┘
                        │ rejectionReason │
                        │ result          │   ┌──────────────────┐
                        │ artifacts (JSON)│   │ task_watchers    │
                        │ order           │   │                  │
                        │ createdBy       │   │ taskId (FK)      │
                        │ version         │   │ userId (FK)      │
                        │ estimatedMinutes│   └──────────────────┘
                        │ delegatedToAgentId│
                        │ retryPolicy     │   ┌──────────────────┐
                        │ retryCount      │   │ task_attachments │
                        │ nextRetryAt     │   │                  │
                        └──────────────────┘   │ id (PK)          │
                                              │ taskId (FK)      │
         │                                    │ filename         │
         │ (taskId)                           │ originalName     │
         ▼                                    │ mimeType         │
┌──────────────────┐     ┌──────────────────┐ │ sizeBytes        │
│ task_events      │     │ task_comments    │ │ uploadedBy        │
│                  │     │                  │ └──────────────────┘
│ id (PK)          │     │ id (PK)          │
│ taskId (FK)      │     │ taskId (FK)      │ ┌──────────────────┐
│ actorType        │     │ parentId (FK→cmts)│ │ feature_events   │
│ actorId          │     │ authorType       │ │                  │
│ action           │     │ authorId         │ │ id (PK)          │
│ fromColumnId     │     │ content          │ │ featureId (FK)   │
│ toColumnId       │     │ createdAt        │ │ actorType        │
│ fromStatus       │     │ updatedAt        │ │ actorId          │
│ toStatus         │     └────────┬─────────┘ │ action           │
│ metadata (JSON)  │              │ (commentId) │ fromColumnId     │
│ timestamp        │              ▼            │ toColumnId       │
└──────────────────┘     ┌──────────────────┐  │ fromStatus       │
                          │ task_comment_   │  │ toStatus         │
                          │ mentions         │  │ metadata (JSON)  │
                          │                  │  │ timestamp        │
                          │ id (PK)          │  └──────────────────┘
                          │ commentId (FK)   │
                          │ mentionedType    │ ┌──────────────────┐
                          │ mentionedId      │ │ feature_         │
                          │ mentionText      │ │ dependencies     │
                          └──────────────────┘ │                  │
                                               │ featureId (FK)   │
┌──────────────────┐     ┌──────────────────┐ │ dependsOnId (FK) │
│ task_dependencies│     │ feature_templates│ └──────────────────┘
│                  │     │                  │
│ taskId (FK)      │     │ id (PK)          │ ┌──────────────────┐
│ dependsOnId (FK) │     │ boardId (FK)     │ │ saved_filters    │
└──────────────────┘     │ name             │ │                  │
                         │ titlePattern     │ │ id (PK)          │
                         │ descriptionPattern│ │ boardId (FK)     │
                         │ priority         │ │ userId           │
                         │ labels (JSON)    │ │ name             │
                         │ requiredDomain  │ │ filterConfig     │
                         │ requiredCapabilities│ │ isBuiltin        │
                         │ isDefault        │ │ createdAt        │
                         │ usageCount       │ └──────────────────┘
                         │ createdBy        │
                         │ createdAt        │
                         └──────────────────┘

┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ webhook_subscr   │     │ notification_    │     │ chat_integrations│
│                  │     │ preferences      │     │                  │
│ id (PK)          │     │                  │     │ id (PK)          │
│ boardId (FK)     │     │ id (PK)          │     │ boardId (FK)     │
│ name             │     │ userId           │     │ provider         │
│ url              │     │ boardId (FK)     │     │ webhookUrl       │
│ secret           │     │ taskAssigned     │     │ channelId        │
│ events (JSON)    │     │ taskSubmitted    │     │ botToken         │
│ format           │     │ taskApproved     │     │ enabled          │
│ headers (JSON)   │     │ taskRejected     │     │ events (JSON)    │
│ enabled          │     │ taskOverdue      │     │ createdAt        │
│ createdAt        │     │ taskMentioned    │     │ updatedAt        │
│ updatedAt        │     │ taskWatching     │ └──────────────────┘
└────────┬─────────┘     │ createdAt        │
         │ (subscriptionId)│ updatedAt       │ ┌──────────────────┐
         ▼               └──────────────────┘ │ agent_messages   │
┌──────────────────┐                          │                  │
│ webhook_deliveries│                         │ id (PK)          │
│                  │                          │ boardId (FK)     │
│ id (PK)          │                          │ fromAgentId (FK) │
│ subscriptionId(FK)│                         │ toAgentId (FK)   │
│ eventType        │                          │ taskId (FK)     │
│ payload          │                          │ subject          │
│ status           │                          │ body             │
│ statusCode       │                          │ messageType     │
│ responseBody     │                          │ priority         │
│ attempts         │                          │ readAt           │
│ createdAt        │                          │ createdAt        │
│ lastAttemptAt   │                          └──────────────────┘
│ nextRetryAt     │
└──────────────────┘     ┌──────────────────┐     ┌──────────────────┐
                         │ pull_requests    │     │ pipeline_events  │
                         │                  │     │                  │
                         │ id (PK)          │     │ id (PK)          │
                         │ taskId (FK)      │     │ taskId (FK)      │
                         │ provider         │     │ provider         │
                         │ repo             │     │ repo             │
                         │ prNumber         │     │ runId            │
                         │ prTitle          │     │ status           │
                         │ prUrl            │     │ branch           │
                         │ branchName       │     │ commitSha        │
                         │ state            │     │ createdAt        │
                         │ reviewStatus     │     └──────────────────┘
                         │ createdAt        │
                         │ updatedAt        │
                         └──────────────────┘
```

### Drizzle Schema — Table Definitions

> **Note:** SQL column names use `snake_case`. TypeScript uses `camelCase` (Drizzle maps automatically).

#### `boards`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Board identifier (UUID) |
| `name` | TEXT | NOT NULL | Board name |
| `description` | TEXT | NOT NULL DEFAULT '' | Board description |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |
| `retry_settings` | TEXT | JSON | Retry policy configuration |
| `anomaly_settings` | TEXT | JSON | Anomaly detection settings |
| `auto_assign_settings` | TEXT | JSON | Auto-assignment settings |
| `code_review_settings` | TEXT | JSON | Code review integration settings |
| `event_retention_days` | INTEGER | DEFAULT 90 | Days to retain task events |
| `ci_cd_settings` | TEXT | JSON | CI/CD integration settings |
| `git_worktree_settings` | TEXT | JSON | Git worktree configuration |
| `prioritization_settings` | TEXT | JSON, nullable | Dynamic prioritization rules configuration (`PrioritizationSettings | null`) |
| `team_id` | TEXT | FK → teams(id) ON DELETE SET NULL | Owning team |

**Indexes:** `idx_boards_name`, `idx_boards_team_id`

#### `columns`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Column identifier (UUID) |
| `board_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent board |
| `name` | TEXT | NOT NULL | Column display name |
| `order` | INTEGER | NOT NULL | Sort position |
| `wip_limit` | INTEGER | DEFAULT NULL | Work-in-progress limit |
| `auto_advance` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Auto-move to next column on approve |
| `requires_claim` | INTEGER | NOT NULL DEFAULT 1 (boolean) | Must claim before moving here |
| `next_column_id` | TEXT | FK → columns(id) | Next column for auto-advance |
| `is_terminal` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Terminal column (marks tasks as done) |

**Constraints:** `UNIQUE(board_id, order)`
**Indexes:** `idx_columns_board_id`, `idx_columns_next`

#### `features`

The board-level cards. Features flow through columns and contain tasks. Feature status is auto-derived from child task states.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Feature identifier (UUID) |
| `board_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent board |
| `column_id` | TEXT | NOT NULL FK → columns(id) | Current column |
| `title` | TEXT | NOT NULL | Feature title |
| `description` | TEXT | NOT NULL DEFAULT '' | Detailed description (feature brief) |
| `acceptance_criteria` | TEXT | NOT NULL DEFAULT '' | What defines this feature as complete |
| `priority` | TEXT | NOT NULL DEFAULT 'medium' CHECK (IN 'low','medium','high','critical') | Priority level |
| `labels` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of strings |
| `status` | TEXT | NOT NULL DEFAULT 'not_started' CHECK (IN 'not_started','in_progress','review','done','failed') | Auto-derived from tasks |
| `display_order` | INTEGER | NOT NULL DEFAULT 0 | Sort order within column |
| `depends_on` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of feature UUIDs |
| `blocks` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of feature UUIDs |
| `due_at` | TEXT | DEFAULT NULL | Due date (ISO 8601) |
| `sla_minutes` | INTEGER | DEFAULT NULL | SLA threshold in minutes |
| `sla_deadline_at` | TEXT | DEFAULT NULL | Computed SLA deadline |
| `is_archived` | INTEGER | NOT NULL DEFAULT 0 (boolean) | True if feature is archived |
| `actual_minutes` | INTEGER | DEFAULT NULL | Actual time spent on feature tasks |
| `planned_minutes` | INTEGER | DEFAULT NULL | Planned time estimate |
| `planning_accuracy` | INTEGER | DEFAULT NULL | Estimation accuracy percentage |
| `completed_at` | TEXT | DEFAULT NULL | When the feature was completed |
| `created_by` | TEXT | NOT NULL | Creator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |
| `version` | INTEGER | NOT NULL DEFAULT 1 | Optimistic locking version |

**Indexes:** `idx_features_board_column(board_id, column_id)`, `idx_features_status`, `idx_features_priority`, `idx_features_column_order(column_id, display_order)`, `idx_features_due_at`

#### `feature_dependencies`

Cross-feature dependency edges. Only feature-level dependencies exist (no cross-feature task dependencies).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `feature_id` | TEXT | NOT NULL FK → features(id) ON DELETE CASCADE | Dependent feature |
| `depends_on_id` | TEXT | NOT NULL FK → features(id) ON DELETE CASCADE | Blocking feature |

**Constraints:** `PRIMARY KEY (feature_id, depends_on_id)`
**Indexes:** `idx_feature_deps_depends_on`

#### `feature_events`

Feature-level audit trail for column movements and status changes.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Event identifier (UUID) |
| `feature_id` | TEXT | NOT NULL FK → features(id) ON DELETE CASCADE | Related feature |
| `actor_type` | TEXT | NOT NULL CHECK (IN 'human','agent','system') | Actor type |
| `actor_id` | TEXT | NOT NULL | UUID of the actor |
| `action` | TEXT | NOT NULL CHECK (IN 'created','updated','moved','status_changed','completed','deleted','dependency_resolved','code_evidence_linked','code_evidence_corrected','code_evidence_gap_reported','code_evidence_gap_resolved','code_evidence_marked_not_applicable','code_evidence_cleared_not_applicable') | Event action |
| `from_column_id` | TEXT | DEFAULT NULL | Source column |
| `to_column_id` | TEXT | DEFAULT NULL | Target column |
| `from_status` | TEXT | DEFAULT NULL | Previous status |
| `to_status` | TEXT | DEFAULT NULL | New status |
| `metadata` | TEXT | NOT NULL DEFAULT '{}' (JSON) | JSON blob with details |
| `timestamp` | TEXT | NOT NULL DEFAULT (datetime('now')) | Event timestamp |

**Indexes:** `idx_feature_events_feature`, `idx_feature_events_timestamp(timestamp DESC)`

#### `feature_watchers`

Feature-level watch notifications (replaces task_watchers for new features).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `feature_id` | TEXT | NOT NULL FK → features(id) ON DELETE CASCADE | Watched feature |
| `user_id` | TEXT | NOT NULL FK → users(id) ON DELETE CASCADE | Watching user |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | When user started watching |

**Constraints:** `PRIMARY KEY (feature_id, user_id)`
**Index:** `idx_feature_watchers_user`

#### `tasks`

Tasks are work units inside features. Every task belongs to exactly one feature. Tasks use a state machine for lifecycle but do NOT have board/column references — they inherit column position from their parent feature.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Task identifier (UUID) |
| `feature_id` | TEXT | NOT NULL FK → features(id) ON DELETE CASCADE | Parent feature |
| `title` | TEXT | NOT NULL | Task title |
| `description` | TEXT | NOT NULL DEFAULT '' | Detailed description |
| `priority` | TEXT | NOT NULL DEFAULT 'medium' CHECK (IN 'low','medium','high','critical') | Priority level |
| `assigned_agent_id` | TEXT | FK → agents(id) | Currently assigned agent |
| `required_domain` | TEXT | DEFAULT NULL | Required agent domain |
| `required_capabilities` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of strings |
| `status` | TEXT | NOT NULL DEFAULT 'pending' CHECK (IN 'pending','claimed','in_progress','submitted','approved','rejected','done','failed') | Task status |
| `claimed_at` | TEXT | DEFAULT NULL | When task was claimed |
| `started_at` | TEXT | DEFAULT NULL | When work started |
| `submitted_at` | TEXT | DEFAULT NULL | When submitted for review |
| `completed_at` | TEXT | DEFAULT NULL | When marked done |
| `rejected_count` | INTEGER | NOT NULL DEFAULT 0 | Times rejected |
| `rejection_reason` | TEXT | DEFAULT NULL | Last rejection reason |
| `result` | TEXT | DEFAULT NULL | Submission result text |
| `artifacts` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of artifact objects |
| `created_by` | TEXT | NOT NULL | Creator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |
| `version` | INTEGER | NOT NULL DEFAULT 1 | Optimistic locking version |
| `order` | INTEGER | NOT NULL DEFAULT 0 | Sort order within feature |
| `delegated_to_agent_id` | TEXT | FK → agents(id) | Agent task was delegated to |
| `estimated_minutes` | INTEGER | DEFAULT NULL | Estimated completion time |
| `retry_policy` | TEXT | JSON | Retry configuration |
| `retry_count` | INTEGER | NOT NULL DEFAULT 0 | Number of retries attempted |
| `next_retry_at` | TEXT | DEFAULT NULL | Next retry scheduled time |

**Indexes:** `idx_tasks_feature(feature_id)`, `idx_tasks_feature_order(feature_id, order)`, `idx_tasks_status`, `idx_tasks_assigned_agent`, `idx_tasks_required_domain`, `idx_tasks_priority`, `idx_tasks_delegated`

> **Note:** The `tasks` table contains only task-specific fields. Columns like `labels`, `depends_on`, `blocks`, `due_at`, `sla_minutes`, `sla_deadline_at` belong to the parent `features` table. Tasks derive their position from their parent feature's column.

#### `agents`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Agent identifier (UUID) |
| `name` | TEXT | NOT NULL UNIQUE | Display name |
| `type` | TEXT | NOT NULL CHECK (IN 'claude-code','codex','opencode') | Agent type |
| `domain` | TEXT | NOT NULL | Agent domain (e.g., `backend`) |
| `capabilities` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of capability strings |
| `status` | TEXT | NOT NULL DEFAULT 'idle' CHECK (IN 'idle','working','offline') | Agent status |
| `current_task_id` | TEXT | DEFAULT NULL | Currently assigned task |
| `api_key` | TEXT | NOT NULL UNIQUE | SHA-256 hash of the API key |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `last_heartbeat` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last heartbeat timestamp |
| `metadata` | TEXT | NOT NULL DEFAULT '{}' (JSON) | JSON object |
| `rate_limit_per_minute` | INTEGER | DEFAULT NULL | Per-agent rate limit override |

**Indexes:** `idx_agents_domain`, `idx_agents_status`, `idx_agents_current_task`

#### `task_events`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Event identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Related task |
| `actor_type` | TEXT | NOT NULL CHECK (IN 'human','agent','system') | Actor type |
| `actor_id` | TEXT | NOT NULL | UUID of the actor |
| `action` | TEXT | NOT NULL CHECK (IN 'created','claimed','started','submitted','approved','rejected','completed','failed','moved','released','dependency_resolved','updated','delegated','effort_logged','effort_corrected','cloned','retry_scheduled','retry_executed','escalated','code_evidence_linked','code_evidence_corrected','code_evidence_gap_reported','code_evidence_gap_resolved','code_evidence_marked_not_applicable','code_evidence_cleared_not_applicable') | Event action |
| `from_column_id` | TEXT | DEFAULT NULL | Source column |
| `to_column_id` | TEXT | DEFAULT NULL | Target column |
| `from_status` | TEXT | DEFAULT NULL | Previous status |
| `to_status` | TEXT | DEFAULT NULL | New status |
| `metadata` | TEXT | NOT NULL DEFAULT '{}' (JSON) | JSON blob with details |
| `timestamp` | TEXT | NOT NULL DEFAULT (datetime('now')) | Event timestamp |

**Indexes:** `idx_task_events_task_id`, `idx_task_events_timestamp(timestamp DESC)`, `idx_task_events_actor(actor_type, actor_id)`, `idx_task_events_from_column_time(from_column_id, timestamp)`, `idx_task_events_to_column_time(to_column_id, timestamp)`, `idx_task_events_transition_time(from_column_id, to_column_id, timestamp)`

#### `task_dependencies`

Within-feature sibling task dependencies only. Cross-feature dependencies use `feature_dependencies`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Dependent task |
| `depends_on_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Blocking task |

**Constraints:** `PRIMARY KEY (task_id, depends_on_id)`
**Indexes:** `idx_task_dependencies_depends_on`, `idx_task_dependencies_task_id`

#### `users`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | User identifier (UUID) |
| `username` | TEXT | NOT NULL UNIQUE | Login username |
| `password_hash` | TEXT | NOT NULL | bcrypt hash of password |
| `display_name` | TEXT | NOT NULL DEFAULT '' | Display name |
| `role` | TEXT | NOT NULL DEFAULT 'admin' CHECK (IN 'admin','editor','viewer') | User role |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |
| `last_login_at` | TEXT | DEFAULT NULL | Last successful login |
| `email` | TEXT | DEFAULT NULL | User email address |

**Index:** `idx_users_username`

#### `task_comments`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Comment identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Parent task |
| `parent_id` | TEXT | FK → task_comments(id) ON DELETE CASCADE | Parent comment for threading |
| `author_type` | TEXT | NOT NULL CHECK (IN 'human','agent') | Actor type |
| `author_id` | TEXT | NOT NULL | UUID of the author |
| `content` | TEXT | NOT NULL | Comment content (markdown) |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_comments_task_id(task_id, created_at)`, `idx_comments_parent`

#### `task_subtasks`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Subtask identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Parent task |
| `title` | TEXT | NOT NULL | Subtask title |
| `completed` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Completion status |
| `order` | INTEGER | NOT NULL DEFAULT 0 | Sort order |
| `assignee_id` | TEXT | FK → agents(id) | Assigned agent |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_subtasks_task_id(task_id, order)`, `idx_subtasks_assignee`

#### `task_watchers`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Watched task |
| `user_id` | TEXT | NOT NULL FK → users(id) ON DELETE CASCADE | Watching user |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | When user started watching |

**Constraints:** `PRIMARY KEY (task_id, user_id)`
**Index:** `idx_task_watchers_user_id`

#### `task_comment_mentions`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Mention identifier (UUID) |
| `comment_id` | TEXT | NOT NULL FK → task_comments(id) ON DELETE CASCADE | Source comment |
| `mentioned_type` | TEXT | NOT NULL CHECK (IN 'human','agent') | Type of mentioned entity |
| `mentioned_id` | TEXT | NOT NULL | UUID of mentioned entity |
| `mention_text` | TEXT | NOT NULL | The @mention text |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Indexes:** `idx_comment_mentions_comment_id`, `idx_comment_mentions_target(mentioned_type, mentioned_id)`
**Unique constraint:** `(comment_id, mentioned_type, mentioned_id, mention_text)`

#### `feature_templates`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Template identifier (UUID) |
| `board_id` | TEXT | FK → boards(id) ON DELETE CASCADE | Board-specific or NULL for global |
| `name` | TEXT | NOT NULL | Template display name |
| `title_pattern` | TEXT | NOT NULL DEFAULT '' | Prepended to task title |
| `description_pattern` | TEXT | NOT NULL DEFAULT '' | Markdown template for description |
| `priority` | TEXT | DEFAULT NULL | Default priority |
| `labels` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of label strings |
| `required_domain` | TEXT | DEFAULT NULL | Default required domain |
| `required_capabilities` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of capability strings |
| `is_default` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Default template shown first |
| `usage_count` | INTEGER | NOT NULL DEFAULT 0 | Times template was used |
| `tasks_template` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of child task definitions auto-created when template is applied |
| `created_by` | TEXT | NOT NULL | Creator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Indexes:** `idx_templates_board`, `idx_templates_default`

#### `saved_filters`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Filter identifier (UUID) |
| `board_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Board |
| `user_id` | TEXT | NOT NULL | User who saved this filter |
| `name` | TEXT | NOT NULL | Filter display name |
| `filter_config` | TEXT | NOT NULL (JSON) | Serialized filter criteria |
| `is_builtin` | INTEGER | DEFAULT 0 (boolean) | System-provided filter |
| `created_at` | TEXT | DEFAULT (datetime('now')) | Creation timestamp |

**Index:** (board_id)

#### `task_attachments`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Attachment identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Parent task |
| `filename` | TEXT | NOT NULL | Stored filename |
| `original_name` | TEXT | NOT NULL | Original upload filename |
| `mime_type` | TEXT | NOT NULL | MIME type |
| `size_bytes` | INTEGER | NOT NULL | File size |
| `uploaded_by` | TEXT | DEFAULT NULL | User or agent who uploaded |
| `created_at` | TEXT | DEFAULT (datetime('now')) | Creation timestamp |

**Index:** `idx_attachments_task_id`

#### `notification_preferences`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Preference identifier (UUID) |
| `user_id` | TEXT | NOT NULL | User |
| `board_id` | TEXT | FK → boards(id) ON DELETE CASCADE | Board (NULL = global) |
| `task_assigned` | INTEGER | NOT NULL DEFAULT 1 | Notify on task assignment |
| `task_submitted` | INTEGER | NOT NULL DEFAULT 1 | Notify on task submission |
| `task_approved` | INTEGER | NOT NULL DEFAULT 0 | Notify on approval |
| `task_rejected` | INTEGER | NOT NULL DEFAULT 1 | Notify on rejection |
| `task_overdue` | INTEGER | NOT NULL DEFAULT 1 | Notify on overdue |
| `task_mentioned` | INTEGER | NOT NULL DEFAULT 1 | Notify on mention |
| `task_watching` | INTEGER | NOT NULL DEFAULT 1 | Notify on watching updates |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Unique constraint:** `(user_id, board_id)`
**Index:** `idx_notif_prefs_user_board`

#### `chat_integrations`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Integration identifier (UUID) |
| `board_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Subscribed board |
| `provider` | TEXT | NOT NULL CHECK (IN 'slack','discord') | Chat provider |
| `webhook_url` | TEXT | NOT NULL | Webhook URL |
| `channel_id` | TEXT | DEFAULT NULL | Provider channel ID |
| `bot_token` | TEXT | DEFAULT NULL | Bot authentication token |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 | Active or paused |
| `events` | TEXT | NOT NULL DEFAULT '[]' (JSON) | Event types to send |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_chat_integrations_board`, `idx_chat_integrations_provider`, `idx_chat_integrations_enabled`

#### `webhook_subscriptions`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Subscription identifier (UUID) |
| `board_id` | TEXT | FK → boards(id) ON DELETE CASCADE | Subscribed board |
| `name` | TEXT | NOT NULL | Display name |
| `url` | TEXT | NOT NULL | Webhook target URL |
| `secret` | TEXT | DEFAULT NULL | Plain webhook secret (shown once at creation) |
| `events` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of event types |
| `headers` | TEXT | NOT NULL DEFAULT '{}' (JSON) | Custom HTTP headers JSON |
| `format` | TEXT | NOT NULL CHECK (IN 'standard','slack','discord') | Payload format |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 | Active or paused |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_webhook_subscriptions_board`, `idx_webhook_subscriptions_enabled`

#### `webhook_deliveries`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Delivery identifier (UUID) |
| `subscription_id` | TEXT | NOT NULL FK → webhook_subscriptions(id) ON DELETE CASCADE | Related subscription |
| `event_type` | TEXT | NOT NULL | Event that triggered delivery |
| `payload` | TEXT | NOT NULL | JSON payload sent |
| `status` | TEXT | NOT NULL CHECK (IN 'pending','success','failed') | Delivery status |
| `status_code` | INTEGER | DEFAULT NULL | HTTP response status code |
| `response_body` | TEXT | DEFAULT NULL | Truncated response body |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | Number of delivery attempts |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | First attempt timestamp |
| `last_attempt_at` | TEXT | DEFAULT NULL | Last attempt timestamp |
| `next_retry_at` | TEXT | DEFAULT NULL | Next retry scheduled time |

**Indexes:** `idx_webhook_deliveries_subscription`, `idx_webhook_deliveries_status`, `idx_webhook_deliveries_retry`

#### `agent_messages`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Message identifier (UUID) |
| `board_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Related board |
| `from_agent_id` | TEXT | NOT NULL FK → agents(id) ON DELETE CASCADE | Sending agent |
| `to_agent_id` | TEXT | NOT NULL FK → agents(id) ON DELETE CASCADE | Receiving agent |
| `task_id` | TEXT | FK → tasks(id) ON DELETE CASCADE | Related task (optional) |
| `subject` | TEXT | NOT NULL | Message subject |
| `body` | TEXT | NOT NULL | Message body |
| `message_type` | TEXT | NOT NULL DEFAULT 'info' CHECK (IN 'info','request','response','alert') | Message type |
| `priority` | TEXT | NOT NULL DEFAULT 'normal' CHECK (IN 'low','normal','high','urgent') | Priority |
| `read_at` | TEXT | DEFAULT NULL | When message was read |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Indexes:** `idx_agent_messages_to_agent`, `idx_agent_messages_from_agent`, `idx_agent_messages_board`, `idx_agent_messages_task`, `idx_agent_messages_read`

#### `pulses`

Structured signals for agent-to-agent and human-to-agent communication. Supports both mission-scoped and habitat-scoped (board-level) signals via the `scope` column. When `scope` is `"habitat"`, `mission_id` is NULL.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Pulse identifier (UUID) |
| `mission_id` | TEXT | FK → features(id) ON DELETE CASCADE | Mission scope (NULL when scope is `"habitat"`) |
| `board_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Board (habitat) |
| `scope` | TEXT | NOT NULL DEFAULT 'mission' CHECK (IN 'mission','habitat') | Signal scope |
| `from_type` | TEXT | NOT NULL CHECK (IN 'human','agent','system') | Author type |
| `from_id` | TEXT | NOT NULL | Author identifier (user.id, agent.id, or 'system') |
| `to_type` | TEXT | CHECK (IN 'human','agent') | Target type (NULL = broadcast) |
| `to_id` | TEXT | | Target identifier (NULL = broadcast) |
| `signal_type` | TEXT | NOT NULL CHECK (IN 9 types) | finding, blocker, offer, warning, question, answer, directive, context, handoff |
| `subject` | TEXT | NOT NULL | Brief signal subject |
| `body` | TEXT | NOT NULL DEFAULT '' | Full signal body |
| `task_id` | TEXT | FK → tasks(id) ON DELETE SET NULL | Related task |
| `reply_to_id` | TEXT | | Parent pulse for threaded replies (self-ref, no FK) |
| `linked_task_id` | TEXT | FK → tasks(id) ON DELETE SET NULL | Auto-created blocker clearance task |
| `metadata` | TEXT | NOT NULL DEFAULT '{}' | Freeform JSON metadata |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `pinned` | INTEGER | NOT NULL DEFAULT 0 | Pinned signals |
| `is_auto` | INTEGER | NOT NULL DEFAULT 0 | System-generated (1) vs intentional (0) |

**Indexes:** `idx_pulses_mission`, `idx_pulses_board`, `idx_pulses_signal_type`, `idx_pulses_from`, `idx_pulses_to`, `idx_pulses_task`, `idx_pulses_created`, `idx_pulses_reply_to`, `idx_pulses_scope`

**Deep Linking:**

```
Pulse ──mission_id──→ Feature (Mission) [nullable in V2]
      ──board_id────→ Board (Habitat)
      ──task_id─────→ Task (source)
      ──linked_task_id → Task (blocker clearance)
      ──reply_to_id───→ Pulse (thread parent)
```

#### `pulse_cursors`

Lightweight read-tracking: one row per reader per scope (mission or habitat) storing the last-checked timestamp. Uses `scope_key` (mission UUID or board UUID) with a `scope` column instead of a direct `mission_id` FK.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `scope_key` | TEXT | NOT NULL | Mission UUID or board UUID |
| `scope` | TEXT | NOT NULL DEFAULT 'mission' CHECK (IN 'mission','habitat') | Scope type |
| `reader_type` | TEXT | NOT NULL CHECK (IN 'human','agent') | Reader type |
| `reader_id` | TEXT | NOT NULL | Reader identifier |
| `last_checked_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last check timestamp |

**Primary Key:** `(scope_key, scope, reader_type, reader_id)`

#### `project_insights`

Institutional memory for a habitat. Insights are promoted from high-value pulse signals or created manually. Persist across missions and are surfaced in mission context via tag-based relevance matching.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Insight identifier (UUID) |
| `board_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Habitat (board) |
| `title` | TEXT | NOT NULL | Insight title |
| `body` | TEXT | NOT NULL DEFAULT '' | Full insight body |
| `source` | TEXT | NOT NULL DEFAULT 'manual' CHECK (IN 'signal','manual','auto') | How the insight was created |
| `source_pulse_id` | TEXT | FK → pulses(id) ON DELETE SET NULL | Originating pulse signal (if promoted) |
| `relevance_tags` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of tag strings for relevance matching |
| `created_by` | TEXT | NOT NULL | Creator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_insights_board`, `idx_insights_source_pulse`

#### `pulse_reactions`

Toggle-based reactions on pulse signals. Three fixed reaction types. Reactions are toggled — posting the same reaction again removes it.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Reaction identifier (UUID) |
| `pulse_id` | TEXT | NOT NULL FK → pulses(id) ON DELETE CASCADE | Target signal |
| `reactor_type` | TEXT | NOT NULL CHECK (IN 'human','agent') | Reactor type |
| `reactor_id` | TEXT | NOT NULL | Reactor identifier |
| `reaction` | TEXT | NOT NULL CHECK (IN 'seen','ack','question') | Reaction type |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Unique constraint:** `(pulse_id, reactor_type, reactor_id, reaction)`
**Indexes:** `idx_pulse_reactions_pulse`

#### `organizations`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Organization identifier (UUID) |
| `name` | TEXT | NOT NULL | Organization name |
| `slug` | TEXT | NOT NULL UNIQUE | URL-safe identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Index:** `idx_organizations_slug`

#### `teams`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Team identifier (UUID) |
| `organization_id` | TEXT | NOT NULL FK → organizations(id) ON DELETE CASCADE | Parent organization |
| `name` | TEXT | NOT NULL | Team name |
| `slug` | TEXT | NOT NULL UNIQUE | URL-safe identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Indexes:** `idx_teams_organization_id`, `idx_teams_slug`

#### `team_members`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Membership identifier (UUID) |
| `team_id` | TEXT | NOT NULL FK → teams(id) ON DELETE CASCADE | Team |
| `user_id` | TEXT | NOT NULL FK → users(id) ON DELETE CASCADE | User |
| `role` | TEXT | NOT NULL DEFAULT 'member' CHECK (IN 'owner','admin','member') | Member role |
| `joined_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Join timestamp |

**Constraints:** `PRIMARY KEY (team_id, user_id)`
**Indexes:** `idx_team_members_team_id`, `idx_team_members_user_id`

#### `pull_requests`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | PR identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Linked task |
| `provider` | TEXT | NOT NULL CHECK (IN 'github','gitlab') | Repository provider |
| `repo` | TEXT | NOT NULL | Repository full name |
| `pr_number` | INTEGER | NOT NULL | Pull request number |
| `pr_title` | TEXT | DEFAULT NULL | PR title |
| `pr_url` | TEXT | NOT NULL | PR URL |
| `branch_name` | TEXT | DEFAULT NULL | Branch name |
| `state` | TEXT | DEFAULT 'open' | PR state |
| `review_status` | TEXT | DEFAULT 'pending' | Review status |
| `branch_id` | TEXT | FK → code_branches(id) | Linked code evidence branch |
| `repository_id` | TEXT | FK → habitat_code_repositories(id) | Linked code repository |
| `created_at` | TEXT | DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | DEFAULT (datetime('now')) | Last update timestamp |

#### `pipeline_events`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Event identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Linked task |
| `provider` | TEXT | NOT NULL CHECK (IN 'github','gitlab') | CI/CD provider |
| `repo` | TEXT | NOT NULL | Repository full name |
| `run_id` | TEXT | NOT NULL | Pipeline run ID |
| `status` | TEXT | NOT NULL CHECK (IN 'queued','in_progress','success','failure','cancelled') | Run status |
| `branch` | TEXT | NOT NULL | Branch name |
| `commit_sha` | TEXT | DEFAULT NULL | Commit SHA |
| `commit_id` | TEXT | FK → code_commits(id) | Linked code evidence commit |
| `branch_id` | TEXT | FK → code_branches(id) | Linked code evidence branch |
| `created_at` | TEXT | DEFAULT (datetime('now')) | Creation timestamp |

#### `cumulative_flow_snapshots`

Daily cumulative-flow snapshot rows for chart reads. Stored snapshots are authoritative; services may project the current day from live state when no snapshot exists and mark older missing history as partial.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Snapshot identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Habitat being measured |
| `snapshot_date` | TEXT | NOT NULL | Snapshot date (`YYYY-MM-DD`) |
| `counts_by_column` | TEXT | NOT NULL DEFAULT '{}' (JSON) | Mission/task counts keyed by column id/name |
| `counts_by_status` | TEXT | NOT NULL DEFAULT '{}' (JSON) | Counts keyed by lifecycle status |
| `source` | TEXT | NOT NULL DEFAULT 'generated' CHECK (IN 'generated','backfilled','current_state') | Snapshot origin |
| `completeness` | TEXT | NOT NULL DEFAULT 'complete' CHECK (IN 'complete','partial') | Whether the point is complete or caveated |
| `warnings` | TEXT | NOT NULL DEFAULT '[]' (JSON) | Warning objects with code, message, and severity |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Unique index:** `idx_cumulative_flow_snapshot_unique(habitat_id, snapshot_date)`
**Index:** `idx_cumulative_flow_snapshots_habitat_date(habitat_id, snapshot_date)`

#### `task_time_records`

Heartbeat-based time tracking records. Each record captures a work interval for a task.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Record identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Parent task |
| `agent_id` | TEXT | FK → agents(id) ON DELETE SET NULL | Agent that recorded the work |
| `minutes_spent` | INTEGER | NOT NULL | Minutes of work recorded |
| `recorded_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | When the record was created |
| `status_during_work` | TEXT | NOT NULL | Task status during the work interval |

**Indexes:** `idx_time_records_task(task_id)`, `idx_time_records_agent(agent_id)`

#### `effort_entries`

Explicit effort logging entries for tasks. Unlike heartbeat-inferred `task_time_records`, these capture deliberate time reports from humans and agents. Supports corrections via delta entries that reference the original entry (`corrects_entry_id`). Entries are append-only — never edited or deleted.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Entry identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Parent task |
| `actor_type` | TEXT | NOT NULL | Actor type: `human`, `agent`, or `system` |
| `actor_id` | TEXT | DEFAULT NULL | UUID of the actor |
| `minutes` | INTEGER | NOT NULL | Minutes logged (positive for reports, can be negative for corrections) |
| `source` | TEXT | NOT NULL | Entry source: `human_manual`, `agent_reported`, or `correction_adjustment` |
| `note` | TEXT | DEFAULT NULL | Free-text description of the work |
| `started_at` | TEXT | DEFAULT NULL | ISO 8601 datetime when work started |
| `ended_at` | TEXT | DEFAULT NULL | ISO 8601 datetime when work ended |
| `recorded_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | When the entry was created |
| `corrects_entry_id` | TEXT | DEFAULT NULL | If this is a correction, the entry UUID it corrects |
| `correction_reason` | TEXT | DEFAULT NULL | Machine-readable or free-text correction reason |
| `metadata` | TEXT | DEFAULT NULL | Additional JSON metadata |

**Indexes:** `idx_effort_entries_task(task_id)`, `idx_effort_entries_actor(actor_type, actor_id)`, `idx_effort_entries_source(source)`, `idx_effort_entries_corrects(corrects_entry_id)`

#### `quality_checklist_templates`

Reusable quality gate template definitions. Templates define categories of checklists (e.g., code review, security).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Template identifier (UUID) |
| `name` | TEXT | NOT NULL | Template name |
| `description` | TEXT | NOT NULL DEFAULT '' | Template description |
| `category` | TEXT | NOT NULL | Category grouping (e.g., `code_quality`, `security`) |
| `is_required` | INTEGER | NOT NULL DEFAULT 1 (boolean) | Whether this checklist is required for approval |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Index:** `idx_quality_templates_category(category)`

#### `quality_checklist_items`

Individual items within a quality checklist template.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Item identifier (UUID) |
| `template_id` | TEXT | NOT NULL FK → quality_checklist_templates(id) ON DELETE CASCADE | Parent template |
| `title` | TEXT | NOT NULL | Item title |
| `description` | TEXT | NOT NULL DEFAULT '' | Item description |
| `required` | INTEGER | NOT NULL DEFAULT 1 (boolean) | Whether this item must be completed |
| `order_index` | INTEGER | NOT NULL | Sort order within template |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Index:** `idx_quality_items_template(template_id)`

#### `task_quality_checklists`

Per-task checklist instances created from templates.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Checklist instance identifier (UUID) |
| `task_id` | TEXT | NOT NULL FK → tasks(id) ON DELETE CASCADE | Parent task |
| `template_id` | TEXT | FK → quality_checklist_templates(id) ON DELETE SET NULL | Source template |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | Checklist status (pending, complete) |
| `completed_at` | TEXT | DEFAULT NULL | When all items were completed |
| `completed_by` | TEXT | DEFAULT NULL | Who completed the final item |
| `notes` | TEXT | NOT NULL DEFAULT '' | Free-text notes |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |

**Index:** `idx_task_quality_checklists_task(task_id)`

#### `task_quality_checklist_items`

Per-task completion status of individual checklist items.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Item instance identifier (UUID) |
| `checklist_id` | TEXT | NOT NULL FK → task_quality_checklists(id) ON DELETE CASCADE | Parent checklist |
| `item_id` | TEXT | NOT NULL FK → quality_checklist_items(id) ON DELETE CASCADE | Template item reference |
| `is_completed` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Whether the item is completed |
| `completed_by` | TEXT | DEFAULT NULL | Who completed the item |
| `completed_at` | TEXT | DEFAULT NULL | When the item was completed |
| `evidence_url` | TEXT | DEFAULT NULL | Link to evidence (CI run, PR, etc.) |
| `notes` | TEXT | NOT NULL DEFAULT '' | Free-text notes |

**Index:** `idx_task_quality_items_checklist(checklist_id)`

#### `scheduled_tasks`

Recurring scheduled creation of features and tasks from templates. Supports cron expressions, fixed intervals, and one-time schedules.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Scheduled task identifier (UUID) |
| `board_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent board |
| `template_id` | TEXT | FK → feature_templates(id) ON DELETE SET NULL | Feature template reference (nullable) |
| `name` | TEXT | NOT NULL | Schedule display name |
| `description` | TEXT | NOT NULL DEFAULT '' | Schedule description |
| `schedule_type` | TEXT | NOT NULL CHECK (IN 'once','interval','cron') | Schedule type |
| `cron_expression` | TEXT | DEFAULT NULL | Cron expression (when schedule_type is `cron`) |
| `interval_minutes` | INTEGER | DEFAULT NULL | Interval in minutes (when schedule_type is `interval`) |
| `scheduled_at` | TEXT | DEFAULT NULL | One-time run time (when schedule_type is `once`) |
| `timezone` | TEXT | NOT NULL DEFAULT 'UTC' | Timezone for schedule evaluation |
| `feature_title` | TEXT | NOT NULL | Title for created features |
| `feature_description` | TEXT | NOT NULL DEFAULT '' | Description for created features |
| `feature_priority` | TEXT | NOT NULL DEFAULT 'medium' CHECK (IN 'low','medium','high','critical') | Priority for created features |
| `feature_labels` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of label strings |
| `feature_domain` | TEXT | DEFAULT NULL | Domain for created features |
| `tasks_template` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of child task definitions |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 (boolean) | Whether schedule is active |
| `last_run_at` | TEXT | DEFAULT NULL | Last execution timestamp |
| `next_run_at` | TEXT | NOT NULL | Next scheduled execution |
| `run_count` | INTEGER | NOT NULL DEFAULT 0 | Total executions |
| `last_created_feature_id` | TEXT | DEFAULT NULL | UUID of last created feature |
| `created_by` | TEXT | NOT NULL | Creator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_scheduled_tasks_board(board_id)`, `idx_scheduled_tasks_next(next_run_at)`, `idx_scheduled_tasks_enabled(enabled)`

#### `daemon_instances`

Tracks autonomous daemon runtimes, including both standalone CLI daemons and API in-process daemon engines.

#### `habitat_skills`

Living skill document for each habitat. Auto-generated from high-strength signals — one row per habitat. Content is a markdown document synthesizing promoted signals.

**Source:** `packages/api/src/db/schema/habitat-skill.ts`
**Migration:** `0015_habitat_skill.sql`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Skill document identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL UNIQUE FK → habitats(id) ON DELETE CASCADE | Parent habitat (one skill per habitat) |
| `content` | TEXT | NOT NULL DEFAULT '' | Generated markdown skill document |
| `signal_count` | INTEGER | NOT NULL DEFAULT 0 | Number of signals used in last generation |
| `avg_strength` | REAL | NOT NULL DEFAULT 0 | Average signal strength of promoted signals |
| `last_generated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last document generation timestamp |
| `generation_count` | INTEGER | NOT NULL DEFAULT 1 | Number of times the document has been regenerated |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Index:** `idx_habitat_skills_habitat(habitat_id)`

#### `habitat_skill_signals`

Individual knowledge signals clustered by topic. Signals are ingested from pulse signals, task outcomes, and comments. Each signal is scored for strength and classified into a skill category.

**Source:** `packages/api/src/db/schema/habitat-skill.ts`
**Migration:** `0015_habitat_skill.sql`, `0016_habitat_skill_unique.sql`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Signal identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Parent habitat |
| `cluster_key` | TEXT | NOT NULL | Normalized topic key for clustering (e.g., "auth-jwt-signing") |
| `skill_category` | TEXT | NOT NULL | Category: `domain_knowledge`, `convention`, `pattern`, or `anti_pattern` |
| `source_signal_type` | TEXT | NOT NULL | Origin: `pulse`, `task_event`, `task_comment` |
| `source_type` | TEXT | NOT NULL DEFAULT 'pulse' | Signal type from pulse (finding, blocker, etc.) |
| `subject` | TEXT | NOT NULL | Brief subject line |
| `summary` | TEXT | DEFAULT NULL | Optional longer summary |
| `strength` | REAL | NOT NULL DEFAULT 0.1 | Composite score 0-1 (frequency + corroboration + cross-mission + outcome) |
| `frequency` | INTEGER | NOT NULL DEFAULT 1 | Number of times this cluster has been seen |
| `corroborating_agents` | INTEGER | NOT NULL DEFAULT 1 | Number of distinct agents confirming this signal |
| `cross_mission_count` | INTEGER | NOT NULL DEFAULT 0 | Number of distinct missions this signal spans |
| `successful_tasks` | INTEGER | NOT NULL DEFAULT 0 | Associated successful task completions |
| `failed_tasks` | INTEGER | NOT NULL DEFAULT 0 | Associated task failures |
| `last_seen_at` | TEXT | NOT NULL | Most recent observation |
| `first_seen_at` | TEXT | NOT NULL | First observation |
| `source_pulse_ids` | TEXT | DEFAULT NULL (JSON) | JSON array of source pulse UUIDs |
| `source_task_ids` | TEXT | DEFAULT NULL (JSON) | JSON array of source task UUIDs |
| `source_comment_ids` | TEXT | DEFAULT NULL (JSON) | JSON array of source comment UUIDs |
| `corroborating_agent_ids` | TEXT | DEFAULT NULL (JSON) | JSON array of agent UUIDs |
| `promoted_to_skill` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Whether this signal has been promoted into the skill document |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Unique index:** `idx_hskill_signals_habitat_cluster_unique(habitat_id, cluster_key)` — one signal per habitat per cluster
**Indexes:** `idx_hskill_signals_habitat(habitat_id)`, `idx_hskill_signals_cluster(cluster_key)`, `idx_hskill_signals_category(skill_category)`, `idx_hskill_signals_strength(strength)`, `idx_hskill_signals_promoted(promoted_to_skill)`, `idx_hskill_signals_habitat_cluster(habitat_id, cluster_key)`, `idx_hskill_signals_habitat_cat_promoted(habitat_id, skill_category, promoted_to_skill)`

| Column | Type | Description |
|--------|------|-------------|
| `id` | text PK | Daemon instance ID |
| `name` | text | Human-readable daemon name |
| `hostname` | text | Host where the daemon was registered |
| `token_hash` | text | SHA-256 hash of daemon token; plain token is shown once |
| `max_concurrent` | integer | Maximum concurrent spawned sessions |
| `daemon_version` | text | Daemon/runtime version (`in-process` for UI engine) |
| `last_heartbeat_at` | text nullable | Last daemon heartbeat timestamp |
| `status` | text | `online`, `offline`, or `draining` |
| `metadata` | json | Runtime metadata such as registered habitat IDs |
| `created_at`, `updated_at` | text | Timestamps |

#### `daemon_agents`

Maps daemon-owned agent records to detected AI CLI binaries.

| Column | Type | Description |
|--------|------|-------------|
| `id` | text PK | Mapping ID |
| `daemon_id` | text FK | Parent daemon instance |
| `agent_id` | text FK | Orcy agent identity created for this CLI |
| `cli_type` | text | `claude-code`, `codex`, `opencode`, `cursor`, or `gemini` |
| `cli_version` | text nullable | Detected CLI version |
| `cli_path` | text | Resolved binary path |
| `status` | text | `idle`, `working`, or `offline` |
| `last_seen_at`, `created_at`, `updated_at` | text | Timestamps |

#### `daemon_sessions`

Tracks spawned CLI sessions for claimed tasks.

| Column | Type | Description |
|--------|------|-------------|
| `id` | text PK | Session ID returned as `daemonSessionId` from claim-next |
| `daemon_id` | text FK | Owning daemon |
| `agent_id` | text FK | Daemon-owned agent executing the task |
| `task_id` | text FK | Claimed task |
| `habitat_id` | text FK | Habitat scope |
| `pid` | integer nullable | Local process ID when running on this host |
| `cli_session_id` | text nullable | Native CLI resume/session token if supported |
| `workdir` | text | Prepared worktree path, initially `pending` until spawn |
| `status` | text | `starting`, `running`, `completed`, `failed`, `released`, or `lost` |
| `last_progress` | text nullable | Redacted progress/output summary |
| `started_at`, `ended_at`, `updated_at` | text | Timestamps |

#### `integration_connections`

Integration connections to external providers (GitHub, Jira, Linear). Each connection is scoped to one habitat. Token and secret values are stored locally — API responses use `toView()` to replace them with boolean presence indicators. Disabled connections are preserved (soft delete) to retain external issue link provenance.

**Source:** `packages/api/src/db/schema/integration.ts`
**Migration:** `0013_integrations.sql`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Connection identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Parent habitat |
| `provider` | TEXT | NOT NULL CHECK (IN 'github','jira','linear') | Provider type |
| `name` | TEXT | NOT NULL | User-facing connection name |
| `auth_method` | TEXT | NOT NULL | Auth method: 'oauth_device', 'oauth_code', 'pat', 'api_key', etc. |
| `access_token` | TEXT | DEFAULT NULL | Stored OAuth access token or PAT (not returned in API) |
| `refresh_token` | TEXT | DEFAULT NULL | OAuth refresh token (not returned in API) |
| `token_expires_at` | TEXT | DEFAULT NULL | OAuth token expiry timestamp |
| `external_account_id` | TEXT | DEFAULT NULL | Provider-side account/user ID |
| `external_account_name` | TEXT | DEFAULT NULL | Provider-side account/user login/name |
| `external_tenant_id` | TEXT | DEFAULT NULL | Jira cloud-id, Linear workspace, etc. |
| `external_tenant_name` | TEXT | DEFAULT NULL | Human-readable tenant name |
| `external_base_url` | TEXT | DEFAULT NULL | Provider API base URL (null = default) |
| `repository_owner` | TEXT | DEFAULT NULL | GitHub repository owner |
| `repository_name` | TEXT | DEFAULT NULL | GitHub repository name |
| `project_key` | TEXT | DEFAULT NULL | Jira project key |
| `team_id` | TEXT | DEFAULT NULL | Linear team identifier |
| `provider_config` | TEXT | NOT NULL DEFAULT '{}' (JSON) | Provider-specific configuration |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 (boolean) | Whether connection is active |
| `pull_enabled` | INTEGER | NOT NULL DEFAULT 1 (boolean) | Whether pull sync is enabled |
| `auto_import` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Auto-import new issues as missions |
| `webhook_secret` | TEXT | DEFAULT NULL | HMAC secret for webhook verification (not returned in API) |
| `webhook_external_id` | TEXT | DEFAULT NULL | Provider-side webhook ID for lifecycle management |
| `last_sync_at` | TEXT | DEFAULT NULL | Last successful sync timestamp |
| `last_sync_status` | TEXT | NOT NULL DEFAULT 'never' | Last sync result: 'never', 'running', 'success', 'partial', 'failed' |
| `last_sync_error` | TEXT | DEFAULT NULL | Last sync error message |
| `created_by` | TEXT | NOT NULL | Creator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_integration_connections_provider(provider)`, `idx_integration_connections_habitat(habitat_id)`, `idx_integration_connections_provider_repo(provider, repository_owner, repository_name)`

**Deletion/retention:** Disabled via `enabled = 0` rather than hard-deleted. External issue links referencing the connection are preserved for mission provenance.

#### `external_issue_links`

Durable mapping between an external issue and an Orcy mission. This is the idempotency key — sync checks for existing links before creating missions. Tracks sync status and per-link warnings.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Link identifier (UUID) |
| `connection_id` | TEXT | NOT NULL FK → integration_connections(id) ON DELETE CASCADE | Parent connection |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Parent habitat |
| `mission_id` | TEXT | NOT NULL FK → features(id) ON DELETE CASCADE | Linked Orcy mission |
| `provider` | TEXT | NOT NULL | Provider type |
| `external_id` | TEXT | NOT NULL | Stable provider ID |
| `external_key` | TEXT | NOT NULL | Human-readable issue key (e.g. 'owner/repo#42') |
| `external_url` | TEXT | NOT NULL | Browser URL to external issue |
| `external_status` | TEXT | NOT NULL | Normalized status: 'open' or 'closed' |
| `external_updated_at` | TEXT | DEFAULT NULL | Provider-side last update timestamp |
| `provider_labels` | TEXT | NOT NULL DEFAULT '[]' (JSON) | JSON array of last-known provider labels |
| `last_synced_at` | TEXT | DEFAULT NULL | Last sync timestamp for this link |
| `sync_status` | TEXT | NOT NULL DEFAULT 'synced' | Link health: 'synced', 'warning', 'failed' |
| `sync_warning` | TEXT | DEFAULT NULL | Sync warning message (e.g. external closed while tasks active) |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Unique indexes:** `idx_external_issue_links_connection_issue(connection_id, external_id)` — guarantees one link per connection/external-issue pair.
**Additional indexes:** `idx_external_issue_links_mission(mission_id)`

#### `external_intake_candidates`

Reviewable source items that may become missions after human/orcy clarification. Used primarily for Jira/Linear where ticket semantics are too variable for automatic mission creation. GitHub can use direct import as a setup-controlled fast path.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Candidate identifier (UUID) |
| `connection_id` | TEXT | NOT NULL FK → integration_connections(id) ON DELETE CASCADE | Parent connection |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Parent habitat |
| `provider` | TEXT | NOT NULL | Provider type |
| `external_id` | TEXT | NOT NULL | Stable provider ID |
| `external_key` | TEXT | NOT NULL | Human-readable issue key |
| `external_url` | TEXT | NOT NULL | Browser URL |
| `source_kind` | TEXT | DEFAULT NULL | Provider-specific type (issue type, etc.) |
| `source_status` | TEXT | DEFAULT NULL | Original external status |
| `source_priority` | TEXT | DEFAULT NULL | Original external priority |
| `source_assignees` | TEXT | NOT NULL DEFAULT '[]' (JSON) | Original assignees |
| `source_reporter` | TEXT | DEFAULT NULL | Original reporter/creator |
| `source_labels` | TEXT | NOT NULL DEFAULT '[]' (JSON) | Original labels |
| `source_title` | TEXT | NOT NULL | Original issue title |
| `source_body` | TEXT | DEFAULT NULL | Original issue body/description |
| `normalized_summary` | TEXT | DEFAULT NULL | Human/orcy clarified summary |
| `recommended_mission_title` | TEXT | DEFAULT NULL | Suggested mission title |
| `recommended_mission_description` | TEXT | DEFAULT NULL | Suggested mission description |
| `review_status` | TEXT | NOT NULL DEFAULT 'new' | Review state: 'new', 'needs_clarification', 'ready', 'promoted', 'ignored' |
| `promoted_mission_id` | TEXT | DEFAULT NULL FK → features(id) | Mission created from this candidate |
| `raw_provider_payload` | TEXT | DEFAULT NULL (JSON) | Original provider payload for debugging/future refinement |
| `external_updated_at` | TEXT | DEFAULT NULL | Provider-side last update |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_external_intake_candidates_connection(connection_id)`, `idx_external_intake_candidates_review(review_status)`

#### `integration_sync_runs`

Record of each sync attempt. Used for user-facing status, debugging, and future retry behavior.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Sync run identifier (UUID) |
| `connection_id` | TEXT | NOT NULL FK → integration_connections(id) ON DELETE CASCADE | Parent connection |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Parent habitat |
| `trigger` | TEXT | NOT NULL | What triggered the sync: 'manual', 'webhook', 'scheduled', 'oauth_complete' |
| `status` | TEXT | NOT NULL DEFAULT 'running' | Run status: 'running', 'success', 'partial', 'failed' |
| `started_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Run start timestamp |
| `finished_at` | TEXT | DEFAULT NULL | Run completion timestamp |
| `created_count` | INTEGER | NOT NULL DEFAULT 0 | Missions created |
| `updated_count` | INTEGER | NOT NULL DEFAULT 0 | Missions updated |
| `skipped_count` | INTEGER | NOT NULL DEFAULT 0 | Issues skipped (already synced, etc.) |
| `failed_count` | INTEGER | NOT NULL DEFAULT 0 | Issues that failed to sync |
| `error` | TEXT | DEFAULT NULL | Error summary if status is 'failed' |

**Indexes:** `idx_integration_sync_runs_connection(connection_id)`, `idx_integration_sync_runs_started(started_at DESC)`

#### `habitat_code_repositories`

One row per habitat establishing canonical repository identity. Provides the anchor point for all code evidence within a habitat.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Repository record identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL UNIQUE FK → boards(id) ON DELETE CASCADE | Parent habitat (1:1) |
| `provider` | TEXT | NOT NULL CHECK (IN 'github','gitlab') | Git provider |
| `repo_slug` | TEXT | NOT NULL | Canonical repository identifier (e.g., `owner/repo`) |
| `verification_state` | TEXT | NOT NULL DEFAULT 'unverified' CHECK (IN 'unverified','verified','failed') | Whether the repository connection has been verified |
| `verified_at` | TEXT | DEFAULT NULL | Last successful verification timestamp |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_code_repos_habitat(habitat_id)`, `idx_code_repos_provider_slug(provider, repo_slug)`

#### `code_branches`

Branch evidence records. Each branch is scoped to a repository and optionally linked to the task that created it.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Branch identifier (UUID) |
| `repository_id` | TEXT | NOT NULL FK → habitat_code_repositories(id) ON DELETE CASCADE | Parent repository |
| `name` | TEXT | NOT NULL | Branch name |
| `head_sha` | TEXT | DEFAULT NULL | Current HEAD commit SHA |
| `base_branch` | TEXT | DEFAULT NULL | Target/base branch name |
| `created_from_task_id` | TEXT | FK → tasks(id) ON DELETE SET NULL | Task that triggered branch creation |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_code_branches_repo(repository_id)`, `idx_code_branches_name(repository_id, name)`, `idx_code_branches_task(created_from_task_id)`

#### `code_commits`

Commit evidence records. Stores normalized commit metadata extracted from provider URLs or webhooks.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Commit record identifier (UUID) |
| `repository_id` | TEXT | NOT NULL FK → habitat_code_repositories(id) ON DELETE CASCADE | Parent repository |
| `sha` | TEXT | NOT NULL | Full commit SHA |
| `message` | TEXT | DEFAULT NULL | Commit message |
| `author_name` | TEXT | DEFAULT NULL | Commit author name |
| `author_email` | TEXT | DEFAULT NULL | Commit author email |
| `verification_state` | TEXT | NOT NULL DEFAULT 'unverified' CHECK (IN 'unverified','verified','failed') | Commit signature verification state |
| `committed_at` | TEXT | DEFAULT NULL | Commit timestamp |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

**Indexes:** `idx_code_commits_repo(repository_id)`, `idx_code_commits_sha(repository_id, sha)`

#### `code_changed_files`

Changed file snapshots per commit. Tracks file-level diff metadata.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | File change identifier (UUID) |
| `commit_id` | TEXT | NOT NULL FK → code_commits(id) ON DELETE CASCADE | Parent commit |
| `path` | TEXT | NOT NULL | File path after change |
| `previous_path` | TEXT | DEFAULT NULL | Original path (for renames) |
| `change_type` | TEXT | NOT NULL CHECK (IN 'added','modified','deleted','renamed') | Type of change |
| `additions` | INTEGER | DEFAULT NULL | Lines added |
| `deletions` | INTEGER | DEFAULT NULL | Lines deleted |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

**Indexes:** `idx_code_changed_files_commit(commit_id)`, `idx_code_changed_files_path(path)`

#### `code_reviews`

Review evidence records. Captures review status and reviewer metadata.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Review record identifier (UUID) |
| `repository_id` | TEXT | NOT NULL FK → habitat_code_repositories(id) ON DELETE CASCADE | Parent repository |
| `review_type` | TEXT | NOT NULL CHECK (IN 'pr_review','mr_review') | Review type |
| `external_id` | TEXT | DEFAULT NULL | Provider-side review identifier |
| `review_status` | TEXT | NOT NULL CHECK (IN 'pending','approved','changes_requested','dismissed') | Review status |
| `reviewer_name` | TEXT | DEFAULT NULL | Reviewer display name |
| `reviewed_at` | TEXT | DEFAULT NULL | Review timestamp |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_code_reviews_repo(repository_id)`, `idx_code_reviews_external(repository_id, external_id)`

#### `code_evidence_links`

Core polymorphic link table connecting Orcy entities (missions, tasks, subtasks) to code evidence records (branches, commits, changed files, reviews). Uses append-only corrections — links are never deleted, only superseded.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Link identifier (UUID) |
| `target_type` | TEXT | NOT NULL CHECK (IN 'mission','task','subtask') | Polymorphic target type |
| `target_id` | TEXT | NOT NULL | Target entity UUID |
| `evidence_type` | TEXT | NOT NULL CHECK (IN 'branch','commit','changed_file','review','pr','pipeline') | Evidence entity type |
| `evidence_id` | TEXT | NOT NULL | Evidence entity UUID |
| `status` | TEXT | NOT NULL DEFAULT 'active' CHECK (IN 'active','superseded','incorrect','removed') | Link status (append-only corrections) |
| `confidence` | REAL | NOT NULL DEFAULT 1.0 | Confidence score 0-1 |
| `link_source` | TEXT | NOT NULL CHECK (IN 'webhook','branch_pattern','commit_trailer','agent_reported','human_manual','migration','api','artifact_mirror') | How the link was established |
| `corrected_by` | TEXT | DEFAULT NULL FK → code_evidence_links(id) | Superseding link (for corrections) |
| `correction_reason` | TEXT | DEFAULT NULL | Why this link was corrected |
| `corrected_by_actor` | TEXT | DEFAULT NULL | Who corrected the link |
| `metadata` | TEXT | NOT NULL DEFAULT '{}' (JSON) | Additional link context |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_code_evidence_links_target(target_type, target_id)`, `idx_code_evidence_links_evidence(evidence_type, evidence_id)`, `idx_code_evidence_links_status(status)`, `idx_code_evidence_links_source(link_source)`

#### `code_evidence_completeness`

Per-target completeness overrides and derived status. Stores `not_applicable` overrides and the computed completeness state for each target.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Completeness record identifier (UUID) |
| `target_type` | TEXT | NOT NULL CHECK (IN 'mission','task','subtask') | Polymorphic target type |
| `target_id` | TEXT | NOT NULL | Target entity UUID |
| `status` | TEXT | NOT NULL CHECK (IN 'complete','partial','missing','not_applicable','unknown') | Derived completeness status |
| `reason_code` | TEXT | DEFAULT NULL | Machine-readable reason for the status |
| `reason_detail` | TEXT | DEFAULT NULL | Human-readable explanation |
| `evaluated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last evaluation timestamp |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Unique index:** `idx_code_evidence_completeness_target(target_type, target_id)`

#### `code_evidence_gaps`

Gap lifecycle tracking. Records identified evidence gaps (missing branches, commits, reviews) and their resolution state.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Gap identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `target_type` | TEXT | NOT NULL CHECK (IN 'mission','task','subtask') | Polymorphic target type |
| `target_id` | TEXT | NOT NULL | Target entity UUID |
| `gap_type` | TEXT | NOT NULL CHECK (IN 'missing_branch','missing_commit','missing_review','missing_pipeline','incomplete_evidence') | Category of the gap |
| `reason_code` | TEXT | NOT NULL | Machine-readable gap reason |
| `reason_detail` | TEXT | DEFAULT NULL | Human-readable gap description |
| `status` | TEXT | NOT NULL DEFAULT 'active' CHECK (IN 'active','resolved','dismissed') | Gap lifecycle status |
| `resolution_reason` | TEXT | DEFAULT NULL | How the gap was resolved |
| `resolved_by` | TEXT | DEFAULT NULL | Who resolved the gap |
| `resolved_at` | TEXT | DEFAULT NULL | Resolution timestamp |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_code_evidence_gaps_habitat(habitat_id)`, `idx_code_evidence_gaps_target(target_type, target_id)`, `idx_code_evidence_gaps_status(status)`, `idx_code_evidence_gaps_type(gap_type)`

---

### Workflow Automation (v0.18)

The v0.18 workflow automation subsystem adds user-configurable trigger→condition→action rules and a full audit trail of their executions.

#### `automation_rules`

Defines a configured automation rule (trigger + condition + actions) scoped to a habitat.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Rule identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Owning habitat |
| `name` | TEXT | NOT NULL | Human-readable rule name |
| `description` | TEXT | NOT NULL DEFAULT '' | Rule description |
| `enabled` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Whether the rule is active |
| `priority` | INTEGER | NOT NULL DEFAULT 0 | Execution priority (higher = earlier) |
| `trigger` | TEXT | NOT NULL (JSON) | Trigger definition |
| `condition` | TEXT | NOT NULL DEFAULT '{}' (JSON) | Condition predicate (defaults to `{ type: "always" }`) |
| `actions` | TEXT | NOT NULL DEFAULT '[]' (JSON) | Ordered action list |
| `cooldown_seconds` | INTEGER | NOT NULL DEFAULT 300 | Minimum seconds between runs |
| `max_runs_per_hour` | INTEGER | NOT NULL DEFAULT 30 | Rate cap per hour |
| `created_by` | TEXT | NOT NULL | Creator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |
| `last_run_at` | TEXT | DEFAULT NULL | Last execution timestamp |

**Indexes:** `idx_automation_rules_habitat(habitat_id)`, `idx_automation_rules_enabled(habitat_id, enabled)`, `idx_automation_rules_priority(habitat_id, priority)`

#### `automation_rule_runs`

Audit trail of every automation rule execution attempt and its outcome.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Run identifier (UUID) |
| `rule_id` | TEXT | NOT NULL FK → automation_rules(id) ON DELETE CASCADE | Executed rule |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Habitat context |
| `trigger_type` | TEXT | NOT NULL | What kind of trigger fired |
| `trigger_event_id` | TEXT | DEFAULT NULL | Event that triggered the run |
| `target_type` | TEXT | DEFAULT NULL | Type of target acted on |
| `target_id` | TEXT | DEFAULT NULL | Target identifier |
| `fingerprint` | TEXT | NOT NULL | Dedup key for the run |
| `status` | TEXT | NOT NULL | Run outcome status |
| `skip_reason` | TEXT | DEFAULT NULL | Why the run was skipped |
| `condition_result` | TEXT | DEFAULT NULL (JSON) | Evaluated condition output |
| `action_results` | TEXT | DEFAULT NULL (JSON) | Per-action result list |
| `metadata` | TEXT | DEFAULT NULL (JSON) | Freeform metadata |
| `started_at` | TEXT | NOT NULL | Run start timestamp |
| `finished_at` | TEXT | DEFAULT NULL | Run finish timestamp |

**Indexes:** `idx_automation_runs_rule(rule_id, started_at)`, `idx_automation_runs_habitat(habitat_id, started_at)`, `idx_automation_runs_fingerprint(fingerprint, started_at)`, `idx_automation_runs_status(habitat_id, status)`

---

### Notification System V2 (v0.18)

The v0.18 notification system V2 introduces an event/delivery split with per-recipient subscriptions, channel-level delivery attempts, digests, and retention policies.

#### `notification_events`

Canonical record of a noteworthy event in a habitat that may need delivery.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Event identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Owning habitat |
| `event_type` | TEXT | NOT NULL | Event category |
| `source_type` | TEXT | NOT NULL | Type of emitting source |
| `source_id` | TEXT | DEFAULT NULL | Identifier of the source |
| `target_type` | TEXT | DEFAULT NULL | Type of target entity |
| `target_id` | TEXT | DEFAULT NULL | Identifier of the target |
| `severity` | TEXT | NOT NULL | Severity level |
| `title` | TEXT | NOT NULL | Short event title |
| `body` | TEXT | NOT NULL | Event body text |
| `payload` | TEXT | NOT NULL DEFAULT '{}' (JSON) | Structured event payload |
| `created_by_type` | TEXT | NOT NULL | Originator type |
| `created_by_id` | TEXT | DEFAULT NULL | Originator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `history_summary` | TEXT | DEFAULT NULL (JSON) | Cached history summary |

**Indexes:** `idx_notification_events_habitat_created(habitat_id, created_at)`, `idx_notification_events_type(habitat_id, event_type)`, `idx_notification_events_source(source_type, source_id)`

#### `notification_deliveries`

Per-recipient trackable delivery of a notification event with lifecycle status.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Delivery identifier (UUID) |
| `event_id` | TEXT | NOT NULL FK → notification_events(id) ON DELETE CASCADE | Event being delivered |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Habitat context |
| `recipient_type` | TEXT | NOT NULL | Type of recipient |
| `recipient_id` | TEXT | NOT NULL | Recipient identifier |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | Delivery status |
| `required` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Whether delivery is mandatory |
| `channels` | TEXT | NOT NULL DEFAULT '[]' (JSON) | Target channel list |
| `delivered_at` | TEXT | DEFAULT NULL | When first delivered |
| `acknowledged_at` | TEXT | DEFAULT NULL | When acknowledged |
| `snoozed_until` | TEXT | DEFAULT NULL | Snooze expiry |
| `muted_at` | TEXT | DEFAULT NULL | When muted |
| `cleared_at` | TEXT | DEFAULT NULL | When cleared from inbox |
| `clear_after` | TEXT | DEFAULT NULL | Scheduled auto-clear time |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_notification_deliveries_recipient_active(habitat_id, recipient_type, recipient_id, status, created_at)`, `idx_notification_deliveries_event(event_id)`, `idx_notification_deliveries_clearance(habitat_id, clear_after, status)`

#### `notification_delivery_attempts`

Low-level log of each physical delivery attempt on a channel, including retries.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Attempt identifier (UUID) |
| `delivery_id` | TEXT | NOT NULL FK → notification_deliveries(id) ON DELETE CASCADE | Parent delivery |
| `channel` | TEXT | NOT NULL | Channel used |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | Attempt status |
| `attempt` | INTEGER | NOT NULL DEFAULT 1 | 1-based attempt number |
| `status_code` | INTEGER | DEFAULT NULL | HTTP response status code |
| `error` | TEXT | DEFAULT NULL | Error message on failure |
| `response_body` | TEXT | DEFAULT NULL | Captured response body |
| `next_retry_at` | TEXT | DEFAULT NULL | Scheduled next retry time |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Attempt creation timestamp |
| `finished_at` | TEXT | DEFAULT NULL | Attempt completion timestamp |

**Indexes:** `idx_notification_attempts_delivery(delivery_id)`, `idx_notification_attempts_retry(channel, status, next_retry_at)`

#### `notification_subscriptions`

Per-recipient subscription preferences for an event type within a habitat.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Subscription identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Owning habitat |
| `scope` | TEXT | NOT NULL | Subscription scope key |
| `recipient_type` | TEXT | DEFAULT NULL | Recipient type |
| `recipient_id` | TEXT | DEFAULT NULL | Recipient identifier |
| `event_type` | TEXT | NOT NULL | Subscribed event type |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 (boolean) | Whether subscription is active |
| `required` | INTEGER | NOT NULL DEFAULT 0 (boolean) | Whether subscription is mandatory |
| `channels` | TEXT | NOT NULL DEFAULT '[]' (JSON) | Preferred channel list |
| `cadence` | TEXT | NOT NULL DEFAULT 'immediate' | Delivery cadence |
| `timezone` | TEXT | DEFAULT NULL | Recipient timezone |
| `local_send_time` | TEXT | DEFAULT NULL | Local time-of-day for scheduled sends |
| `mute_until` | TEXT | DEFAULT NULL | Mute expiry |
| `created_by` | TEXT | DEFAULT NULL | Creator identifier |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_notification_subscriptions_habitat(habitat_id, event_type)`, `idx_notification_subscriptions_recipient(habitat_id, recipient_type, recipient_id)`

#### `notification_digest_items`

Join table recording which events were rolled into a digest.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Row identifier (UUID) |
| `digest_event_id` | TEXT | NOT NULL FK → notification_events(id) ON DELETE CASCADE | Parent digest event |
| `included_event_id` | TEXT | NOT NULL FK → notification_events(id) ON DELETE CASCADE | Event rolled into the digest |
| `included_delivery_id` | TEXT | FK → notification_deliveries(id) ON DELETE SET NULL | Associated delivery |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Row creation timestamp |

**Indexes:** (none)

#### `notification_retention_policies`

Per-habitat retention policy for notification clearance.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Policy identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → habitats(id) ON DELETE CASCADE | Owning habitat (unique) |
| `acknowledged_clear_after_days` | INTEGER | NOT NULL DEFAULT 30 | Days to keep acknowledged events |
| `resolved_clear_after_days` | INTEGER | NOT NULL DEFAULT 30 | Days to keep resolved events |
| `failed_clear_after_days` | INTEGER | NOT NULL DEFAULT 90 | Days to keep failed events |
| `history_summary_retention_days` | INTEGER | DEFAULT NULL | Days to retain history summaries |
| `updated_by` | TEXT | DEFAULT NULL | Last updater |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Unique index:** `idx_notification_retention_habitat(habitat_id)`

---

### Pod Bridge Tables (v0.19)

The following 13 tables are added by the v0.19 "Pod Bridge" release for remote participant identity, access control, and cross-pod collaboration. They exist alongside the existing local-only tables and do not modify or extend the `agents` table.

**Key design decisions:**

- Remote participants are **not stored in `agents`** (techspec §2.2) — they have their own `remote_participants` table with separate identity, standing, and credential columns
- Remote participant claims on tasks use a **separate column** (`tasks.remote_assigned_participant_id`) with no FK to `agents`, preserving the local-only analytics boundary
- Credential hashing uses **SHA-256** for high-entropy API keys (bcrypt is unnecessary for random secrets of 32+ bytes)
- The `remote_webhook_deliveries` table mirrors the existing `webhook_deliveries` shape but is FK-linked to `remote_webhook_endpoints` instead of `webhook_subscriptions`

#### `identity_providers`

Provider-backed identity configuration per habitat.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Provider identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `kind` | TEXT | NOT NULL CHECK (IN 'github','oidc') | Provider kind |
| `name` | TEXT | NOT NULL | Display name |
| `issuer` | TEXT | DEFAULT NULL | OIDC issuer URL |
| `config` | TEXT | DEFAULT '{}' NOT NULL | Provider-specific config JSON |
| `enabled` | INTEGER | DEFAULT 0 NOT NULL | Whether the provider is active |
| `created_by` | TEXT | DEFAULT NULL | Admin who configured the provider |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_identity_providers_habitat(habitat_id, enabled)`, `idx_identity_providers_kind(habitat_id, kind)`

#### `identity_provider_auth_states`

OAuth/OIDC state records for PKCE flow safety.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | State identifier (UUID) |
| `provider_id` | TEXT | NOT NULL FK → identity_providers(id) ON DELETE CASCADE | Parent provider |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `state` | TEXT | NOT NULL UNIQUE | OAuth state parameter |
| `nonce` | TEXT | DEFAULT NULL | OIDC nonce |
| `code_verifier` | TEXT | DEFAULT NULL | PKCE code verifier |
| `invite_id` | TEXT | DEFAULT NULL | Linked invite for context |
| `redirect_uri` | TEXT | DEFAULT NULL | Redirect URI |
| `expires_at` | TEXT | NOT NULL | Expiry timestamp (10 min TTL) |
| `consumed` | INTEGER | DEFAULT 0 NOT NULL | Whether state was consumed |
| `consumed_at` | TEXT | DEFAULT NULL | Consumption timestamp |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

**Indexes:** `idx_ipas_provider(provider_id)`, `idx_ipas_habitat(habitat_id)`, `idx_ipas_state(state) UNIQUE`

#### `remote_invites`

Provider-first or manual invite records.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Invite identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `invite_type` | TEXT | NOT NULL CHECK (IN 'provider','manual') | Invite kind |
| `provider_id` | TEXT | DEFAULT NULL FK → identity_providers(id) ON DELETE SET NULL | Linked provider for provider invites |
| `baseline_standing` | TEXT | NOT NULL DEFAULT 'remote_observer' | Participant standing at acceptance |
| `baseline_scopes` | TEXT | DEFAULT '[]' NOT NULL | Baseline action scopes JSON |
| `status` | TEXT | NOT NULL DEFAULT 'pending' CHECK (IN 'pending','accepted','revoked','expired') | Invite lifecycle status |
| `token_hash` | TEXT | DEFAULT NULL | SHA-256 hash of manual invite token |
| `expires_at` | TEXT | DEFAULT NULL | Optional expiry timestamp |
| `accepted_by` | TEXT | DEFAULT NULL | Who accepted the invite |
| `accepted_at` | TEXT | DEFAULT NULL | Acceptance timestamp |
| `revoked_by` | TEXT | DEFAULT NULL | Who revoked the invite |
| `revoked_at` | TEXT | DEFAULT NULL | Revocation timestamp |
| `revoke_reason` | TEXT | DEFAULT NULL | Reason for revocation |
| `invited_by` | TEXT | NOT NULL | Who created the invite |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_remote_invites_habitat(habitat_id)`, `idx_remote_invites_provider(provider_id)`, `idx_remote_invites_status(status)`, `idx_remote_invites_token_hash(token_hash)`

#### `remote_pods`

Trusted external pod/admin group records.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Pod identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `name` | TEXT | NOT NULL | Display name |
| `description` | TEXT | DEFAULT '' NOT NULL | Description |
| `default_standing` | TEXT | NOT NULL DEFAULT 'remote_observer' | Default standing for participants |
| `status` | TEXT | NOT NULL DEFAULT 'pending' CHECK (IN 'pending','active','suspended','revoked') | Pod lifecycle status |
| `invite_id` | TEXT | DEFAULT NULL FK → remote_invites(id) ON DELETE SET NULL | Invite that created the pod |
| `provider_pod_identity` | TEXT | DEFAULT NULL | Provider-specific pod identifier |
| `created_by` | TEXT | DEFAULT NULL | Who created the pod |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |
| `suspended_at` | TEXT | DEFAULT NULL | Suspension timestamp |
| `revoked_at` | TEXT | DEFAULT NULL | Revocation timestamp |
| `revoke_reason` | TEXT | DEFAULT NULL | Reason for revocation |

**Indexes:** `idx_remote_pods_habitat(habitat_id)`, `idx_remote_pods_status(status)`, `idx_remote_pods_invite(invite_id)`

#### `remote_participants`

Remote humans/orcys under a remote pod.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Participant identifier (UUID) |
| `remote_pod_id` | TEXT | NOT NULL FK → remote_pods(id) ON DELETE CASCADE | Parent pod |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `participant_type` | TEXT | NOT NULL CHECK (IN 'remote_human','remote_orcy') | Participant type |
| `display_name` | TEXT | NOT NULL | Display name |
| `standing` | TEXT | NOT NULL DEFAULT 'remote_observer' CHECK (IN 'local_member','remote_observer','remote_contributor','remote_reviewer','trusted_remote_pod') | Current standing |
| `proposed_capabilities` | TEXT | DEFAULT '[]' NOT NULL | Proposed capabilities JSON |
| `proposed_domains` | TEXT | DEFAULT '[]' NOT NULL | Proposed domains JSON |
| `approved_capabilities` | TEXT | DEFAULT '[]' NOT NULL | Host-approved capabilities JSON |
| `approved_domains` | TEXT | DEFAULT '[]' NOT NULL | Host-approved domains JSON |
| `status` | TEXT | NOT NULL DEFAULT 'pending' CHECK (IN 'pending','active','suspended','revoked') | Lifecycle status |
| `external_identity_id` | TEXT | DEFAULT NULL | Provider-specific identity ID |
| `registered_by` | TEXT | DEFAULT NULL | Who registered the participant |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |
| `suspended_at` | TEXT | DEFAULT NULL | Suspension timestamp |
| `revoked_at` | TEXT | DEFAULT NULL | Revocation timestamp |

**Indexes:** `idx_remote_participants_pod(remote_pod_id)`, `idx_remote_participants_habitat(habitat_id)`, `idx_remote_participants_status(status)`

#### `remote_credentials`

SHA-256 hashed credentials for remote participants.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Credential identifier (UUID) |
| `remote_participant_id` | TEXT | NOT NULL FK → remote_participants(id) ON DELETE CASCADE | Owner participant |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `credential_type` | TEXT | NOT NULL CHECK (IN 'api','mcp') | Credential type |
| `secret_hash` | TEXT | NOT NULL UNIQUE | SHA-256 hash of the credential secret |
| `label` | TEXT | DEFAULT '' NOT NULL | Credential label |
| `status` | TEXT | NOT NULL DEFAULT 'active' CHECK (IN 'active','rotated','revoked','expired') | Lifecycle status |
| `expires_at` | TEXT | DEFAULT NULL | Optional expiry timestamp |
| `last_used_at` | TEXT | DEFAULT NULL | Last verification timestamp |
| `revoked_by` | TEXT | DEFAULT NULL | Who revoked the credential |
| `revoke_reason` | TEXT | DEFAULT NULL | Reason for revocation |
| `created_by` | TEXT | DEFAULT NULL | Who created the credential |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_remote_credentials_participant(remote_participant_id)`, `idx_remote_credentials_habitat(habitat_id)`, `idx_remote_credentials_hash(secret_hash) UNIQUE`, `idx_remote_credentials_status(status)`

#### `remote_grants`

Scoped access grants for remote participants and pods.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Grant identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `remote_pod_id` | TEXT | NOT NULL FK → remote_pods(id) ON DELETE CASCADE | Target pod |
| `remote_participant_id` | TEXT | DEFAULT NULL FK → remote_participants(id) ON DELETE CASCADE | Target participant (NULL = pod-wide) |
| `grant_type` | TEXT | NOT NULL CHECK (IN 'baseline_observer','scoped_elevation','permanent_execution') | Grant type |
| `standing` | TEXT | NOT NULL | Effective standing for this grant |
| `action_scopes` | TEXT | DEFAULT '[]' NOT NULL | Allowed action scopes JSON |
| `eligibility_mode` | TEXT | NOT NULL DEFAULT 'allowlist' CHECK (IN 'allowlist','rule_based') | Target eligibility mode |
| `include_future_matches` | INTEGER | DEFAULT 0 NOT NULL | Whether rule-based grants match future tasks |
| `grace_window_hours` | INTEGER | DEFAULT 24 NOT NULL | Grace window in hours after expiry |
| `status` | TEXT | NOT NULL DEFAULT 'active' CHECK (IN 'active','expired','soft_revoked','hard_revoked','frozen','grace') | Grant lifecycle status |
| `expires_at` | TEXT | DEFAULT NULL | Optional expiry timestamp |
| `expired_at` | TEXT | DEFAULT NULL | When the grant expired |
| `revocation_mode` | TEXT | DEFAULT NULL CHECK (IN 'soft','hard','freeze') | Revocation mode |
| `revoked_at` | TEXT | DEFAULT NULL | Revocation timestamp |
| `revoked_by` | TEXT | DEFAULT NULL | Who revoked the grant |
| `revoke_reason` | TEXT | DEFAULT NULL | Reason for revocation |
| `created_by` | TEXT | DEFAULT NULL | Who created the grant |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_remote_grants_habitat(habitat_id)`, `idx_remote_grants_pod(remote_pod_id)`, `idx_remote_grants_participant(remote_participant_id)`, `idx_remote_grants_status(status)`

**Grant types:** `baseline_observer` (long-lived, read-only), `scoped_elevation` (time-boxed, action-scoped), `permanent_execution` (explicitly dangerous, high-trust pods only)

**Revocation modes:** `soft` (blocks new claims, grace for claimed work), `hard` (immediate block, releases claimed tasks), `freeze` (blocks actions, keeps assignments for host review)

#### `remote_grant_targets`

Explicit allowlist targets for grant eligibility.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Target identifier (UUID) |
| `grant_id` | TEXT | NOT NULL FK → remote_grants(id) ON DELETE CASCADE | Parent grant |
| `target_type` | TEXT | NOT NULL CHECK (IN 'habitat','mission','task') | Target type |
| `target_id` | TEXT | NOT NULL | Target entity UUID |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

**Indexes:** `idx_remote_grant_targets_grant(grant_id)`

#### `remote_grant_rules`

Rule-based eligibility filters for grants.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Rule identifier (UUID) |
| `grant_id` | TEXT | NOT NULL UNIQUE FK → remote_grants(id) ON DELETE CASCADE | Parent grant (1:1) |
| `domains` | TEXT | DEFAULT '[]' NOT NULL | Domain filters JSON |
| `labels` | TEXT | DEFAULT '[]' NOT NULL | Label filters JSON |
| `capabilities` | TEXT | DEFAULT '[]' NOT NULL | Capability filters JSON |
| `time_window_start` | TEXT | DEFAULT NULL | Time window start |
| `time_window_end` | TEXT | DEFAULT NULL | Time window end |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

#### `remote_grant_task_snapshots`

Snapshot of tasks matched by rule-based grants at creation time.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Snapshot identifier (UUID) |
| `grant_id` | TEXT | NOT NULL FK → remote_grants(id) ON DELETE CASCADE | Parent grant |
| `task_id` | TEXT | NOT NULL | Matched task UUID |
| `match_reason` | TEXT | DEFAULT NULL | Why the task matched |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

#### `remote_idempotency_keys`

Idempotency records for remote write retries.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Key identifier (UUID) |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `remote_participant_id` | TEXT | NOT NULL FK → remote_participants(id) ON DELETE CASCADE | Acting participant |
| `remote_credential_id` | TEXT | DEFAULT NULL FK → remote_credentials(id) ON DELETE SET NULL | Credential used |
| `action` | TEXT | NOT NULL | Action being retried |
| `idempotency_key` | TEXT | NOT NULL | Client-provided key |
| `request_hash` | TEXT | NOT NULL | SHA-256 of request body+path |
| `status` | TEXT | NOT NULL DEFAULT 'pending' CHECK (IN 'pending','completed','failed') | Lifecycle status |
| `response_status` | INTEGER | DEFAULT NULL | HTTP status of completed request |
| `response_body` | TEXT | DEFAULT NULL | Response body JSON |
| `error_message` | TEXT | DEFAULT NULL | Error message if failed |
| `expires_at` | TEXT | NOT NULL | Expiry timestamp (24h default) |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `completed_at` | TEXT | DEFAULT NULL | Completion timestamp |

**Indexes:** `idx_idempotency_keys_participant_action(remote_participant_id, action, idempotency_key) UNIQUE`, `idx_idempotency_keys_expires(expires_at)`

#### `remote_webhook_endpoints`

Host-approved remote pod webhook endpoints.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Endpoint identifier (UUID) |
| `remote_pod_id` | TEXT | NOT NULL FK → remote_pods(id) ON DELETE CASCADE | Owner pod |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `url` | TEXT | NOT NULL | Webhook URL |
| `description` | TEXT | DEFAULT '' NOT NULL | Description |
| `events` | TEXT | DEFAULT '[]' NOT NULL | Subscribed event types JSON |
| `status` | TEXT | NOT NULL DEFAULT 'pending' CHECK (IN 'pending','approved','enabled','disabled','rejected') | Lifecycle status |
| `secret_hash` | TEXT | DEFAULT NULL | SHA-256 hash of signing secret |
| `last_test_at` | TEXT | DEFAULT NULL | Last test timestamp |
| `last_test_status` | TEXT | DEFAULT NULL | Last test result |
| `approved_by` | TEXT | DEFAULT NULL | Who approved the endpoint |
| `approved_at` | TEXT | DEFAULT NULL | Approval timestamp |
| `enabled_by` | TEXT | DEFAULT NULL | Who enabled the endpoint |
| `enabled_at` | TEXT | DEFAULT NULL | Enablement timestamp |
| `rejected_at` | TEXT | DEFAULT NULL | Rejection timestamp |
| `rejected_by` | TEXT | DEFAULT NULL | Who rejected the endpoint |
| `reject_reason` | TEXT | DEFAULT NULL | Reason for rejection |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last update timestamp |

**Indexes:** `idx_remote_webhook_endpoints_pod(remote_pod_id)`, `idx_remote_webhook_endpoints_habitat(habitat_id)`, `idx_remote_webhook_endpoints_status(status)`

#### `remote_webhook_deliveries`

Delivery records for compact remote webhook payloads.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Delivery identifier (UUID) |
| `endpoint_id` | TEXT | NOT NULL FK → remote_webhook_endpoints(id) ON DELETE CASCADE | Target endpoint |
| `habitat_id` | TEXT | NOT NULL FK → boards(id) ON DELETE CASCADE | Parent habitat |
| `event_type` | TEXT | NOT NULL | Event type delivered |
| `payload` | TEXT | NOT NULL | Compact payload JSON |
| `signature` | TEXT | NOT NULL | HMAC-SHA256 signature |
| `status` | TEXT | NOT NULL DEFAULT 'pending' CHECK (IN 'pending','success','failed') | Delivery status |
| `status_code` | INTEGER | DEFAULT NULL | HTTP status code |
| `response_body` | TEXT | DEFAULT NULL | Response body |
| `attempts` | INTEGER | DEFAULT 0 NOT NULL | Number of delivery attempts |
| `last_attempt_at` | TEXT | DEFAULT NULL | Last attempt timestamp |
| `next_retry_at` | TEXT | DEFAULT NULL | Next retry timestamp |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Record creation timestamp |

**Indexes:** `idx_remote_webhook_deliveries_endpoint(endpoint_id, created_at)`, `idx_remote_webhook_deliveries_status(status, next_retry_at)`

---

## Dialect Helpers

The `packages/api/src/db/dialect-helpers.ts` file provides cross-database compatibility:

```typescript
setDriver('sqlite' | 'postgres')  // Switch database driver
getDriver()                        // Get current driver
cycleTimeMinutes(completedAt, startedAt)  // Date diff in minutes
nowExpr()                          // Current timestamp
dateDayExpr(column)               // Truncate to day
```

### PostgreSQL Path

Set the driver via `setDriver('postgres')` before initializing:

```typescript
setDriver('postgres');
await initDb();
```

Then Drizzle uses PostgreSQL-compatible SQL. Key differences:

| SQLite | PostgreSQL |
|--------|-----------|
| `datetime('now')` | `NOW()` |
| `json_extract(col, '$.key')` | `col->>'key'` |
| `ROUND((julianday(a) - julianday(b)) * 1440)` | `EXTRACT(EPOCH FROM (a - b)) / 60` |

---

## Database Administration

### Inspecting the Database

```bash
# Using sqlite3 CLI
sqlite3 orcy.db ".tables"
sqlite3 orcy.db ".schema tasks"
sqlite3 orcy.db "SELECT id, title, status FROM tasks LIMIT 10;"

# Using Drizzle Studio (development)
npx drizzle-kit studio
```

### Resetting the Database

```bash
# Stop the API
rm orcy.db
# Start the API — database is created automatically
bun run --watch packages/api/src/index.ts
```

### Monitoring Database Size

```bash
ls -lh orcy.db
sqlite3 orcy.db "SELECT name, SUM(pgsize) as size FROM dbstat GROUP BY name ORDER BY size DESC;"
```

---

## Schema Workflow

This section explains **how to edit the database schema** correctly. Read this before adding columns, tables, indexes, or constraints.

### Source of Truth

The Drizzle TypeScript schema files are the **single source of truth** for the database schema:

```
packages/api/src/db/schema/    ← Edit these files
├── index.ts                   ← Barrel export
├── board.ts                   ← Habitats, missions, columns, tasks, events
├── agent.ts                   ← Agents
├── user.ts                    ← Users, organizations, teams
├── cicd.ts                    ← Pull requests, pipeline events
├── code-evidence.ts           ← Code branches, commits, evidence, gaps
├── effort.ts                  ← Effort entries
├── sprint.ts                  ← Sprints
├── audit.ts                   ← Audit export schedules, health snapshots
└── ...                        ← Other domain files
```

Never edit SQL files directly to change schema. The SQL files are **generated outputs** and will be overwritten.

### File Types and What They Mean

| File | Purpose | Edit? |
|------|---------|-------|
| `packages/api/src/db/schema/*.ts` | Schema definitions (tables, columns, indexes, FKs) | **YES** — this is where you make changes |
| `packages/api/drizzle/0000_schema.sql` | Full schema snapshot for fresh databases | **No** — regenerated from TS files |
| `packages/api/drizzle/0001_*.sql` through `0026_*.sql` | Incremental migrations for production replay | **No** — historical record only |
| `packages/api/drizzle/meta/0000_snapshot.json` | Drizzle's diff baseline | **No** — regenerated by drizzle-kit |
| `packages/api/drizzle/meta/_journal.json` | Migration tracking | **No** — managed by drizzle-kit |

### Two Deployment Paths

The schema serves two different contexts:

| Context | How it gets the schema | Why |
|---------|------------------------|-----|
| **Test databases** (`initTestDb()`) | Applies only `0000_schema.sql` | Fresh in-memory DBs, no data to preserve |
| **Production databases** | Applies migrations 0000-0026 in order via `drizzle-kit migrate` | Preserves existing data through incremental changes |

This split is intentional. Test DBs get the fastest possible setup. Production DBs get safe, auditable, data-preserving migrations.

### How to Add a Column

**Example: add a `priority` column to `webhook_subscriptions`**

1. **Edit the Drizzle schema file** (`packages/api/src/db/schema/audit.ts` or wherever the table lives):

```typescript
export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions",
  {
    // ... existing columns ...
    priority: text("priority", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
  },
  (table) => [
    // ... existing indexes ...
  ],
);
```

2. **Generate the migration**:

```bash
cd packages/api
pnpm drizzle-kit generate --name add_webhook_priority
```

This creates `drizzle/0027_add_webhook_priority.sql` and updates `drizzle/meta/`.

3. **Regenerate the base schema** (for test DBs and new deployments):

```bash
# Apply schema to a temp DB, dump it, replace 0000_schema.sql
cd packages/api
rm -f /tmp/orcy-schema-tmp.db
cat > /tmp/drizzle.config.ts <<'EOF'
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: '/tmp/orcy-meta',
  dialect: 'sqlite',
  dbCredentials: { url: '/tmp/orcy-schema-tmp.db' },
});
EOF
pnpm drizzle-kit push --config=/tmp/drizzle.config.ts --force
node -e "
const Database = require('better-sqlite3');
const db = new Database('/tmp/orcy-schema-tmp.db');
const tables = db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY rowid\").all();
const indexes = db.prepare(\"SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY rowid\").all();
let sql = '';
for (const t of tables) sql += t.sql + ';\n--> statement-breakpoint\n';
for (const i of indexes) sql += i.sql + ';\n--> statement-breakpoint\n';
require('fs').writeFileSync('drizzle/0000_schema.sql', sql);
console.log('Tables:', tables.length, 'Indexes:', indexes.length);
"
rm -rf /tmp/orcy-meta /tmp/orcy-schema-tmp.db /tmp/drizzle.config.ts
```

4. **Update the schema validation test** if column/index counts changed:

```typescript
// packages/api/src/test/schemaValidation.test.ts
it("contains exactly 64 tables", () => {
  expect(createTables.length).toBe(64);
});

it("has 171 indexes including unique indexes", () => {
  expect(createIndexes.length).toBe(171);
});
```

5. **Run tests**:

```bash
pnpm --filter @orcy/api test
pnpm -r typecheck
pnpm lint
```

### How to Add an Index

Indexes are added at the **table level** using the second argument to `sqliteTable`:

```typescript
export const tasks = sqliteTable(
  "tasks",
  {
    // ... columns ...
  },
  (table) => [
    index("idx_tasks_new_column").on(table.newColumn),
    // ... other indexes ...
  ],
);
```

**Important:** Always declare indexes in the Drizzle schema, not just in migration SQL. If you add an index only to a migration file, it won't appear in `0000_schema.sql` and test DBs will be slow.

### How to Add a Foreign Key

Use `.references()` on the column:

```typescript
userId: text("user_id")
  .notNull()
  .references(() => users.id, { onDelete: "cascade" }),
```

**To remove a physical FK constraint while keeping the column** (e.g., for mission_events where you want to preserve events on delete), omit `.references()`:

```typescript
missionId: text("mission_id").notNull(),  // No FK, but column still exists
```

### How to Modify a Column (Rename, Change Type)

SQLite has limited `ALTER TABLE` support. For column renames, the migration uses the table-rebuild pattern:

```sql
CREATE TABLE `table_new` (
  -- new schema
);
INSERT INTO `table_new` SELECT ... FROM `table`;
DROP TABLE `table`;
ALTER TABLE `table_new` RENAME TO `table`;
```

`drizzle-kit generate` produces this pattern automatically. Just edit the Drizzle schema and regenerate.

### Verification Checklist

Before committing schema changes:

- [ ] Drizzle schema TS files updated
- [ ] `drizzle-kit generate` produces a migration with no errors
- [ ] `0000_schema.sql` regenerated and matches the Drizzle schema
- [ ] `schemaValidation.test.ts` updated if counts changed
- [ ] `pnpm --filter @orcy/api test` passes (159 files, ~2367 tests)
- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm lint` passes
- [ ] If adding an index, verify it appears in `0000_schema.sql` (not just in the migration)

### Common Mistakes

| Mistake | Why it's wrong | Fix |
|---------|----------------|-----|
| Editing `0000_schema.sql` by hand | Will be overwritten by next regen | Edit the Drizzle schema and regen |
| Adding an index only in a migration file | Won't appear in test DBs | Add `.index()` to the Drizzle schema |
| Deleting `drizzle/meta/` | Drizzle-kit can't diff for future migrations | Keep `0000_snapshot.json` and `_journal.json` |
| Editing migration SQL files after they've been applied | Production DBs will be out of sync | Write a new migration instead |
| Adding `.references()` to mission_events | Deletes events on mission delete | Omit `.references()` to preserve events |

### Snapshot Maintenance

The `drizzle/meta/` directory must stay in sync with the Drizzle schema. If snapshots go missing or corrupt (e.g., after a botched merge), regenerate them:

```bash
# This rebuilds the snapshot from the current Drizzle schema
cd packages/api
rm -f /tmp/orcy-schema-tmp.db
cat > /tmp/drizzle.config.ts <<'EOF'
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: '/tmp/orcy-meta',
  dialect: 'sqlite',
  dbCredentials: { url: '/tmp/orcy-schema-tmp.db' },
});
EOF
pnpm drizzle-kit push --config=/tmp/drizzle.config.ts --force
pnpm drizzle-kit pull --config=/tmp/drizzle.config.ts
cp /tmp/orcy-meta/meta/0000_snapshot.json drizzle/meta/
cp /tmp/orcy-meta/meta/_journal.json drizzle/meta/
rm -rf /tmp/orcy-meta /tmp/orcy-schema-tmp.db /tmp/drizzle.config.ts
```

**Warning:** This resets the migration journal to a single `0000` entry. Production databases should not be affected (they use the SQL files, not the journal), but verify with `pnpm drizzle-kit generate` that no spurious diff is produced.
