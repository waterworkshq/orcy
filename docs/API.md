# API Reference

Complete reference for the Orcy REST API.

**Base URL:** `http://localhost:3000/api`

---

## Table of Contents

- [Authentication](#authentication)
- [Error Responses](#error-responses)
- [Health](#health)
- [Boards](#boards)
- [Columns](#columns)
- [Features](#features)
- [Tasks](#tasks)
- [Batch Operations](#batch-operations)
- [Task Lifecycle](#task-lifecycle)
- [Time Tracking & Estimation](#time-tracking--estimation)
- [Quality Gates](#quality-gates)
- [Task Events](#task-events)
- [Task Comments](#task-comments)
- [Agents](#agents)
- [Agent Messages](#agent-messages)
- [Pulse (Mission Signals)](#pulse-mission-signals)
- [Feature Templates](#feature-templates)
- [Saved Filters](#saved-filters)
- [Organizations](#organizations)
- [Chat Integrations](#chat-integrations)
- [Notification Preferences](#notification-preferences)
- [Attachments](#attachments)
- [Outgoing Webhooks](#outgoing-webhooks)
- [Webhooks](#webhooks)
- [CI/CD Webhooks](#cicd-webhooks)
- [Code Review Webhooks](#code-review-webhooks)
- [Auth](#auth)
- [SSE Streaming](#sse-streaming)

---

## Authentication

All non-public API endpoints require authentication. Public routes: `GET /health`, `POST /api/auth/login`, and inbound webhook routes (verified by provider signatures).

### Agent Authentication

Include your agent API key in every request:

```
X-Agent-API-Key: <uuid>-<32-hex-chars>
```

Example: `X-Agent-API-Key: 550e8400-e29b-41d4-a716-446655440000-a1b2c3d4e5f67890a1b2c3d4e5f67890`

**Agent identity binding:** When using agent auth, the agent's identity (`request.agent.id`) is derived from the API key. Routes that accept an `:agentId` path parameter or `agentId` body field **ignore** those values and use the authenticated identity instead. This prevents one agent from impersonating another.

### Human Authentication

Include a JWT token in the Authorization header:

```
Authorization: Bearer <token>
```

Get a token from `POST /api/auth/login`.

### Stream Tokens (Realtime)

Browsers cannot send custom headers on EventSource connections. Use short-lived stream tokens instead:

```
GET /api/auth/stream-token  (requires human JWT auth)
→ Returns { token: "short-lived-jwt" }  (expires in 30 seconds)
```

Then connect: `EventSource('/sse/boards/:boardId?token=<stream-token>')`

### Dual Auth (Agent or Human)

Many endpoints accept either authentication method. If neither is provided, the request returns **401 Unauthorized**.

---

## Error Responses

All errors follow this JSON structure:

```json
{
  "error": "Human-readable message describing what went wrong",
  "code": "MACHINE_READABLE_CODE",
  "details": {}
}
```

> **Note:** Many route handlers perform manual Zod validation and return `{ error, details }` without the `code` field. The `code` field is only guaranteed when errors pass through the global Fastify error handler plugin (`packages/api/src/errors/plugin.ts`).

### Error Codes

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `VALIDATION_ERROR` | Request validation failed |
| 401 | `UNAUTHORIZED` | Missing or invalid credentials |
| 403 | `FORBIDDEN` | Authenticated but not authorized |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `CONFLICT` | State conflict (already claimed, version mismatch) |
| 429 | `RATE_LIMITED` | Rate limit exceeded |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

### Validation Error Example

```json
{
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": {
    "fieldErrors": {
      "title": ["String must contain at least 1 character(s)"],
      "priority": ["Invalid enum value"]
    }
  }
}
```

### Rate Limit Headers

Every response includes rate limit information:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1712234567
Retry-After: 45
```

---

## Health

### GET /health

Health check endpoint (no `/api` prefix).

**Response `200`:**

```json
{
  "status": "ok",
  "timestamp": "2026-04-04T12:00:00.000Z"
}
```

---

## Boards

### GET /boards

List all boards.

**Auth:** Agent or Human auth required.

**Response `200`:**

```json
{
  "boards": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Sprint 24",
      "description": "Q2 sprint planning",
      "createdAt": "2026-04-01T00:00:00.000Z",
      "updatedAt": "2026-04-04T12:00:00.000Z"
    }
  ]
}
```

### POST /boards

Create a new board. Default columns (Todo, In Progress, Review, Done) are created automatically unless `defaultColumns: false`.

**Request:**

```json
{
  "name": "Sprint 25",
  "description": "Next sprint",
  "defaultColumns": true
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | yes | 1-100 chars |
| `description` | string | no | max 500 chars |
| `defaultColumns` | boolean | no | default: `true` |

**Response `201`:**

```json
{
  "board": {
    "id": "board-uuid",
    "name": "Sprint 25",
    "description": "Next sprint",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "columns": [
    { "id": "col-1", "name": "Todo", "order": 0, "wipLimit": null, "autoAdvance": false, "requiresClaim": false, "nextColumnId": "col-2", "isTerminal": false },
    { "id": "col-2", "name": "In Progress", "order": 1, "wipLimit": null, "autoAdvance": false, "requiresClaim": true, "nextColumnId": "col-3", "isTerminal": false },
    { "id": "col-3", "name": "Review", "order": 2, "wipLimit": null, "autoAdvance": false, "requiresClaim": true, "nextColumnId": "col-4", "isTerminal": false },
    { "id": "col-4", "name": "Done", "order": 3, "wipLimit": null, "autoAdvance": true, "requiresClaim": true, "nextColumnId": null, "isTerminal": true }
  ]
}
```

### GET /boards/:id

Get a board with its columns and features.

**Auth:** Agent or Human auth required. Board access check enforced (404 if missing, 403 if unauthorized human).

**Response `200`:**

```json
{
  "board": { "id": "...", "name": "Sprint 24", "..." },
  "columns": [ { "id": "...", "name": "Todo", "..." } ],
  "features": [ { "id": "feat-uuid", "title": "Auth System", "status": "in_progress", "progress": { "completed": 2, "total": 5 }, "..." } ]
}
```

### PATCH /boards/:id

Update a board.

**Request:**

```json
{
  "name": "Sprint 24 (Updated)",
  "description": "Updated description"
}
```

**Response `200`:**

```json
{
  "board": { "id": "...", "name": "Sprint 24 (Updated)", "..." }
}
```

### DELETE /boards/:id

Delete a board and all its tasks.

**Response `204`:** No content.

### GET /boards/:id/stats

Get board statistics.

**Response `200`:**

```json
{
  "cycleTime": {
    "averageMinutes": 120,
    "medianMinutes": 95,
    "count": 15
  },
  "throughput": {
    "today": 3,
    "thisWeek": 12,
    "thisMonth": 45
  },
  "wipHealth": [
    { "columnId": "col-2", "columnName": "In Progress", "current": 2, "limit": 3, "health": "ok" },
    { "columnId": "col-3", "columnName": "Review", "current": 5, "limit": 5, "health": "warning" }
  ]
}
```

### GET /boards/:id/events

Get board-wide activity feed (all events across all tasks on the board).

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer | 50 | Results per page (1-200) |
| `offset` | integer | 0 | Skip results |

**Response `200`:**

```json
{
  "events": [
    {
      "id": "event-uuid",
      "taskId": "task-uuid",
      "taskTitle": "Fix authentication bug",
      "actorType": "agent",
      "actorId": "agent-uuid",
      "actorName": "claude-dev",
      "action": "submitted",
      "fromColumnId": null,
      "toColumnId": "col-uuid",
      "fromStatus": "in_progress",
      "toStatus": "submitted",
      "metadata": {},
      "timestamp": "2026-04-04T12:00:00.000Z"
    }
  ],
  "total": 42
}
```

---

## Columns

### POST /boards/:boardId/columns

Add a column to a board.

**Request:**

```json
{
  "name": "QA Testing",
  "order": 3,
  "wipLimit": 5,
  "autoAdvance": false,
  "requiresClaim": false,
  "nextColumnId": null,
  "isTerminal": false
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | yes | 1-50 chars |
| `order` | integer | no | >= 0 |
| `wipLimit` | integer/null | no | >= 1 or null |
| `autoAdvance` | boolean | no | default: false |
| `requiresClaim` | boolean | no | default: false |
| `nextColumnId` | UUID/null | no | Points to next column |
| `isTerminal` | boolean | no | default: false |

**Response `201`:**

```json
{
  "column": { "id": "col-new", "name": "QA Testing", "..." }
}
```

### PATCH /columns/:id

Update a column.

**Request:**

```json
{
  "name": "QA Testing (Updated)",
  "wipLimit": 8
}
```

**Response `200`:**

```json
{
  "column": { "id": "...", "name": "QA Testing (Updated)", "wipLimit": 8, "..." }
}
```

### DELETE /columns/:id

Delete a column.

**Response `204`:** No content.

---

## Features

Features are the board-level cards. They represent goals that flow through columns. Each feature contains tasks that orcys work on. Feature status is auto-derived from child task states.

### Feature Status Values

| Status | Condition |
|--------|-----------|
| `not_started` | All tasks pending |
| `in_progress` | Any task claimed/in_progress/submitted/approved/rejected |
| `review` | All tasks submitted/approved/done |
| `done` | All tasks done/approved (at least one done) |
| `failed` | Any task failed and none actively being worked on |

### POST /boards/:boardId/features

Create a new feature on a board. The feature is placed in the first column (Backlog) by default.

**Request:**

```json
{
  "title": "Implement User Authentication",
  "description": "Add JWT-based auth with refresh tokens for all API endpoints",
  "acceptanceCriteria": "Users can sign in, get a JWT, and refresh tokens work",
  "priority": "high",
  "labels": ["security", "auth"],
  "dependsOn": ["previous-feature-uuid"]
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `columnId` | UUID | no | Initial column (default: first column) |
| `title` | string | yes | 1-200 chars |
| `description` | string | no | max 5000 chars |
| `acceptanceCriteria` | string | no | max 5000 chars |
| `priority` | enum | no | `low`, `medium`, `high`, `critical` (default: `medium`) |
| `labels` | string[] | no | Feature labels |
| `dependsOn` | UUID[] | no | Feature IDs this feature depends on |
| `blocks` | UUID[] | no | Feature IDs this feature blocks |
| `dueAt` | datetime | no | Due date |
| `slaMinutes` | integer | no | SLA in minutes |

**Response `201`:**

```json
{
  "feature": {
    "id": "feat-uuid",
    "boardId": "board-uuid",
    "columnId": "col-backlog-uuid",
    "title": "Implement User Authentication",
    "description": "...",
    "acceptanceCriteria": "...",
    "priority": "high",
    "labels": ["security", "auth"],
    "status": "not_started",
    "dependsOn": ["previous-feature-uuid"],
    "blocks": [],
    "dueAt": null,
    "slaMinutes": null,
    "createdBy": "admin",
    "createdAt": "2026-04-26T00:00:00.000Z",
    "updatedAt": "2026-04-26T00:00:00.000Z",
    "version": 1
  }
}
```

### GET /boards/:boardId/features

List features on a board with progress information.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | enum | — | Filter by feature status: `not_started`, `in_progress`, `review`, `done`, `failed` |
| `priority` | enum | — | Filter: `low`, `medium`, `high`, `critical` |
| `isArchived` | boolean | false | Filter to return either only active (false) or archived (true) features. By default this is false on board views but can be overridden. |
| `limit` | integer | 20 | Results per page (1-100) |
| `offset` | integer | 0 | Skip results |

**Response `200`:**

```json
{
  "features": [
    {
      "id": "feat-uuid",
      "boardId": "board-uuid",
      "columnId": "col-uuid",
      "title": "Implement User Authentication",
      "description": "...",
      "acceptanceCriteria": "...",
      "priority": "high",
      "labels": ["security", "auth"],
      "status": "in_progress",
      "dependsOn": [],
      "blocks": [],
      "dueAt": null,
      "progress": { "completed": 2, "total": 5, "percentage": 40 },
      "createdBy": "admin",
      "createdAt": "...",
      "updatedAt": "...",
      "version": 3
    }
  ],
  "total": 8
}
```

### GET /features/:id

Get a feature with progress information.

**Response `200`:**

```json
{
  "feature": {
    "id": "feat-uuid",
    "title": "Implement User Authentication",
    "status": "in_progress",
    "progress": { "completed": 2, "total": 5, "percentage": 40 },
    "..."
  }
}
```

### GET /features/:id/details

Get a feature with its tasks, events, progress, and dependencies.

**Response `200`:**

```json
{
  "feature": { "id": "feat-uuid", "title": "...", "status": "in_progress", "..." },
  "tasks": [
    { "id": "task-uuid", "title": "Create JWT middleware", "status": "done", "..." },
    { "id": "task-uuid-2", "title": "Add login endpoint", "status": "pending", "..." }
  ],
  "events": [
    { "id": "evt-uuid", "action": "created", "actorType": "human", "timestamp": "..." }
  ],
  "progress": { "completed": 2, "total": 5, "percentage": 40, "byStatus": { "done": 2, "pending": 3 } },
  "dependencies": { "dependsOn": [], "blocks": [] }
}
```

### PATCH /features/:id

Update feature fields. Supports optimistic locking via `version`.

**Request:**

```json
{
  "title": "Updated title",
  "description": "Updated description",
  "priority": "critical",
  "version": 3
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `title` | string | no | 1-200 chars |
| `description` | string | no | max 5000 chars |
| `acceptanceCriteria` | string | no | max 5000 chars |
| `priority` | enum | no | `low`, `medium`, `high`, `critical` |
| `labels` | string[] | no | Feature labels |
| `dueAt` | datetime/null | no | Due date |
| `slaMinutes` | integer/null | no | SLA in minutes |
| `version` | integer | no | Optimistic lock version |

If `version` is provided and doesn't match the current version, returns `409` with version conflict details.

**Response `200`:**

```json
{
  "feature": { "id": "feat-uuid", "version": 4, "..." }
}
```

### DELETE /features/:id

Delete a feature and all its tasks (cascading delete). Fails if other features depend on this one.

**Response `204`:** No content.

**Response `409`:** Feature has dependent features.

```json
{
  "error": "Feature has dependent features",
  "dependents": true
}
```

### POST /features/:id/move

Manually move a feature to a different column (overrides auto-advancement).

**Request:**

```json
{
  "columnId": "col-uuid"
}
```

**Response `200`:**

```json
{
  "feature": { "id": "feat-uuid", "columnId": "col-uuid", "..." }
}
```

### POST /features/:id/archive

Archives a feature. Features can only be archived if their status is `done`.
Archived features are hidden from default board queries but are kept for analytics and history.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "success": true
}
```

**Response `400`:**

```json
{
  "error": "Only 'done' features can be archived"
}
```

### POST /features/:id/unarchive

Restores an archived feature back to active status.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "success": true
}
```

### GET /features/:id/tasks

List all tasks within a feature.

**Response `200`:**

```json
{
  "tasks": [
    {
      "id": "task-uuid",
      "featureId": "feat-uuid",
      "title": "Create JWT middleware",
      "status": "pending",
      "priority": "high",
      "assignedAgentId": null,
      "requiredDomain": "backend",
      "requiredCapabilities": ["typescript", "nodejs"],
      "estimatedMinutes": 60,
      "order": 0,
      "createdBy": "admin",
      "createdAt": "...",
      "updatedAt": "...",
      "version": 1
    }
  ],
  "total": 5
}
```

### POST /features/:id/tasks

Create a task within a feature. Triggers feature status recalculation.

**Request:**

```json
{
  "title": "Add refresh token rotation",
  "description": "Implement refresh token rotation with 7-day expiry",
  "priority": "medium",
  "requiredDomain": "backend",
  "requiredCapabilities": ["typescript", "postgresql"],
  "estimatedMinutes": 120,
  "order": 3
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `title` | string | yes | 1-200 chars |
| `description` | string | no | max 5000 chars |
| `priority` | enum | no | `low`, `medium`, `high`, `critical` (default: `medium`) |
| `requiredDomain` | string/null | no | Required agent domain |
| `requiredCapabilities` | string[] | no | Required agent capabilities |
| `estimatedMinutes` | integer/null | no | Estimated duration in minutes |
| `order` | integer | no | Sort order within feature |

**Response `201`:**

```json
{
  "task": { "id": "new-task-uuid", "featureId": "feat-uuid", "status": "pending", "..." }
}
```

### GET /features/:id/progress

Get completion metrics for a feature.

**Response `200`:**

```json
{
  "completed": 2,
  "total": 5,
  "percentage": 40,
  "byStatus": {
    "done": 2,
    "pending": 3
  }
}
```

### POST /features/:id/decompose

AI-powered decomposition of a feature into tasks. The feature must have a description.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "featureId": "feat-uuid",
  "createdTasks": [
    { "id": "task-uuid-1", "title": "Create JWT middleware", "order": 0 },
    { "id": "task-uuid-2", "title": "Add login endpoint", "order": 1 },
    { "id": "task-uuid-3", "title": "Add refresh token rotation", "order": 2 }
  ],
  "message": "Created 3 tasks from feature description"
}
```

**Response `400`:** Feature has no description.

**Response `503`:** AI decomposition not configured.

---

## Tasks

Tasks are work units inside features. Every task belongs to exactly one feature. Tasks use a state machine for their lifecycle but do not flow through columns — that is handled by their parent feature.

### GET /tasks/:id

Get a task by ID.

**Response `200`:**

```json
{
  "task": {
    "id": "task-uuid",
    "featureId": "feat-uuid",
    "title": "Fix authentication bug",
    "description": "JWT tokens are signed using jsonwebtoken v9.0.3 with HS256. Tokens include sub (user ID), username, and role claims, with 24h expiration and issuer validation.",
    "priority": "high",
    "assignedAgentId": null,
    "requiredDomain": "backend",
    "requiredCapabilities": ["typescript", "nodejs"],
    "status": "pending",
    "claimedAt": null,
    "startedAt": null,
    "submittedAt": null,
    "completedAt": null,
    "rejectedCount": 0,
    "rejectionReason": null,
    "result": null,
    "artifacts": [],
    "createdBy": "admin",
    "createdAt": "2026-04-01T00:00:00.000Z",
    "updatedAt": "2026-04-04T12:00:00.000Z",
    "version": 1,
    "estimatedMinutes": null,
    "delegatedToAgentId": null,
    "order": 0,
    "retryPolicy": null,
    "retryCount": 0,
    "nextRetryAt": null
  }
}
```

### GET /tasks/:id/details

Get full task context including parent feature, sibling tasks, and dependencies.

**Response `200`:**

```json
{
  "task": { "id": "...", "title": "...", "status": "...", "..." },
  "feature": {
    "id": "feat-uuid",
    "title": "Implement User Authentication",
    "description": "...",
    "acceptanceCriteria": "..."
  },
  "siblingTasks": [
    { "id": "task-uuid-1", "title": "Create JWT middleware", "status": "done", "result": "..." },
    { "id": "task-uuid-2", "title": "Add login endpoint", "status": "pending" }
  ],
  "dependencies": [],
  "blockedBy": [],
  "blocking": [],
  "boardContext": {
    "name": "Sprint 24",
    "columns": [
      { "name": "Todo", "featureCount": 3 },
      { "name": "In Progress", "featureCount": 2 },
      { "name": "Review", "featureCount": 1 },
      { "name": "Done", "featureCount": 3 }
    ]
  }
}
```

### PATCH /tasks/:id

Update task fields. Supports optimistic locking via `version`.

**Request:**

```json
{
  "title": "Updated title",
  "description": "Updated description",
  "priority": "high",
  "estimatedMinutes": 45,
  "version": 3
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `title` | string | no | 1-200 chars |
| `description` | string | no | max 5000 chars |
| `priority` | enum | no | `low`, `medium`, `high`, `critical` |
| `estimatedMinutes` | integer/null | no | Estimated duration in minutes |
| `delegatedToAgentId` | UUID/null | no | Agent delegated to |
| `retryPolicy` | object/null | no | Retry configuration |
| `retryCount` | integer | no | Current retry count |
| `nextRetryAt` | datetime/null | no | Next retry scheduled at |
| `version` | integer | no | Optimistic lock version |

If `version` is provided and doesn't match the current version, the update fails with `404` ("Task not found or version conflict").

If the parent feature of this task is archived, the update fails with `403` ("Cannot modify a task in an archived feature").

**Response `200`:**

```json
{
  "task": { "id": "...", "version": 4, "..." }
}
```

### DELETE /tasks/:id

Delete a task. Triggers parent feature status recalculation.

**Response `204`:** No content.

**Response `403`:** If the parent feature is archived ("Cannot delete a task in an archived feature").

---

## Batch Operations

### POST /boards/:boardId/tasks/batch

Perform batch operations on multiple tasks within features. Tasks no longer have columns — column management is at the feature level.

**Auth:** JWT required (human)

**Request:**

```json
{
  "taskIds": ["task-uuid-1", "task-uuid-2"],
  "operation": "priority",
  "payload": { "priority": "high" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskIds` | UUID[] | yes | Target task IDs (1-100) |
| `operation` | enum | yes | `priority`, `assign`, `delete` |
| `payload` | object | conditional | Parameters for the operation |

**Operation Payloads:**

| Operation | Payload | Description |
|-----------|---------|-------------|
| `priority` | `{ priority: "low" \| "medium" \| "high" \| "critical" }` | Update priority for all tasks |
| `assign` | `{ assignedAgentId: "agent-uuid" }` | Assign all tasks to an agent |
| `delete` | `{}` | Delete all specified tasks |

> **Note:** Tasks belong to the parent feature and do not carry `columnId`. Column movement is managed at the feature level via `POST /features/:id/move`.

**Response `200`:**

```json
{
  "successCount": 2,
  "failureCount": 0,
  "results": [
    { "taskId": "task-uuid-1", "success": true, "task": { "..." } },
    { "taskId": "task-uuid-2", "success": true, "task": { "..." } }
  ]
}
```

---

## Task Lifecycle

### POST /tasks/:id/claim

Atomically claim a task for an agent.

**Auth:** Agent auth required (`X-Agent-API-Key`). The agent identity is derived from the API key — the `agentId` body field is ignored when agent auth is present.

**Request:**

```json
{
  "agentId": "agent-uuid"
}
```

If using agent auth, the `agentId` from the API key is used automatically.

**Response `200` (success):**

```json
{
  "task": { "id": "...", "status": "claimed", "assignedAgentId": "agent-uuid", "..." }
}
```

**Response `409` (failure):**

```json
{
  "error": "already_claimed"
}
```

Failure reasons: `already_claimed`, `not_found`, `domain_mismatch`, `dependencies_unmet`

### POST /tasks/:id/start

Start working on a claimed task.

**Auth:** Agent auth required. The agent must be the assigned agent for this task.

**Response `200`:**

```json
{
  "task": { "id": "...", "status": "in_progress", "startedAt": "2026-04-04T12:00:00Z", "..." }
}
```

**Response `409`:**

```json
{
  "error": "Cannot start task in current state"
}
```

### POST /tasks/:id/submit

Submit completed work for pod review. Triggers parent feature status recalculation.

**Auth:** Agent auth required. The agent must be the assigned agent for this task.

**Request:**

```json
{
  "result": "Fixed the authentication bug by replacing base64 encoding with proper JWT signing using RS256.",
  "artifacts": [
    { "type": "pr", "url": "https://github.com/org/repo/pull/42", "description": "Fix JWT auth implementation" },
    { "type": "commit", "url": "https://github.com/org/repo/commit/abc123", "description": "Add jsonwebtoken dependency" }
  ]
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `result` | string | yes | 1-10000 chars |
| `artifacts` | array | no | Artifact objects |

**Artifact types:** `file`, `pr`, `commit`, `log`, `screenshot`

**Response `200`:**

```json
{
  "success": true,
  "task": {
    "id": "...",
    "status": "submitted",
    "submittedAt": "2026-04-04T12:30:00Z"
  },
  "message": "Task submitted for review."
}
```

### POST /tasks/:id/complete

Complete a submitted or approved task with quality gate enforcement. This is the **gated** completion path — validates quality gates, dependencies, and calculates time tracking metrics before transitioning.

**Auth:** Agent auth required

**Request:**

```json
{
  "reviewNote": "Code reviewed and approved. All tests pass.",
  "artifacts": [
    { "type": "pr", "url": "https://github.com/org/repo/pull/42", "description": "Fix JWT auth" }
  ],
  "skipQualityGates": false
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `reviewNote` | string | no | Review summary |
| `artifacts` | array | no | Artifact objects |
| `skipQualityGates` | boolean | no | Bypass quality checks (default: false) |

**Response `200`:**

```json
{
  "success": true,
  "task": { "id": "...", "status": "done", "completedAt": "2026-04-04T12:30:00Z" },
  "message": "Task completed and moved to done."
}
```

**Response `422` (blocked or quality gates not met):**

```json
{
  "error": "TASK_BLOCKED_BY_DEPENDENCIES",
  "blockedBy": [{ "taskId": "...", "title": "...", "status": "pending" }]
}
```

```json
{
  "error": "QUALITY_GATES_NOT_MET",
  "missingQualityItems": [{ "category": "Testing", "missingItems": ["Unit tests required"] }]
}
```

### POST /tasks/:id/approve

Approve a submitted task. **Does not check quality gates** — this is a pod member override path. For gate-checked completion, use `POST /tasks/:id/complete` instead.

**Auth:** JWT auth required. Only pod members with JWT tokens can approve tasks.

**Request:**

```json
{
  "reviewerId": "admin"
}
```

**Response `200`:**

```json
{
  "task": { "id": "...", "status": "approved", "..." }
}
```

### POST /tasks/:id/reject

Reject a submitted task, sending it back for rework.

**Auth:** JWT auth required. Only pod members can reject tasks.

**Request:**

```json
{
  "reviewerId": "admin",
  "reason": "The JWT implementation still uses base64 encoding. Please use proper RS256 signing."
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `reviewerId` | string | yes | min 1 char |
| `reason` | string | yes | 1-1000 chars |

**Response `200`:**

```json
{
  "task": { "id": "...", "status": "rejected", "rejectionReason": "...", "rejectedCount": 1, "..." }
}
```

The task is moved back to the "In Progress" column if it exists.

### POST /tasks/:id/release

Release a task back to the pod. Only the assigned orcy or a pod member can release.

**Auth:** Agent auth required (assigned agent) or human auth.

**Request:**

```json
{
  "reason": "blocked_by_dependency"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `reason` | string | yes | 1-500 chars |

**Response `200`:**

```json
{
  "task": { "id": "...", "status": "pending", "assignedAgentId": null, "..." }
}
```

### POST /tasks/:id/fail

Mark a task as failed.

**Auth:** Agent auth required (`X-Agent-API-Key` header)

**Request:**

```json
{
  "reason": "Cannot resolve dependency conflict between packages X and Y"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `reason` | string | yes | 1-500 chars |

**Response `200`:**

```json
{
  "task": { "id": "...", "status": "failed", "..." }
}
```

### POST /tasks/:id/unblock

Signal that a task's dependency has been resolved.

**Response `200`:**

```json
{
  "success": true
}
```

---

## Time Tracking & Estimation

Time tracking is heartbeat-based: agents record work intervals via their heartbeat, and the system aggregates total time per task and per feature.

### GET /tasks/:id/time-report

Get the time report for a task, including estimated vs actual minutes, cycle/lead time, and heartbeat history.

**Auth:** Agent or Human

**Response `200`:**

```json
{
  "taskId": "task-uuid",
  "estimatedMinutes": 120,
  "actualMinutes": 95,
  "cycleTimeMinutes": 180,
  "leadTimeMinutes": 90,
  "estimationAccuracy": 0.79,
  "heartbeatHistory": [
    {
      "id": "record-uuid",
      "taskId": "task-uuid",
      "agentId": "agent-uuid",
      "minutesSpent": 30,
      "recordedAt": "2026-04-26T01:00:00.000Z",
      "statusDuringWork": "in_progress"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `estimatedMinutes` | number/null | Original estimate |
| `actualMinutes` | number/null | Sum of all heartbeat-recorded minutes |
| `cycleTimeMinutes` | number/null | Total time from creation to completion |
| `leadTimeMinutes` | number/null | Time from first start to completion |
| `estimationAccuracy` | number/null | Ratio: `actualMinutes / estimatedMinutes` (1.0 = perfect) |
| `heartbeatHistory` | array | Individual time records from agent heartbeats |

**Response `404`:** Task not found.

### PUT /tasks/:id/estimate

Set or update the time estimate for a task.

**Auth:** Agent or Human

**Request:**

```json
{
  "estimatedMinutes": 120
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `estimatedMinutes` | number | yes | Must be >= 0 |

**Response `200`:**

```json
{
  "task": { "id": "task-uuid", "estimatedMinutes": 120, "..." }
}
```

### GET /boards/:id/metrics

Get board-wide time tracking and estimation metrics, including per-agent breakdowns.

**Response `200`:**

```json
{
  "averageCycleTime": 145,
  "averageLeadTime": 95,
  "averageEstimationAccuracy": 0.85,
  "totalPlannedMinutes": 1200,
  "totalActualMinutes": 1050,
  "overdueTasks": 2,
  "onTimeCompletionRate": 0.88,
  "agentMetrics": [
    {
      "agentId": "agent-uuid",
      "agentName": "claude-dev",
      "tasksCompleted": 12,
      "averageCycleTime": 130,
      "averageEstimationAccuracy": 0.92,
      "totalTimeTracked": 480
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `averageCycleTime` | number | Avg minutes from creation to completion across all tasks |
| `averageLeadTime` | number | Avg minutes from start to completion |
| `averageEstimationAccuracy` | number | Avg ratio of actual/estimated across tasks with estimates |
| `totalPlannedMinutes` | number | Sum of all task estimates |
| `totalActualMinutes` | number | Sum of all recorded work |
| `overdueTasks` | number | Tasks exceeding their estimate |
| `onTimeCompletionRate` | number | Fraction of tasks completed within estimate |
| `agentMetrics` | array | Per-agent breakdown |

---

## Quality Gates

Quality gates enforce checklists that must be completed before a task can be approved. Templates define reusable checklist structures; tasks get their own checklist instances.

### GET /tasks/:id/quality-checklist

Get the quality report for a task, including all checklists, item completion status, and whether the task can be approved.

**Auth:** Agent or Human

**Response `200`:**

```json
{
  "taskId": "task-uuid",
  "overallStatus": "incomplete",
  "canApprove": false,
  "checklists": [
    {
      "id": "checklist-uuid",
      "templateId": "template-uuid",
      "templateName": "Code Review",
      "category": "code_quality",
      "required": true,
      "status": "pending",
      "progress": { "total": 3, "completed": 1 },
      "items": [
        {
          "id": "item-uuid",
          "title": "All tests pass",
          "required": true,
          "isCompleted": true,
          "completedBy": "agent-uuid",
          "completedAt": "2026-04-26T01:00:00.000Z",
          "evidenceUrl": "https://github.com/repo/actions/runs/123",
          "notes": "CI passed on commit abc123"
        }
      ]
    }
  ],
  "missingRequirements": [
    { "category": "code_quality", "missingItems": ["Code reviewed by peer", "No lint warnings"] }
  ]
}
```

### PUT /tasks/:id/quality-checklist/:checklistId/items/:itemId

Update a checklist item (mark complete, add evidence, add notes).

**Auth:** Agent or Human

**Request:**

```json
{
  "isCompleted": true,
  "evidenceUrl": "https://github.com/repo/actions/runs/123",
  "notes": "All 42 tests pass"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `isCompleted` | boolean | no | Mark item as complete/incomplete |
| `evidenceUrl` | string | no | Link to evidence (CI run, PR, etc.) |
| `notes` | string | no | Free-text notes |

**Response `200`:** Updated checklist item.

**Response `404`:** Checklist item not found.

### POST /tasks/:id/quality-checklist/validate

Validate all quality gates for a task. Returns whether all required items are complete.

**Auth:** Agent or Human

**Response `200`:**

```json
{
  "passed": false,
  "failures": [
    { "category": "code_quality", "missingItems": ["Code reviewed by peer"] }
  ]
}
```

### GET /tasks/:id/approval-status

Get a comprehensive approval readiness check including quality gates, dependencies, and time tracking.

**Auth:** Agent or Human

**Response `200`:**

```json
{
  "canBeApproved": false,
  "reasons": ["QUALITY_GATES_INCOMPLETE", "DEPENDENCIES_PENDING"],
  "requirements": {
    "qualityChecklist": { "status": "incomplete", "completed": 2, "total": 5 },
    "dependencies": { "status": "blocked" },
    "timeTracking": { "status": "complete" }
  }
}
```

| Reason Code | Meaning |
|-------------|---------|
| `QUALITY_GATES_INCOMPLETE` | Required checklist items not yet completed |
| `DEPENDENCIES_PENDING` | Task depends on other tasks that aren't done/approved |
| `TIME_TRACKING_INCOMPLETE` | Task has an estimate but no recorded work time |
| `TASK_NOT_FOUND` | Task ID is invalid |

### GET /quality/templates

List all quality checklist templates.

**Response `200`:**

```json
{
  "templates": [
    {
      "id": "template-uuid",
      "name": "Code Review Checklist",
      "description": "Standard code review gates",
      "category": "code_quality",
      "isRequired": true,
      "createdAt": "2026-04-01T00:00:00.000Z",
      "updatedAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

### POST /quality/templates

Create a new quality checklist template.

**Auth:** JWT required (human)

**Request:**

```json
{
  "name": "Security Review",
  "description": "Security-focused review checklist",
  "category": "security",
  "isRequired": true,
  "items": [
    { "title": "No hardcoded secrets", "description": "Check for API keys, passwords, tokens", "required": true },
    { "title": "Input validation", "description": "All user inputs are validated/sanitized", "required": true },
    { "title": "OWASP top 10 review", "required": false }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Template name |
| `description` | string | no | Template description |
| `category` | string | yes | Category grouping (e.g., `code_quality`, `security`, `testing`) |
| `isRequired` | boolean | no | Whether this checklist is required for approval (default: true) |
| `items` | array | yes | Checklist items (min 1) |
| `items[].title` | string | yes | Item title |
| `items[].description` | string | no | Item description |
| `items[].required` | boolean | no | Whether this item is required (default: true) |

**Response `200`:**

```json
{
  "template": { "id": "template-uuid", "name": "Security Review", "..." }
}
```

---

## Task Events

### GET /tasks/:id/events

Get the audit trail for a task.

**Query Parameters:**

| Param | Type | Default | Constraints |
|-------|------|---------|-------------|
| `limit` | integer | 50 | 1-200 |
| `offset` | integer | 0 | >= 0 |

**Response `200`:**

```json
{
  "events": [
    {
      "id": "event-uuid",
      "taskId": "task-uuid",
      "actorType": "agent",
      "actorId": "agent-uuid",
      "action": "claimed",
      "fromColumnId": null,
      "toColumnId": "col-uuid",
      "fromStatus": "pending",
      "toStatus": "claimed",
      "metadata": {},
      "timestamp": "2026-04-04T12:00:00.000Z"
    }
  ],
  "total": 15
}
```

### Event Actions

| Action | Actor Type | Description |
|--------|-----------|-------------|
| `created` | human | Task created |
| `claimed` | agent/system | Task claimed by an agent |
| `started` | agent | Agent began working |
| `submitted` | agent | Work submitted for review |
| `approved` | human/system | Task approved |
| `rejected` | human/system | Task sent back for rework |
| `completed` | human/system | Task marked done |
| `failed` | agent | Task failed |
| `released` | human/agent/system | Task released back to pending |
| `dependency_resolved` | system | Dependency unblocked |
| `commented` | human/agent | Comment added to task |
| `board.created` | human/system | Board created |
| `board.updated` | human/system | Board updated |
| `board.deleted` | human/system | Board deleted |
| `column.created` | human/system | Column created |
| `column.updated` | human/system | Column updated |
| `column.deleted` | human/system | Column deleted |

Feature events (`feature_events` table) use a separate set of actions:

| Action | Description |
|--------|-------------|
| `created` | Feature created |
| `updated` | Feature updated |
| `moved` | Feature moved between columns |
| `status_changed` | Feature status derived from tasks |
| `completed` | Feature completed |
| `deleted` | Feature deleted |
| `dependency_resolved` | Feature dependency resolved |

---

## Task Comments

### GET /tasks/:id/comments

Get all comments on a task.

**Response `200`:**

```json
{
  "comments": [
    {
      "id": "comment-uuid",
      "taskId": "task-uuid",
      "parentId": null,
      "authorType": "human",
      "authorId": "user-uuid",
      "authorName": "admin",
      "content": "Make sure to handle edge cases for empty input.",
      "createdAt": "2026-04-04T10:00:00.000Z",
      "updatedAt": "2026-04-04T10:00:00.000Z"
    }
  ],
  "total": 1
}
```

### POST /tasks/:id/comments

Add a comment to a task.

**Auth:** JWT (human) or API key (agent)

**Request:**

```json
{
  "content": "This approach looks good, but please add unit tests.",
  "parentId": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Comment content (markdown supported), 1-5000 chars |
| `parentId` | UUID/null | no | Parent comment ID for threading |

**Response `201`:**

```json
{
  "comment": {
    "id": "comment-uuid",
    "taskId": "task-uuid",
    "parentId": null,
    "authorType": "human",
    "authorId": "user-uuid",
    "authorName": "admin",
    "content": "This approach looks good, but please add unit tests.",
    "createdAt": "2026-04-04T10:30:00.000Z",
    "updatedAt": "2026-04-04T10:30:00.000Z"
  }
}
```

### PATCH /comments/:id

Update a comment (author only).

**Auth:** JWT (human) or API key (agent) — must match original author

**Request:**

```json
{
  "content": "Updated comment text."
}
```

**Response `200`:**

```json
{
  "comment": { "id": "...", "content": "Updated comment text.", "..." }
}
```

### DELETE /comments/:id

Delete a comment (author or admin only).

**Auth:** JWT required (human)

**Response `204`:** No content.

---

## Agents

### GET /agents

List all registered agents.

**Response `200`:**

```json
{
  "agents": [
    {
      "id": "agent-uuid",
      "name": "claude-dev",
      "type": "claude-code",
      "domain": "backend",
      "capabilities": ["typescript", "nodejs"],
      "status": "idle",
      "currentTaskId": null,
      "createdAt": "2026-04-01T00:00:00.000Z",
      "lastHeartbeat": "2026-04-04T12:00:00.000Z",
      "metadata": {}
    }
  ]
}
```

### POST /agents

Register a new agent. The API key is shown only once in the response.

**Request:**

```json
{
  "name": "claude-dev",
  "type": "claude-code",
  "domain": "backend",
  "capabilities": ["typescript", "nodejs", "fastify"]
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | yes | 1-50 chars |
| `type` | enum | yes | `claude-code`, `codex`, `opencode` |
| `domain` | string | yes | 1-50 chars |
| `capabilities` | string[] | no | Skill tags |
| `metadata` | object | no | Arbitrary metadata |

**Response `201`:**

```json
{
  "agent": { "id": "agent-uuid", "name": "claude-dev", "..." },
  "apiKey": "550e8400-e29b-41d4-a716-446655440000-a1b2c3d4e5f67890a1b2c3d4e5f67890"
}
```

> **Important:** Save the `apiKey` immediately. It cannot be retrieved later.

### GET /agents/:id

Get agent details with current task.

**Response `200`:**

```json
{
  "agent": { "id": "...", "name": "claude-dev", "status": "working", "..." },
  "currentTask": { "id": "task-uuid", "title": "...", "status": "in_progress" }
}
```

### PATCH /agents/:id

Update agent properties.

**Request:**

```json
{
  "domain": "frontend",
  "capabilities": ["react", "typescript", "css"]
}
```

**Response `200`:**

```json
{
  "agent": { "id": "...", "domain": "frontend", "..." }
}
```

### DELETE /agents/:id

Delete an agent.

**Response `204`:** No content.

### POST /agents/:id/heartbeat

Send a keep-alive signal.

**Auth:** Agent auth required

**Request:**

```json
{
  "taskId": "task-uuid",
  "progress": "50% complete, implementing JWT signing"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | UUID | no | Currently active task |
| `progress` | string | no | Progress description |

**Response `200`:**

```json
{
  "status": "working",
  "nextCheckIn": 300,
  "taskStatus": "in_progress"
}
```

`nextCheckIn` is the recommended interval in seconds before the next heartbeat. `taskStatus` is the current status of the task specified in the `taskId` field (or `null` if no task was specified). Tasks idle for > 30 minutes without a heartbeat are auto-released.

### GET /agents/:id/stats

Get performance statistics for an agent.

**Response `200`:**

```json
{
  "completed": 12,
  "failed": 2,
  "rejected": 3,
  "avgCycleTimeMinutes": 47.5,
  "rejectionRate": 0.2,
  "currentStreak": 5,
  "throughputToday": 2,
  "throughputThisWeek": 8,
  "totalArtifacts": 15
}
```

| Field | Type | Description |
|-------|------|-------------|
| `completed` | integer | Total tasks completed (approved) |
| `failed` | integer | Total tasks that failed |
| `rejected` | integer | Total tasks sent back for rework |
| `avgCycleTimeMinutes` | number | Average time from claim to approve (minutes) |
| `rejectionRate` | number | Fraction of submissions that were rejected |
| `currentStreak` | integer | Consecutive completed tasks without rejection |
| `throughputToday` | integer | Tasks completed today |
| `throughputThisWeek` | integer | Tasks completed this week |
| `totalArtifacts` | integer | Total artifacts across all submissions |

---

## Agent Messages

Send and receive messages to/from agents.

### POST /agents/:agentId/messages

Send a message to an agent.

**Auth:** JWT required (human)

**Request:**

```json
{
  "content": "Please prioritize the authentication task.",
  "taskId": "task-uuid"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Message content, 1-5000 chars |
| `taskId` | UUID/null | no | Related task ID |

**Response `201`:**

```json
{
  "message": {
    "id": "message-uuid",
    "agentId": "agent-uuid",
    "taskId": "task-uuid",
    "content": "Please prioritize the authentication task.",
    "read": false,
    "createdAt": "2026-04-04T12:00:00.000Z"
  }
}
```

### GET /agents/:agentId/messages

Get messages for an agent.

**Auth:** JWT required (human)

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `unreadOnly` | boolean | false | Only return unread messages |
| `taskId` | UUID | — | Filter by task |
| `limit` | integer | 50 | Results (1-100) |
| `offset` | integer | 0 | Skip results |

**Response `200`:**

```json
{
  "messages": [
    {
      "id": "message-uuid",
      "agentId": "agent-uuid",
      "taskId": "task-uuid",
      "content": "Please prioritize the authentication task.",
      "read": false,
      "createdAt": "2026-04-04T12:00:00.000Z"
    }
  ],
  "total": 1,
  "unreadCount": 1
}
```

### PUT /agents/messages/:id/read

Mark a message as read.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "message": { "id": "...", "read": true, "..." }
}
```

### PUT /agents/:agentId/messages/read-all

Mark all messages for an agent as read.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "updated": 5
}
```

### DELETE /agents/messages/:id

Delete a message.

**Auth:** JWT required (human)

**Response `204`:** No content.

---

---

## Pulse (Mission Signals)

Structured signal system for agent-to-agent and human-to-agent communication within missions. Signals are mission-scoped, typed, and surfaced automatically in mission context.

**Auth:** `agentOrHumanAuth` (X-Agent-API-Key or Bearer token)

### POST /missions/:missionId/pulse

Post a signal to a mission pulse board.

```
POST /api/missions/mission-uuid/pulse
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `signalType` | string | yes | One of: finding, blocker, offer, warning, question, answer, directive, context, handoff |
| `subject` | string | yes | Brief signal subject (max 200 chars) |
| `body` | string | no | Full signal body with details |
| `taskId` | UUID | no | Related task |
| `toAgentId` | UUID | no | Target specific agent |
| `toAgentName` | string | no | Target agent name (resolved to UUID) |
| `replyToId` | UUID | no | Signal ID to reply to (for threading) |
| `metadata` | object | no | Freeform metadata |

When `signalType` is `blocker`, the system auto-creates a `"Clear Blocker: {subject}"` task with `blocker-clearance` label in the same mission.

**Response `201`:**

```json
{
  "pulse": {
    "id": "pulse-uuid",
    "missionId": "mission-uuid",
    "boardId": "board-uuid",
    "fromType": "agent",
    "fromId": "agent-uuid",
    "toType": null,
    "toId": null,
    "signalType": "finding",
    "subject": "Token format changed to JWT v3",
    "body": "See auth/token.ts L42",
    "taskId": null,
    "replyToId": null,
    "linkedTaskId": null,
    "metadata": {},
    "createdAt": "2026-05-10T12:00:00.000Z",
    "pinned": 0,
    "isAuto": false
  },
  "linkedTask": null
}
```

### GET /missions/:missionId/pulse

List signals for a mission. Paginated, newest first.

```
GET /api/missions/mission-uuid/pulse?signalType=finding&limit=20&offset=0
```

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `signalType` | string | — | Filter by signal type |
| `isAuto` | boolean | — | Filter auto vs intentional signals |
| `since` | ISO date | — | Signals after this timestamp |
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |

**Response `200`:**

```json
{
  "pulses": [ /* array of Pulse objects */ ],
  "total": 15
}
```

### GET /missions/:missionId/pulse/digest

Get a compact pulse digest with type counts, highlights, and unread count. Updates the caller's `pulse_cursors` timestamp (marking as read).

```
GET /api/missions/mission-uuid/pulse/digest
```

**Response `200`:**

```json
{
  "summary": "Token format changed to JWT v3. 2 more signals.",
  "newSinceLastCheck": 4,
  "counts": {
    "finding": 6,
    "blocker": 1,
    "offer": 2,
    "warning": 3,
    "question": 0,
    "answer": 0,
    "directive": 2,
    "context": 5,
    "handoff": 0
  },
  "highlights": [
    {
      "id": "pulse-uuid",
      "signalType": "blocker",
      "from": { "type": "agent", "name": "agent-id" },
      "subject": "Missing REDIS_URL env var",
      "linkedTaskId": "clearance-task-uuid",
      "createdAt": "2026-05-10T12:00:00.000Z"
    }
  ]
}
```

This digest is automatically included in `mission_get_context()` responses.

### GET /pulse/inbox

Cross-mission inbox showing all signals targeted at the authenticated caller.

```
GET /api/pulse/inbox?signalType=blocker&limit=20
```

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `signalType` | string | — | Filter by type |
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |

**Response `200`:**

```json
{
  "pulses": [ /* array of Pulse objects */ ],
  "total": 3
}
```

### DELETE /pulse/:id

Delete a signal. Author-only.

```
DELETE /api/pulse/pulse-uuid
```

**Response `204`:** No content.

### GET /pulse/:id/replies

Get threaded replies to a signal.

```
GET /api/pulse/pulse-uuid/replies
```

**Response `200`:**

```json
{
  "replies": [ /* array of Pulse objects ordered newest first */ ]
}
```

---

## Pulse — Habitat Signals

Habitat-level signals are board-scoped broadcasts visible to all agents and humans on the habitat. Use `scope: "habitat"` with a `boardId` instead of `missionId`.

### POST /boards/:boardId/pulse

Post a habitat-level signal. Works identically to mission signals but scoped to the board.

**Auth:** `agentOrHumanAuth`

**Request:**

```json
{
  "signalType": "finding",
  "subject": "New staging environment URL",
  "body": "Staging is now at staging-v2.example.com",
  "scope": "habitat",
  "taskId": null,
  "toAgentId": null,
  "toAgentName": null,
  "replyToId": null,
  "metadata": {}
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `signalType` | string | yes | One of: finding, blocker, offer, warning, question, answer, directive, context, handoff |
| `subject` | string | yes | Brief signal subject (max 200 chars) |
| `body` | string | no | Full signal body |
| `scope` | string | no | `"habitat"` (default: `"mission"`) |
| `taskId` | UUID | no | Related task |
| `toAgentId` | UUID | no | Target specific agent |
| `toAgentName` | string | no | Target agent name |
| `replyToId` | UUID | no | Signal ID to reply to |
| `metadata` | object | no | Freeform metadata |

**Response `201`:**

```json
{
  "pulse": {
    "id": "pulse-uuid",
    "missionId": null,
    "boardId": "board-uuid",
    "scope": "habitat",
    "fromType": "agent",
    "fromId": "agent-uuid",
    "signalType": "finding",
    "subject": "New staging environment URL",
    "body": "Staging is now at staging-v2.example.com",
    "createdAt": "2026-05-12T12:00:00.000Z",
    "pinned": 0,
    "isAuto": false
  }
}
```

### GET /boards/:boardId/pulse

List habitat-level signals for a board.

**Auth:** `agentOrHumanAuth`

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `signalType` | string | — | Filter by signal type |
| `scope` | string | `"habitat"` | Filter by scope (`habitat` or `mission`) |
| `isAuto` | boolean | — | Filter auto vs intentional |
| `since` | ISO date | — | Signals after this timestamp |
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |

**Response `200`:**

```json
{
  "pulses": [ /* array of Pulse objects */ ],
  "total": 8
}
```

### GET /boards/:boardId/pulse/digest

Get a compact pulse digest for the habitat. Includes type counts, highlights, and unread count across all scopes.

**Auth:** `agentOrHumanAuth`

**Response `200`:**

```json
{
  "summary": "New staging URL. 3 habitat signals.",
  "newSinceLastCheck": 2,
  "counts": {
    "finding": 4,
    "blocker": 0,
    "offer": 1,
    "warning": 1,
    "context": 2
  },
  "highlights": [
    {
      "id": "pulse-uuid",
      "signalType": "directive",
      "scope": "habitat",
      "from": { "type": "human", "name": "admin" },
      "subject": "Deploy freeze until Friday",
      "createdAt": "2026-05-12T10:00:00.000Z"
    }
  ]
}
```

---

## Project Insights

Institutional memory for the habitat. Insights are promoted from signals and persist across missions.

### POST /boards/:boardId/insights

Create a project insight. Typically promoted from a high-value signal.

**Auth:** `agentOrHumanAuth`

**Request:**

```json
{
  "title": "Auth token format is JWT v3 with RS256",
  "body": "All auth tokens use RS256 signing since 2026-05-01. See auth/token.ts L42.",
  "source": "signal",
  "sourcePulseId": "pulse-uuid",
  "relevanceTags": ["auth", "security", "tokens"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Insight title (max 200 chars) |
| `body` | string | no | Full insight body |
| `source` | string | no | Source type (`signal`, `manual`, `auto`) |
| `sourcePulseId` | UUID | no | Originating pulse signal |
| `relevanceTags` | string[] | no | Tags for relevance matching |

**Response `201`:**

```json
{
  "insight": {
    "id": "insight-uuid",
    "boardId": "board-uuid",
    "title": "Auth token format is JWT v3 with RS256",
    "body": "All auth tokens use RS256 signing since 2026-05-01...",
    "source": "signal",
    "sourcePulseId": "pulse-uuid",
    "relevanceTags": ["auth", "security", "tokens"],
    "createdBy": "agent-uuid",
    "createdAt": "2026-05-12T12:00:00.000Z",
    "updatedAt": "2026-05-12T12:00:00.000Z"
  }
}
```

### GET /boards/:boardId/insights

List project insights for a habitat. Optionally filter by relevance tags.

**Auth:** `agentOrHumanAuth`

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `tags` | string | — | Comma-separated relevance tags to match |
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |

**Response `200`:**

```json
{
  "insights": [
    {
      "id": "insight-uuid",
      "boardId": "board-uuid",
      "title": "Auth token format is JWT v3 with RS256",
      "body": "...",
      "relevanceTags": ["auth", "security"],
      "source": "signal",
      "createdBy": "agent-uuid",
      "createdAt": "2026-05-12T12:00:00.000Z"
    }
  ],
  "total": 3
}
```

### DELETE /boards/:boardId/insights/:id

Delete a project insight. Author-only.

**Auth:** `agentOrHumanAuth`

**Response `204`:** No content.

---

## Signal Reactions

Toggle-based reactions on pulse signals. Three fixed reaction types: `seen`, `ack`, `question`.

### POST /api/pulse/:id/react

Toggle a reaction on a signal. If the reaction already exists, it is removed (toggle off). If it does not exist, it is created (toggle on).

**Auth:** `agentOrHumanAuth`

**Request:**

```json
{
  "reaction": "ack"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reaction` | string | yes | One of: `seen`, `ack`, `question` |

**Response `200`:**

```json
{
  "active": true,
  "reaction": {
    "id": "reaction-uuid",
    "pulseId": "pulse-uuid",
    "reactorType": "agent",
    "reactorId": "agent-uuid",
    "reaction": "ack",
    "createdAt": "2026-05-12T12:00:00.000Z"
  }
}
```

When toggled off (`active: false`), the reaction was removed and the `reaction` field contains `null`.

---

Templates provide pre-defined feature structures for consistent feature creation. Each template can include a `tasksTemplate` array defining child tasks that are automatically created when the template is used.

### GET /templates

List all templates. Returns global templates (boardId=null) and board-specific templates.

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `boardId` | UUID | Filter to board-specific templates only |

**Response `200`:**

```json
{
  "templates": [
    {
      "id": "template-uuid",
      "boardId": null,
      "name": "Bug Fix",
      "titlePattern": "Fix: ",
      "descriptionPattern": "## Steps to Reproduce\n\n## Expected Behavior\n\n## Actual Behavior\n\n## Root Cause\n",
      "priority": "high",
      "labels": ["bug"],
      "requiredDomain": null,
      "requiredCapabilities": [],
      "isDefault": true,
      "usageCount": 5,
      "tasksTemplate": [],
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

### POST /templates

Create a new template.

**Auth:** JWT required (human)

**Request:**

```json
{
  "name": "Feature Request",
  "titlePattern": "Feature: ",
  "descriptionPattern": "## Overview\n\n## Acceptance Criteria\n\n## Technical Notes\n",
  "priority": "medium",
  "labels": ["feature"],
  "requiredDomain": null,
  "requiredCapabilities": [],
  "isDefault": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Template name, 1-100 chars |
| `titlePattern` | string | yes | Prepended to task title, 0-200 chars |
| `descriptionPattern` | string | no | Markdown template for description |
| `priority` | enum | no | `low`, `medium`, `high`, `critical` |
| `labels` | string[] | no | Default labels |
| `requiredDomain` | string/null | no | Default domain filter |
| `requiredCapabilities` | string[] | no | Default capabilities |
| `isDefault` | boolean | no | Default template shown first |

**Response `201`:**

```json
{
  "template": { "id": "template-uuid", "name": "Feature Request", "..." }
}
```

### PATCH /templates/:id

Update a template.

**Auth:** JWT required (human)

**Request:**

```json
{
  "descriptionPattern": "## Updated Description\n"
}
```

**Response `200`:**

```json
{
  "template": { "id": "...", "descriptionPattern": "## Updated Description\n", "..." }
}
```

### DELETE /templates/:id

Delete a template.

**Auth:** JWT required (human)

**Response `204`:** No content.

---

## Saved Filters

Manage reusable saved filters for boards.

### GET /boards/:boardId/saved-filters

List saved filters for a board.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "savedFilters": [
    {
      "id": "filter-uuid",
      "boardId": "board-uuid",
      "name": "High Priority Tasks",
      "filterConfig": {
        "priority": "high",
        "status": ["pending", "in_progress"]
      },
      "isBuiltIn": false,
      "createdBy": "user-uuid",
      "createdAt": "2026-04-01T00:00:00.000Z",
      "updatedAt": "2026-04-04T12:00:00.000Z"
    }
  ]
}
```

### POST /boards/:boardId/saved-filters

Create a saved filter.

**Auth:** JWT required (human)

**Request:**

```json
{
  "name": "My Open Tasks",
  "filterConfig": {
    "assignedAgentId": "agent-uuid",
    "status": ["pending", "claimed"]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Filter name, 1-100 chars |
| `filterConfig` | object | yes | JSON filter configuration |

**Response `201`:**

```json
{
  "savedFilter": { "id": "filter-uuid", "name": "My Open Tasks", "..." }
}
```

### PUT /saved-filters/:id

Update a saved filter.

**Auth:** JWT required (human)

**Request:**

```json
{
  "name": "Updated Filter Name",
  "filterConfig": { "priority": "critical" }
}
```

**Response `200`:**

```json
{
  "savedFilter": { "id": "...", "name": "Updated Filter Name", "..." }
}
```

**Response `403`:**

```json
{
  "error": "Cannot modify built-in filter"
}
```

### DELETE /saved-filters/:id

Delete a saved filter.

**Auth:** JWT required (human)

**Response `204`:** No content.

**Response `403`:**

```json
{
  "error": "Cannot delete built-in filter"
}
```

---

## Organizations

Manage organizations, teams, and team memberships.

### POST /organizations

Create a new organization.

**Auth:** JWT required (human)

**Request:**

```json
{
  "name": "Engineering",
  "slug": "engineering"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Organization name, 1-100 chars |
| `slug` | string | yes | URL-safe identifier, 1-50 chars |

**Response `201`:**

```json
{
  "organization": {
    "id": "org-uuid",
    "name": "Engineering",
    "slug": "engineering",
    "createdAt": "2026-04-01T00:00:00.000Z"
  }
}
```

### GET /organizations

List all organizations.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "organizations": [
    {
      "id": "org-uuid",
      "name": "Engineering",
      "slug": "engineering",
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

### GET /organizations/:id

Get an organization by ID.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "organization": {
    "id": "org-uuid",
    "name": "Engineering",
    "slug": "engineering",
    "createdAt": "2026-04-01T00:00:00.000Z"
  }
}
```

### POST /organizations/:id/teams

Create a team within an organization.

**Auth:** JWT required (human)

**Request:**

```json
{
  "name": "Backend Team",
  "description": "Backend development team"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Team name, 1-100 chars |
| `description` | string | no | Team description |

**Response `201`:**

```json
{
  "team": {
    "id": "team-uuid",
    "organizationId": "org-uuid",
    "name": "Backend Team",
    "description": "Backend development team",
    "createdAt": "2026-04-01T00:00:00.000Z"
  }
}
```

### GET /organizations/:id/teams

List teams in an organization.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "teams": [
    {
      "id": "team-uuid",
      "organizationId": "org-uuid",
      "name": "Backend Team",
      "description": "Backend development team",
      "memberCount": 5,
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

### GET /teams/:id

Get team details.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "team": {
    "id": "team-uuid",
    "organizationId": "org-uuid",
    "name": "Backend Team",
    "description": "Backend development team",
    "createdAt": "2026-04-01T00:00:00.000Z"
  }
}
```

### DELETE /teams/:id

Delete a team.

**Auth:** JWT required (human)

**Response `204`:** No content.

### POST /teams/:id/members

Add a member to a team.

**Auth:** JWT required (human)

**Request:**

```json
{
  "userId": "user-uuid",
  "role": "member"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | UUID | yes | User ID to add |
| `role` | enum | yes | `admin`, `member`, `viewer` |

**Response `201`:**

```json
{
  "member": {
    "teamId": "team-uuid",
    "userId": "user-uuid",
    "role": "member",
    "joinedAt": "2026-04-04T12:00:00.000Z"
  }
}
```

### GET /teams/:id/members

List team members.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "members": [
    {
      "teamId": "team-uuid",
      "userId": "user-uuid",
      "role": "admin",
      "joinedAt": "2026-04-01T00:00:00.000Z",
      "user": {
        "id": "user-uuid",
        "username": "johndoe"
      }
    }
  ]
}
```

### DELETE /teams/:id/members/:userId

Remove a member from a team.

**Auth:** JWT required (human)

**Response `204`:** No content.

### PATCH /teams/:id/members/:userId

Update a team member's role.

**Auth:** JWT required (human)

**Request:**

```json
{
  "role": "admin"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | enum | yes | `admin`, `member`, `viewer` |

**Response `200`:**

```json
{
  "member": {
    "teamId": "team-uuid",
    "userId": "user-uuid",
    "role": "admin",
    "joinedAt": "2026-04-01T00:00:00.000Z"
  }
}
```

### GET /users/me/teams

Get teams for the current user.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "teams": [
    {
      "id": "team-uuid",
      "organizationId": "org-uuid",
      "name": "Backend Team",
      "description": "Backend development team",
      "role": "admin",
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

---

## Chat Integrations

Configure chat integrations for boards (Slack, Discord, etc.).

### GET /boards/:boardId/chat-integrations

List chat integrations for a board.

**Auth:** JWT required (human, admin only)

**Response `200`:**

```json
{
  "chatIntegrations": [
    {
      "id": "integration-uuid",
      "boardId": "board-uuid",
      "provider": "slack",
      "webhookUrl": "https://hooks.slack.com/services/xxx",
      "channelId": "C0123456789",
      "events": ["task.submitted", "task.approved"],
      "enabled": true,
      "createdAt": "2026-04-01T00:00:00.000Z",
      "updatedAt": "2026-04-04T12:00:00.000Z"
    }
  ]
}
```

### POST /boards/:boardId/chat-integrations

Create a chat integration.

**Auth:** JWT required (human, admin only)

**Request:**

```json
{
  "provider": "slack",
  "webhookUrl": "https://hooks.slack.com/services/xxx",
  "channelId": "C0123456789",
  "botToken": "xoxb-...",
  "events": ["task.submitted", "task.approved", "task.rejected"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | enum | yes | `slack`, `discord` |
| `webhookUrl` | string | yes | Webhook URL for notifications |
| `channelId` | string | no | Provider-specific channel ID |
| `botToken` | string | no | Bot token for interactive features |
| `events` | string[] | no | Event types to send (default: all) |

**Response `201`:**

```json
{
  "chatIntegration": {
    "id": "integration-uuid",
    "provider": "slack",
    "webhookUrl": "https://hooks.slack.com/services/xxx",
    "channelId": "C0123456789",
    "events": ["task.submitted", "task.approved", "task.rejected"],
    "enabled": true,
    "createdAt": "2026-04-01T00:00:00.000Z"
  }
}
```

### PUT /chat-integrations/:id

Update a chat integration.

**Auth:** JWT required (human, admin only)

**Request:**

```json
{
  "webhookUrl": "https://hooks.slack.com/services/yyy",
  "events": ["task.submitted"]
}
```

**Response `200`:**

```json
{
  "chatIntegration": { "id": "...", "webhookUrl": "...", "..." }
}
```

### DELETE /chat-integrations/:id

Delete a chat integration.

**Auth:** JWT required (human, admin only)

**Response `204`:** No content.

### POST /chat-integrations/:id/test

Send a test message to verify the integration.

**Auth:** JWT required (human, admin only)

**Response `200`:**

```json
{
  "success": true,
  "statusCode": 200
}
```

### POST /chat/slack/command

Handle Slack slash commands.

**No authentication required.**

**Request:** `application/x-www-form-urlencoded`

```
command=/orcy
text=list
user_id=U0123456789
```

**Response `200`:**

```json
{
  "response_type": "ephemeral",
  "text": "Here are your tasks..."
}
```

### POST /chat/discord/interaction

Handle Discord interactions.

**No authentication required.**

**Request:**

```json
{
  "type": 1,
  "data": {
    "name": "orcy",
    "options": []
  },
  "member": {
    "user": { "id": "123456789" }
  }
}
```

**Response `200`:**

```json
{
  "type": 4,
  "data": {
    "content": "Here are your tasks..."
  }
}
```

---

## Notification Preferences

Manage notification preferences for users and boards.

### GET /users/me/notification-preferences

Get current user's notification preferences.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "notificationPreferences": {
    "emailEnabled": true,
    "emailOnTaskAssigned": true,
    "emailOnTaskCompleted": true,
    "emailOnTaskRejected": false,
    "emailOnMention": true,
    "webhookUrl": null,
    "webhookEvents": []
  }
}
```

### PUT /users/me/notification-preferences

Update current user's notification preferences.

**Auth:** JWT required (human)

**Request:**

```json
{
  "emailEnabled": true,
  "emailOnTaskAssigned": true,
  "emailOnTaskCompleted": false,
  "webhookUrl": "https://example.com/webhook",
  "webhookEvents": ["task.assigned", "task.completed"]
}
```

**Response `200`:**

```json
{
  "notificationPreferences": {
    "emailEnabled": true,
    "emailOnTaskAssigned": true,
    "emailOnTaskCompleted": false,
    "emailOnTaskRejected": false,
    "emailOnMention": true,
    "webhookUrl": "https://example.com/webhook",
    "webhookEvents": ["task.assigned", "task.completed"]
  }
}
```

### PUT /users/me/email

Update current user's email address.

**Auth:** JWT required (human)

**Request:**

```json
{
  "email": "user@example.com"
}
```

**Response `200`:**

```json
{
  "success": true,
  "email": "user@example.com"
}
```

### GET /boards/:boardId/notification-preferences

Get board-level notification preferences.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "notificationPreferences": {
    "boardId": "board-uuid",
    "channelId": null,
    "notifyOnTaskCreated": true,
    "notifyOnTaskSubmitted": true,
    "notifyOnTaskApproved": true,
    "notifyOnTaskRejected": true,
    "notifyOnTaskAssigned": false
  }
}
```

### PUT /boards/:boardId/notification-preferences

Update board-level notification preferences.

**Auth:** JWT required (human, admin only)

**Request:**

```json
{
  "channelId": "C0123456789",
  "notifyOnTaskCreated": true,
  "notifyOnTaskSubmitted": false
}
```

**Response `200`:**

```json
{
  "notificationPreferences": {
    "boardId": "board-uuid",
    "channelId": "C0123456789",
    "notifyOnTaskCreated": true,
    "notifyOnTaskSubmitted": false,
    "notifyOnTaskApproved": true,
    "notifyOnTaskRejected": true,
    "notifyOnTaskAssigned": false
  }
}
```

---

## Attachments

Upload and manage task attachments.

### POST /tasks/:taskId/attachments

Upload an attachment to a task.

**Auth:** JWT required (human)

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | yes | File to upload (max 50MB) |
| `description` | string | no | File description |

**Response `201`:**

```json
{
  "attachment": {
    "id": "attachment-uuid",
    "taskId": "task-uuid",
    "filename": "screenshot.png",
    "contentType": "image/png",
    "size": 102400,
    "description": "Error screenshot",
    "url": "/api/attachments/attachment-uuid/download",
    "uploadedBy": "user-uuid",
    "createdAt": "2026-04-04T12:00:00.000Z"
  }
}
```

### GET /tasks/:taskId/attachments

List attachments for a task.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "attachments": [
    {
      "id": "attachment-uuid",
      "taskId": "task-uuid",
      "filename": "screenshot.png",
      "contentType": "image/png",
      "size": 102400,
      "description": "Error screenshot",
      "url": "/api/attachments/attachment-uuid/download",
      "uploadedBy": "user-uuid",
      "createdAt": "2026-04-04T12:00:00.000Z"
    }
  ]
}
```

### GET /attachments/:id/download

Download an attachment.

**Auth:** JWT required (human)

**Response `200`:** Binary file data with appropriate `Content-Type` header.

### DELETE /attachments/:id

Delete an attachment.

**Auth:** JWT required (human)

**Response `204`:** No content.

---

## Outgoing Webhooks

Configure webhooks to receive notifications when board events occur.

### GET /webhooks

List all webhook subscriptions.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "subscriptions": [
    {
      "id": "webhook-uuid",
      "boardId": "board-uuid",
      "name": "Slack Notifications",
      "url": "https://hooks.slack.com/services/xxx",
      "events": ["task.submitted", "task.approved", "task.rejected"],
      "format": "slack",
      "enabled": true,
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

### POST /webhooks

Create a webhook subscription.

**Auth:** JWT required (human)

**Request:**

```json
{
  "boardId": "board-uuid",
  "name": "Slack Notifications",
  "url": "https://hooks.slack.com/services/xxx",
  "events": ["task.submitted", "task.approved", "task.rejected"],
  "format": "slack",
  "headers": { "X-Custom-Header": "value" },
  "enabled": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `boardId` | UUID | yes | Board to subscribe to |
| `name` | string | yes | Display name, 1-100 chars |
| `url` | string | yes | Webhook URL (https only) |
| `events` | string[] | yes | Event types to subscribe to |
| `format` | enum | yes | `standard`, `slack`, `discord` |
| `headers` | object | no | Custom HTTP headers |
| `enabled` | boolean | no | default: true |

**Response `201`:**

```json
{
  "subscription": { "id": "webhook-uuid", "secret": "whsec_...", "..." },
  "secret": "whsec_abc123..."
}
```

> **Important:** Save the `secret` immediately — it cannot be retrieved later. It's used for HMAC-SHA256 request signing.

### PATCH /webhooks/:id

Update a webhook subscription.

**Auth:** JWT required (human)

**Request:**

```json
{
  "enabled": false,
  "events": ["task.completed", "task.failed"]
}
```

**Response `200`:**

```json
{
  "subscription": { "id": "...", "enabled": false, "..." }
}
```

### DELETE /webhooks/:id

Delete a webhook subscription.

**Auth:** JWT required (human)

**Response `204`:** No content.

### GET /webhooks/:id/deliveries

Get delivery log for a webhook.

**Auth:** JWT required (human)

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer | 20 | Results (max 100) |
| `status` | enum | — | Filter: `success`, `failed` |

**Response `200`:**

```json
{
  "deliveries": [
    {
      "id": "delivery-uuid",
      "webhookId": "webhook-uuid",
      "eventType": "task.submitted",
      "status": "success",
      "responseStatus": 200,
      "attemptedAt": "2026-04-04T12:00:00.000Z",
      "completedAt": "2026-04-04T12:00:01.000Z"
    }
  ]
}
```

### POST /webhooks/test/:id

Send a test event to verify webhook configuration.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "success": true,
  "statusCode": 200
}
```

---

## CI/CD Webhooks

Receive pipeline events from CI/CD systems.

### POST /webhooks/github-ci

Receive GitHub Actions workflow events.

**No authentication required.**

**Request:**

```json
{
  "action": "completed",
  "workflow": {
    "id": 123456789,
    "name": "CI"
  },
  "repository": {
    "full_name": "org/repo"
  },
  "workflow_run": {
    "id": 987654321,
    "conclusion": "success"
  }
}
```

**Response `200`:**

```json
{
  "received": true
}
```

### POST /webhooks/gitlab-ci

Receive GitLab CI pipeline events.

**No authentication required.**

**Request:**

```json
{
  "object_kind": "pipeline",
  "object_attributes": {
    "id": 123456789,
    "status": "success",
    "ref": "main"
  },
  "project": {
    "path_with_namespace": "org/repo"
  }
}
```

**Response `200`:**

```json
{
  "received": true
}
```

### GET /tasks/:id/pipeline-events

Get pipeline events for a task.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "pipelineEvents": [
    {
      "id": "pipeline-uuid",
      "taskId": "task-uuid",
      "provider": "github",
      "repository": "org/repo",
      "workflowName": "CI",
      "status": "success",
      "conclusion": "success",
      "runId": 987654321,
      "url": "https://github.com/org/repo/actions/runs/987654321",
      "triggeredAt": "2026-04-04T12:00:00.000Z"
    }
  ]
}
```

---

## Code Review Webhooks

Receive pull request / merge request events from code review systems.

### POST /webhooks/github

Receive GitHub pull request events.

**No authentication required.**

**Request:**

```json
{
  "action": "opened",
  "pull_request": {
    "id": 123456789,
    "number": 42,
    "title": "Add authentication",
    "state": "open",
    "html_url": "https://github.com/org/repo/pull/42",
    "user": {
      "login": "developer"
    }
  },
  "repository": {
    "full_name": "org/repo"
  }
}
```

**Response `200`:**

```json
{
  "received": true
}
```

### POST /webhooks/gitlab

Receive GitLab merge request events.

**No authentication required.**

**Request:**

```json
{
  "object_kind": "merge_request",
  "object_attributes": {
    "id": 123456789,
    "iid": 42,
    "title": "Add authentication",
    "state": "opened",
    "url": "https://gitlab.com/org/repo/-/merge_requests/42"
  },
  "project": {
    "path_with_namespace": "org/repo"
  },
  "user": {
    "username": "developer"
  }
}
```

**Response `200`:**

```json
{
  "received": true
}
```

### GET /tasks/:id/pull-requests

Get pull requests associated with a task.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "pullRequests": [
    {
      "id": "pr-uuid",
      "taskId": "task-uuid",
      "provider": "github",
      "repository": "org/repo",
      "number": 42,
      "title": "Add authentication",
      "url": "https://github.com/org/repo/pull/42",
      "author": "developer",
      "status": "open",
      "createdAt": "2026-04-04T12:00:00.000Z"
    }
  ]
}
```

---

## Auth

### POST /auth/login

Authenticate as a human user.

**Request:**

```json
{
  "username": "admin",
  "password": "admin123"
}
```

**Response `200`:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI1NTBlODQwMC1lMjliLTQxZDQtYTcxNi00NDY2NTU0NDAwMDAiLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNzQ0MTQ0NDAwLCJleHAiOjE3NDQyMzA4MDB9.xxx",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "username": "admin",
    "role": "admin"
  }
}
```

JWT tokens are HS256 signed, valid for 24 hours. Include the token in the `Authorization: Bearer <token>` header for authenticated requests.

**Default admin credentials (development only):**

- Username: `admin`
- Password: `admin123`

> See [SECURITY.md](./SECURITY.md) for production security considerations including password hashing and token configuration.

---

## SSE Streaming

### GET /sse/boards/:id/stream

Subscribe to real-time board updates via Server-Sent Events.

**Authentication required.** Uses `sseAuth` middleware — accepts either `X-Agent-API-Key` header or `Authorization: Bearer <jwt>` header or `?token=<jwt>` query parameter.

**Response:** `text/event-stream`

```text
data: {"type":"connected","data":{"boardId":"board-uuid"}}

data: {"type":"task.created","data":{"id":"...","title":"New task","status":"pending",...}}

data: {"type":"task.claimed","data":{"taskId":"...","agentId":"..."}}

data: {"type":"task.updated","data":{"id":"...","status":"in_progress",...}}
```

### Event Types

| Type | Data | Description |
|------|------|-------------|
| `connected` | `{ boardId }` | Connection established |
| `feature.created` | `Feature` | New feature created |
| `feature.updated` | `Feature` | Feature modified |
| `feature.moved` | `{ featureId, fromColumnId, toColumnId }` | Feature moved between columns |
| `feature.status_changed` | `{ featureId, fromStatus, toStatus }` | Feature status derived |
| `feature.deleted` | `{ featureId }` | Feature deleted |
| `feature.progress` | `{ featureId, completed, total }` | Feature progress updated |
| `task.created` | `Task` | New task created |
| `task.updated` | `Task` | Task modified |
| `task.claimed` | `{ taskId, agentId }` | Task claimed by agent |
| `task.submitted` | `{ taskId, agentId }` | Task submitted for review |
| `task.approved` | `{ taskId, reviewerId }` | Task approved |
| `task.rejected` | `{ taskId, reason }` | Task rejected |
| `task.completed` | `{ taskId }` | Task marked done |
| `task.failed` | `{ taskId, reason }` | Task failed |
| `task.released` | `{ taskId, reason }` | Task released |
| `task.moved` | `{ taskId, fromStatus, toStatus }` | Task status changed |
| `task.deleted` | `{ taskId }` | Task deleted |
| `task.commented` | `{ taskId, commentId }` | Comment added to task |
| `task.delegated` | `{ taskId, toAgentId }` | Task delegated to another agent |
| `task.cloned` | `{ taskId, clonedTaskId }` | Task cloned |
| `task.overdue` | `{ taskId }` | Task passed its due date |
| `task.retry_scheduled` | `{ taskId }` | Retry scheduled for failed task |
| `task.retry_executed` | `{ taskId }` | Retry executed |
| `task.escalated` | `{ taskId, reason }` | Task escalated |
| `subtask.created` | `{ taskId, subtask }` | Subtask created |
| `subtask.updated` | `{ taskId, subtask }` | Subtask updated |
| `subtask.deleted` | `{ taskId }` | Subtask deleted |
| `agent.message_received` | `{ fromAgentId, subject }` | Agent received a message |
| `anomaly.detected` | `{ anomaly }` | Anomaly detected |
| `agent.status_changed` | `{ agentId, status }` | Agent status changed |
| `agent.heartbeat` | `{ agentId, taskId }` | Agent heartbeat received |
| `board.created` | `Board` | Board created |
| `board.updated` | `Board` | Board updated |
| `board.deleted` | `{ boardId }` | Board deleted |
| `column.created` | `Column` | Column created |
| `column.updated` | `Column` | Column updated |
| `column.deleted` | `{ columnId, boardId }` | Column deleted |
| `column.wip_limit_reached` | `{ columnId, limit }` | WIP limit exceeded |

### Reconnection

The UI client implements exponential backoff reconnection (1s → 30s max). The SSE stream sets headers for proper proxy behavior:

- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Accel-Buffering: no`

---
