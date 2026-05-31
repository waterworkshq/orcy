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
| `action` | TEXT | NOT NULL CHECK (IN 'created','updated','moved','status_changed','completed','deleted','dependency_resolved','code_evidence_linked','code_evidence_corrected','code_evidence_not_applicable','code_evidence_gap_reported','code_evidence_gap_resolved','code_evidence_backfilled') | Event action |
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
| `action` | TEXT | NOT NULL CHECK (IN 'created','claimed','started','submitted','approved','rejected','completed','failed','moved','released','dependency_resolved','updated','delegated','cloned','retry_scheduled','retry_executed','escalated','code_evidence_linked','code_evidence_corrected','code_evidence_not_applicable','code_evidence_gap_reported','code_evidence_gap_resolved','code_evidence_backfilled') | Event action |
| `from_column_id` | TEXT | DEFAULT NULL | Source column |
| `to_column_id` | TEXT | DEFAULT NULL | Target column |
| `from_status` | TEXT | DEFAULT NULL | Previous status |
| `to_status` | TEXT | DEFAULT NULL | New status |
| `metadata` | TEXT | NOT NULL DEFAULT '{}' (JSON) | JSON blob with details |
| `timestamp` | TEXT | NOT NULL DEFAULT (datetime('now')) | Event timestamp |

**Indexes:** `idx_task_events_task_id`, `idx_task_events_timestamp(timestamp DESC)`, `idx_task_events_actor(actor_type, actor_id)`

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
