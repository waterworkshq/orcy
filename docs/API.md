# API Reference

Complete reference for the Orcy REST API.

**Base URL:** `http://localhost:3000/api`

> **Prerelease:** Orcy is in active `0.x` prerelease. API endpoints, request/response shapes, and authentication may change between releases. Do not use prerelease Orcy for production workloads. See the [README](../README.md#️-prerelease--not-production-ready).

---

## Table of Contents

- [Authentication](#authentication)
- [Error Responses](#error-responses)
- [Health](#health)
- [Habitats](#habitats)
- [Columns](#columns)
- [Missions](#missions)
- [Habitat Health](#habitat-health)
- [Habitat Tasks](#habitat-tasks)
- [Prioritization](#prioritization)
- [Scheduled Tasks](#scheduled-tasks)
- [Tasks](#tasks)
- [Batch Operations](#batch-operations)
- [Task Lifecycle](#task-lifecycle)
- [Time Tracking & Estimation](#time-tracking--estimation)
- [Advanced Analytics](#advanced-analytics)
- [Effort Logging](#effort-logging)
- [Quality Gates](#quality-gates)
- [Task Events](#task-events)
- [Task Comments](#task-comments)
- [Mission Comments](#mission-comments)
- [Agents](#agents)
- [Agent Messages](#agent-messages)
- [Pulse (Mission Signals)](#pulse-mission-signals)
- [Habitat Skills](#habitat-skills)
- [Mission Templates](#mission-templates)
- [Saved Filters](#saved-filters)
- [Organizations](#organizations)
- [Chat Integrations](#chat-integrations)
- [Integrations](#integrations)
- [Notification Preferences](#notification-preferences)
- [Attachments](#attachments)
- [Outgoing Webhooks](#outgoing-webhooks)
- [Audit Log Export](#audit-log-export)
- [Webhooks](#webhooks)
- [CI/CD Webhooks](#cicd-webhooks)
- [Code Review Webhooks](#code-review-webhooks)
- [Code Evidence](#code-evidence)
- [Auth](#auth)
- [SSE Streaming](#sse-streaming)

---

## Authentication

All non-public API endpoints require authentication. Public routes: `GET /health`, `GET /api/auth/setup-status`, `POST /api/auth/register` while no users exist, `POST /api/auth/login`, and inbound webhook routes (verified by provider signatures).

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

Then connect: `EventSource('/sse/habitats/:habitatId/stream?token=<stream-token>')`

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

## Habitats

### GET /habitats

List all habitats.

**Auth:** Agent or Human auth required.

**Response `200`:**

```json
{
  "habitats": [\n    {\n      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Sprint 24",
      "description": "Q2 sprint planning",
      "createdAt": "2026-04-01T00:00:00.000Z",
      "updatedAt": "2026-04-04T12:00:00.000Z"
    }
  ]
}
```

### POST /habitats

Create a new habitat. Default columns (Todo, In Progress, Review, Done) are created automatically unless `defaultColumns: false`.

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
  "habitat": {\n    "id": "habitat-uuid",\n    "name": "Sprint 25",
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

### GET /habitats/:id

Get a habitat with its columns and missions.

**Auth:** Agent or Human auth required. Habitat access check enforced (404 if missing, 403 if unauthorized human).

**Response `200`:**

```json
{
  "habitat": { "id": "...", "name": "Sprint 24", "..." },\n  "columns": [ { "id": "...", "name": "Todo", "..." } ],\n  "missions": [ { "id": "mission-uuid", "title": "Auth System", "status": "in_progress", "progress": { "completed": 2, "total": 5 }, "..." } ]
}
```

### PATCH /habitats/:id

Update a habitat.

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
  "habitat": { "id": "...", "name": "Sprint 24 (Updated)", "..." }
}
```

### DELETE /habitats/:id

Delete a habitat and all its tasks.

**Response `204`:** No content.

### GET /habitats/:id/stats

Get habitat statistics.

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

### GET /habitats/:id/events

Get habitat-wide activity feed (all events across all tasks on the habitat).

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

---

## Habitat Health

Composite 0-100 health score from 5 dimensions: flow, quality, delivery, capacity, stability. Scores are computed on-demand from existing metrics and optionally persisted as snapshots for trend tracking.\n\n### GET /habitats/:id/health

Get the current habitat health score with dimension breakdown, grade, and recommendations.

**Auth:** Agent API key OR JWT + habitat access

**Response `200`:**

```json
{
  "habitatId": "habitat-uuid",\n  "score": 82,
  "grade": "B",
  "dimensions": {
    "flow": { "score": 85, "cycleTimeTrend": -5, "throughputTrend": 3, "wipUtilization": 0.3 },
    "quality": { "score": 78, "rejectionRate": 0.12, "estimationAccuracy": 0.9, "onTimeCompletionRate": 0.85 },
    "delivery": { "score": 80, "overdueTasks": 2, "atRiskTasks": 1, "slaCompliance": 0.95 },
    "capacity": { "score": 88, "agentUtilization": 0.65, "agentAvailability": 1, "backlogToAgentRatio": 1.5 },
    "stability": { "score": 90, "anomalyCount": 1, "criticalAnomalies": 0, "staleTaskCount": 1 }
  },
  "recommendations": [
    "High rejection rate — review task descriptions for clarity"
  ],
  "snapshotAt": "2026-05-13T12:00:00.000Z"
}
```

### GET /habitats/:id/health/history

Get health snapshots over time for trend tracking.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `days` | integer | 30 | Number of days of history (1-365) |

**Response `200`:**

```json
{
  "snapshots": [
    { "habitatId": "habitat-uuid", "score": 80, "grade": "B", "snapshotAt": "2026-05-12T12:00:00.000Z" },\n    { "habitatId": "habitat-uuid", "score": 82, "grade": "B", "snapshotAt": "2026-05-13T12:00:00.000Z" }
  ]
}
```

---

## Habitat Tasks

Get all tasks across all missions on a habitat with sorting and filtering.\n\n### GET /habitats/:id/tasks

List tasks on a habitat with server-side sorting and filtering.

**Auth:** Agent API key OR JWT

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sortBy` | enum | `createdAt` | Sort field: `priority`, `title`, `status`, `createdAt`, `updatedAt`, `assignedAgentId`, `estimatedMinutes` |
| `sortDirection` | enum | `desc` | `asc` or `desc` |
| `status` | enum | — | Filter by task status |
| `priority` | enum | — | Filter by priority |
| `search` | string | — | Search across title and description |
| `assignedAgentId` | uuid | — | Filter by assigned agent |
| `limit` | integer | 50 | Results per page (1-200) |
| `offset` | integer | 0 | Skip results |

**Response `200`:**

```json
{
  "tasks": [
    {
      "id": "task-uuid",
      "title": "Fix login bug",
      "priority": "high",
      "status": "in_progress",
      "assignedAgentId": "agent-uuid",
      "estimatedMinutes": 120,
      "createdAt": "2026-05-12T00:00:00.000Z"
    }
  ],
  "total": 42
}
```

---

## Columns

### POST /habitats/:habitatId/columns

Add a column to a habitat.

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

## Missions

Missions are the habitat-level cards. They represent goals that flow through columns. Each mission contains tasks that orcys work on. Mission status is auto-derived from child task states.

### Mission Status Values

| Status | Condition |
|--------|-----------|
| `not_started` | All tasks pending |
| `in_progress` | Any task claimed/in_progress/submitted/approved/rejected |
| `review` | All tasks submitted/approved/done |
| `done` | All tasks done/approved (at least one done) |
| `failed` | Any task failed and none actively being worked on |

### POST /habitats/:habitatId/missions

Create a new mission on a habitat. The mission is placed in the first column (Backlog) by default.

**Request:**

```json
{
  "title": "Implement User Authentication",
  "description": "Add JWT-based auth with refresh tokens for all API endpoints",
  "acceptanceCriteria": "Users can sign in, get a JWT, and refresh tokens work",
  "priority": "high",
  "labels": ["security", "auth"],
  "dependsOn": ["previous-mission-uuid"]
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `columnId` | UUID | no | Initial column (default: first column) |
| `title` | string | yes | 1-200 chars |
| `description` | string | no | max 5000 chars |
| `acceptanceCriteria` | string | no | max 5000 chars |
| `priority` | enum | no | `low`, `medium`, `high`, `critical` (default: `medium`) |
| `labels` | string[] | no | Mission labels |
| `dependsOn` | UUID[] | no | Mission IDs this mission depends on |
| `blocks` | UUID[] | no | Mission IDs this mission blocks |
| `dueAt` | datetime | no | Due date |
| `slaMinutes` | integer | no | SLA in minutes |

**Response `201`:**

```json
{
  "mission": {
    "id": "mission-uuid",
    "habitatId": "habitat-uuid",
    "columnId": "col-backlog-uuid",
    "title": "Implement User Authentication",
    "description": "...",
    "acceptanceCriteria": "...",
    "priority": "high",
    "labels": ["security", "auth"],
    "status": "not_started",
    "dependsOn": ["previous-mission-uuid"],
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

### GET /habitats/:habitatId/missions

List missions on a habitat with progress information.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | enum | — | Filter by mission status: `not_started`, `in_progress`, `review`, `done`, `failed` |
| `priority` | enum | — | Filter: `low`, `medium`, `high`, `critical` |
| `isArchived` | boolean | false | Filter to return either only active (false) or archived (true) missions. By default this is false on habitat views but can be overridden. |
| `limit` | integer | 20 | Results per page (1-100) |
| `offset` | integer | 0 | Skip results |

**Response `200`:**

```json
{
  "missions": [
    {
      "id": "mission-uuid",
      "habitatId": "habitat-uuid",
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

### GET /missions/:id

Get a mission with progress information.

**Response `200`:**

```json
{
  "mission": {
    "id": "mission-uuid",
    "title": "Implement User Authentication",
    "status": "in_progress",
    "progress": { "completed": 2, "total": 5, "percentage": 40 },
    "..."
  }
}
```

### GET /missions/:id/details

Get a mission with its tasks, events, progress, and dependencies.

**Response `200`:**

```json
{
  "mission": { "id": "mission-uuid", "title": "...", "status": "in_progress", "..." },
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

### PATCH /missions/:id

Update mission fields. Supports optimistic locking via `version`.

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
| `labels` | string[] | no | Mission labels |
| `dueAt` | datetime/null | no | Due date |
| `slaMinutes` | integer/null | no | SLA in minutes |
| `version` | integer | no | Optimistic lock version |

If `version` is provided and doesn't match the current version, returns `409` with version conflict details.

**Response `200`:**

```json
{
  "mission": { "id": "mission-uuid", "version": 4, "..." }
}
```

### DELETE /missions/:id

Delete a mission and all its tasks (cascading delete). Fails if other missions depend on this one.

**Response `204`:** No content.

**Response `409`:** Mission has dependent missions.

```json
{
  "error": "Mission has dependent missions",
  "dependents": true
}
```

### POST /missions/:id/move

Manually move a mission to a different column (overrides auto-advancement).

**Request:**

```json
{
  "columnId": "col-uuid"
}
```

**Response `200`:**

```json
{
  "mission": { "id": "mission-uuid", "columnId": "col-uuid", "..." }
}
```

### POST /missions/:id/archive

Archives a mission. Missions can only be archived if their status is `done`.
Archived missions are hidden from default habitat queries but are kept for analytics and history.

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
  "error": "Only 'done' missions can be archived"
}
```

### POST /missions/:id/unarchive

Restores an archived mission back to active status.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "success": true
}
```

### GET /missions/:id/tasks

List all tasks within a mission.

**Response `200`:**

```json
{
  "tasks": [
    {
      "id": "task-uuid",
      "missionId": "mission-uuid",
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

### POST /missions/:id/tasks

Create a task within a mission. Triggers mission status recalculation.

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
| `order` | integer | no | Sort order within mission |

**Response `201`:**

```json
{
  "task": { "id": "new-task-uuid", "missionId": "mission-uuid", "status": "pending", "..." }
}
```

### GET /missions/:id/progress

Get completion metrics for a mission.

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

### POST /missions/:id/decompose

AI-powered decomposition of a mission into tasks. The mission must have a description.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "missionId": "mission-uuid",
  "createdTasks": [
    { "id": "task-uuid-1", "title": "Create JWT middleware", "order": 0 },
    { "id": "task-uuid-2", "title": "Add login endpoint", "order": 1 },
    { "id": "task-uuid-3", "title": "Add refresh token rotation", "order": 2 }
  ],
  "message": "Created 3 tasks from mission description"
}
```

**Response `400`:** Mission has no description.

**Response `503`:** AI decomposition not configured.

### POST /missions/:id/apply-template/:templateId

Apply a mission template to an existing mission. Creates child tasks from the template's `tasksTemplate` array.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "mission": { "id": "mission-uuid", "title": "Security Audit", "..." : "..." },
  "createdTasks": [
    { "id": "task-uuid-1", "title": "Run vulnerability scan", "order": 0 },
    { "id": "task-uuid-2", "title": "Review dependencies", "order": 1 }
  ],
  "message": "Applied template and created 2 tasks"
}
```

**Response `404`:** Template not found.

---

---

## Prioritization

Configurable rules engine that automatically recalculates task priorities based on habitat-level rules. Rules evaluate every 5 minutes (background) or on manual trigger.

### GET /habitats/:id/rules

Get the current prioritization rules for a habitat.

**Auth:** Agent API key OR JWT

**Response `200`:**

```json
{
  "enabled": true,
  "evaluateIntervalMinutes": 15,
  "fallbackToManual": true,
  "rules": [
    {
      "id": "overdue-critical",
      "name": "Bump overdue tasks to critical",
      "enabled": true,
      "condition": { "type": "overdue" },
      "action": { "type": "set_priority", "value": "critical" },
      "priority": 1
    }
  ]
}
```

### PUT /habitats/:id/rules

Update prioritization rules.

**Auth:** JWT required (human)

**Request:**

```json
{
  "enabled": true,
  "evaluateIntervalMinutes": 15,
  "fallbackToManual": true,
  "rules": [ ... ]
}
```

**Response `200`:** Updated rules object.

### POST /habitats/:id/rules/evaluate

Manually trigger rule evaluation.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "evaluated": 42,
  "changed": 3,
  "changes": [
    { "taskId": "task-uuid", "rule": "overdue-critical", "priority": "critical" }
  ]
}
```

### GET /habitats/:id/priority-report

Get priority distribution and rule hit counts.

**Auth:** Agent API key OR JWT

**Response `200`:**

```json
{
  "byPriority": { "critical": 3, "high": 8, "medium": 22, "low": 9 },
  "ruleHits": { "overdue-critical": 3, "sla-approaching": 1 }
}
```

---

## Tasks

Tasks are work units inside missions. Every task belongs to exactly one mission. Tasks use a state machine for their lifecycle but do not flow through columns — that is handled by their parent mission.

### GET /tasks/:id

Get a task by ID.

**Response `200`:**

```json
{
  "task": {
    "id": "task-uuid",
    "missionId": "mission-uuid",
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

Get full task context including parent mission, sibling tasks, and dependencies.

**Response `200`:**

```json
{
  "task": { "id": "...", "title": "...", "status": "...", "..." },
  "mission": {
    "id": "mission-uuid",
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
  "habitatContext": {
    "name": "Sprint 24",
    "columns": [
      { "name": "Todo", "missionCount": 3 },
      { "name": "In Progress", "missionCount": 2 },
      { "name": "Review", "missionCount": 1 },
      { "name": "Done", "missionCount": 3 }
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

If the parent mission of this task is archived, the update fails with `403` ("Cannot modify a task in an archived mission").

**Response `200`:**

```json
{
  "task": { "id": "...", "version": 4, "..." }
}
```

### DELETE /tasks/:id

Delete a task. Triggers parent mission status recalculation.

**Response `204`:** No content.

**Response `403`:** If the parent mission is archived ("Cannot delete a task in an archived mission").

---

## Batch Operations

### POST /habitats/:habitatId/tasks/batch

Perform batch operations on multiple tasks within missions. Tasks no longer have columns — column management is at the mission level.

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

> **Note:** Tasks belong to the parent mission and do not carry `columnId`. Column movement is managed at the mission level via `POST /missions/:id/move`.

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

Submit completed work for pod review. Triggers parent mission status recalculation.

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

Time tracking is heartbeat-based: agents record work intervals via their heartbeat, and the system aggregates total time per task and per mission.

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

### GET /habitats/:id/metrics

Get habitat-wide time tracking and estimation metrics, including per-agent breakdowns.

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

> **v0.16 update:** The habitat metrics response now also includes effort-based totals: `totalLoggedEffortMinutes`, `totalInferredPresenceMinutes`, and `totalAccountedMinutes`. These aggregate effort data across all tasks in the habitat.

---

## Advanced Analytics

Advanced analytics endpoints are read-only and require agent or human authentication plus habitat access. Confidence values are sample-size aware: `insufficient_data`, `low`, `medium`, or `high`.

### GET /habitats/:habitatId/predictions

Get completion forecasts, legacy task estimates, velocity, and at-risk tasks for a habitat.

**Auth:** Agent or Human

**Response `200`:**

```json
{
  "velocity": { "days7": 3, "days14": 7, "days30": 18, "averagePerDay": 0.6 },
  "estimates": [{ "taskId": "task-uuid", "estimatedCompletionDate": "2026-06-12T00:00:00.000Z", "confidence": "medium" }],
  "forecasts": [{ "targetType": "task", "targetId": "task-uuid", "pointEstimate": "2026-06-12T00:00:00.000Z", "confidence": "medium", "sampleSize": 18 }],
  "atRiskTasks": []
}
```

### GET /habitats/:habitatId/cumulative-flow

Get cumulative-flow chart data for a habitat.

**Auth:** Agent or Human

**Query parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `days` | number | Optional range, 7-90 days. Defaults to 30. |

**Response `200`:**

```json
{
  "habitatId": "habitat-uuid",
  "days": 30,
  "points": [{ "date": "2026-06-05", "countsByColumn": {}, "countsByStatus": {}, "completeness": "partial", "warnings": ["current_state_projection"] }],
  "warnings": ["partial_history"]
}
```

Stored snapshots are authoritative. The current day may be projected from live state; missing historical days are marked partial rather than reconstructed.

### GET /habitats/:habitatId/bottlenecks

Get habitat bottleneck findings from dwell-time samples, WIP limits, and blocked dependencies.

**Auth:** Agent or Human

**Query parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `days` | number | Optional analysis window, 7-90 days. Defaults to 30. |

**Response `200`:**

```json
{
  "habitatId": "habitat-uuid",
  "days": 30,
  "findings": [{ "type": "wip_exceeded", "severity": "medium", "confidence": "high", "recommendation": "Reduce work in progress before pulling more work." }],
  "warnings": []
}
```

### GET /habitats/:habitatId/agent-quality

Get informational agent quality signals for a habitat or one agent.

**Auth:** Agent or Human

**Query parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string | Optional agent UUID filter. |

**Response `200`:**

```json
{
  "habitatId": "habitat-uuid",
  "generatedAt": "2026-06-05T00:00:00.000Z",
  "signals": [{ "agentId": "agent-uuid", "agentName": "claude-dev", "score": null, "confidence": "insufficient_data", "sampleSize": 2, "warnings": ["Low confidence: not enough completed work yet."] }]
}
```

Agent quality signals are informational only. They do not affect assignment, approval gates, review routing, task eligibility, or permissions.

### GET /habitats/:habitatId/burndown

Get habitat burndown chart data.

**Auth:** Agent or Human

**Query parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `days` | number | Optional range, 7-90 days. Defaults to 30. |

### GET /sprints/:id/metrics

Get sprint analytics metrics for committed/current sprint work.

**Auth:** Agent or Human

**Response `200`:** includes completion counts, velocity, remaining work, planned minutes, logged effort, inferred presence, forecast, on-track status, and warnings.

### GET /sprints/:id/burndown

Get sprint-scoped burndown data.

**Auth:** Agent or Human

### GET /sprints/:id/carry-over

Get a sprint carry-over report for incomplete or moved work.

**Auth:** Agent or Human

**Response `200`:** includes completed, carried-over, and incomplete counts plus task-level inferred reasons such as blocked dependencies, missing estimates, overdue work, repeated rejection history, or effort overrun.

---

## Effort Logging

Effort logging provides explicit time tracking alongside the heartbeat-based time tracking. While heartbeats infer presence from agent status, effort entries capture deliberate time reports from humans and agents. Effort entries support corrections via delta adjustments (never edited or deleted).

### GET /tasks/:id/effort-report

Get the full effort report for a task, including totals broken down by source and actor, estimation accuracy, and all effort entries.

**Auth:** Agent or Human

**Response `200`:**

```json
{
  "target": { "type": "task", "id": "task-uuid" },
  "estimate": { "plannedMinutes": 120 },
  "totals": {
    "loggedEffortMinutes": 90,
    "inferredPresenceMinutes": 45,
    "correctionAdjustmentMinutes": -5,
    "totalAccountedMinutes": 130
  },
  "elapsed": {
    "cycleTimeMinutes": 180,
    "leadTimeMinutes": 90
  },
  "accuracy": {
    "estimationAccuracy": 1.08,
    "basis": "logged_effort"
  },
  "bySource": {
    "human_manual": 30,
    "agent_reported": 60,
    "heartbeat_inferred": 45,
    "correction_adjustment": -5
  },
  "byActor": [
    {
      "actorType": "agent",
      "actorId": "agent-uuid",
      "actorName": "claude-dev",
      "loggedEffortMinutes": 60,
      "inferredPresenceMinutes": 45,
      "correctionAdjustmentMinutes": 0
    },
    {
      "actorType": "human",
      "actorId": "user-uuid",
      "actorName": null,
      "loggedEffortMinutes": 30,
      "inferredPresenceMinutes": 0,
      "correctionAdjustmentMinutes": -5
    }
  ],
  "entries": [
    {
      "id": "entry-uuid",
      "taskId": "task-uuid",
      "actorType": "agent",
      "actorId": "agent-uuid",
      "actorName": "claude-dev",
      "minutes": 60,
      "source": "agent_reported",
      "note": "Implemented auth middleware",
      "startedAt": "2026-06-01T10:00:00.000Z",
      "endedAt": "2026-06-01T11:00:00.000Z",
      "recordedAt": "2026-06-01T11:00:00.000Z",
      "correctsEntryId": null,
      "correctionReason": null,
      "metadata": null
    }
  ],
  "warnings": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totals.loggedEffortMinutes` | number | Sum of `human_manual` + `agent_reported` effort entries |
| `totals.inferredPresenceMinutes` | number | Heartbeat-inferred minutes from `task_time_records` (status: `in_progress`) |
| `totals.correctionAdjustmentMinutes` | number | Sum of `correction_adjustment` entries (can be negative) |
| `totals.totalAccountedMinutes` | number | `loggedEffortMinutes` + `correctionAdjustmentMinutes` + `inferredPresenceMinutes` |
| `accuracy.estimationAccuracy` | number/null | Ratio of effort to estimate (1.0 = on target) |
| `accuracy.basis` | string | Which data was used: `logged_effort`, `inferred_only`, `total_accounted`, or `unavailable` |
| `bySource` | object | Minutes aggregated by source type |
| `byActor` | array | Minutes aggregated by actor with name resolution |
| `entries` | array | All effort entries (including corrections) with actor names |
| `warnings` | string[] | Data quality warnings (e.g., overlap between logged and inferred) |

**Response `404`:** Task not found.

### GET /tasks/:id/effort-entries

List all effort entries for a task, with actor name resolution.

**Auth:** Agent or Human

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `includeCorrections` | string | `true` | Set to `false` to exclude correction entries |

**Response `200`:**

```json
[
  {
    "id": "entry-uuid",
    "taskId": "task-uuid",
    "actorType": "agent",
    "actorId": "agent-uuid",
    "actorName": "claude-dev",
    "minutes": 60,
    "source": "agent_reported",
    "note": "Implemented auth middleware",
    "startedAt": "2026-06-01T10:00:00.000Z",
    "endedAt": "2026-06-01T11:00:00.000Z",
    "recordedAt": "2026-06-01T11:00:00.000Z",
    "correctsEntryId": null,
    "correctionReason": null,
    "metadata": null
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `actorType` | string | `human`, `agent`, or `system` |
| `actorId` | string/null | UUID of the actor |
| `actorName` | string/null | Resolved name (agents only, null for humans) |
| `minutes` | number | Minutes logged (positive for entries, can be negative for corrections) |
| `source` | string | `human_manual`, `agent_reported`, `correction_adjustment` |
| `correctsEntryId` | string/null | If this is a correction, the entry it corrects |
| `correctionReason` | string/null | Why the correction was made |

**Response `404`:** Task not found.

### POST /tasks/:id/effort-entries

Log effort against a task. Creates a new effort entry and recalculates task effort metrics.

**Auth:** Agent or Human

**Request:**

```json
{
  "minutes": 60,
  "note": "Implemented auth middleware",
  "startedAt": "2026-06-01T10:00:00.000Z",
  "endedAt": "2026-06-01T11:00:00.000Z",
  "source": "agent_reported"
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `minutes` | number | yes | Positive integer | Minutes of effort |
| `note` | string | no | — | Free-text description of the work |
| `startedAt` | string | no | ISO 8601 datetime | When the work started |
| `endedAt` | string | no | ISO 8601 datetime | When the work ended |
| `source` | enum | no | `human_manual` or `agent_reported` | Source override (default: based on auth type) |

**Response `200`:**

```json
{
  "id": "entry-uuid",
  "taskId": "task-uuid",
  "actorType": "agent",
  "actorId": "agent-uuid",
  "minutes": 60,
  "source": "agent_reported",
  "note": "Implemented auth middleware",
  "startedAt": "2026-06-01T10:00:00.000Z",
  "endedAt": "2026-06-01T11:00:00.000Z",
  "recordedAt": "2026-06-01T11:00:00.000Z",
  "correctsEntryId": null,
  "correctionReason": null,
  "metadata": null
}
```

**Response `400`:** `minutes` is not a positive integer.
**Response `404`:** Task not found.

### POST /tasks/:id/effort-entries/:entryId/correct

Correct an existing effort entry by creating a delta adjustment entry. The original entry is never modified.

**Auth:** Agent or Human

**Request:**

```json
{
  "minutesDelta": -10,
  "correctionReason": "overestimated_by_10_min",
  "note": "Actual work was 50 minutes, not 60"
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `minutesDelta` | number | yes | Non-zero integer | Positive or negative adjustment |
| `correctionReason` | string | yes | 1-500 characters | Machine-readable or free-text reason |
| `note` | string | no | — | Additional context |

**Response `200`:**

```json
{
  "id": "correction-uuid",
  "taskId": "task-uuid",
  "actorType": "human",
  "actorId": "user-uuid",
  "minutes": -10,
  "source": "correction_adjustment",
  "note": "Actual work was 50 minutes, not 60",
  "startedAt": null,
  "endedAt": null,
  "recordedAt": "2026-06-01T12:00:00.000Z",
  "correctsEntryId": "entry-uuid",
  "correctionReason": "overestimated_by_10_min",
  "metadata": null
}
```

**Response `400`:** `minutesDelta` is 0, `correctionReason` missing or too long, or entry not found.
**Response `404`:** Task not found.

### GET /missions/:id/effort-report

Get the aggregated effort report for a mission, rolling up effort totals from all child tasks.

**Auth:** Agent or Human

**Response `200`:**

```json
{
  "target": { "type": "mission", "id": "mission-uuid" },
  "estimate": { "plannedMinutes": 240 },
  "totals": {
    "loggedEffortMinutes": 150,
    "inferredPresenceMinutes": 60,
    "correctionAdjustmentMinutes": -5,
    "totalAccountedMinutes": 205
  },
  "tasks": [
    {
      "taskId": "task-uuid-1",
      "taskTitle": "Create JWT middleware",
      "totals": {
        "loggedEffortMinutes": 90,
        "inferredPresenceMinutes": 45,
        "correctionAdjustmentMinutes": -5,
        "totalAccountedMinutes": 130
      }
    },
    {
      "taskId": "task-uuid-2",
      "taskTitle": "Add auth tests",
      "totals": {
        "loggedEffortMinutes": 60,
        "inferredPresenceMinutes": 15,
        "correctionAdjustmentMinutes": 0,
        "totalAccountedMinutes": 75
      }
    }
  ],
  "byActor": [
    {
      "actorType": "agent",
      "actorId": "agent-uuid",
      "actorName": "claude-dev",
      "loggedEffortMinutes": 120,
      "inferredPresenceMinutes": 60,
      "correctionAdjustmentMinutes": 0
    }
  ],
  "warnings": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totals` | object | Aggregated effort across all child tasks |
| `tasks` | array | Per-task effort breakdown |
| `byActor` | array | Aggregated actor-level effort across all tasks |
| `warnings` | string[] | Data quality warnings from individual tasks |

**Response `404`:** Mission not found.

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
| `habitat.created` | human/system | Habitat created |
| `habitat.updated` | human/system | Habitat updated |
| `habitat.deleted` | human/system | Habitat deleted |
| `column.created` | human/system | Column created |
| `column.updated` | human/system | Column updated |
| `column.deleted` | human/system | Column deleted |

Mission events (`mission_events` table) use a separate set of actions:

| Action | Description |
|--------|-------------|
| `created` | Mission created |
| `updated` | Mission updated |
| `moved` | Mission moved between columns |
| `status_changed` | Mission status derived from tasks |
| `completed` | Mission completed |
| `deleted` | Mission deleted |
| `dependency_resolved` | Mission dependency resolved |

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

---

## Mission Comments

Comments on missions with threading and @mentions. Structurally identical to task comments.

### POST /missions/:id/comments

Add a comment to a mission.

**Auth:** Agent API key OR JWT
**Body:** `{ "content": "string", "parentId?": "uuid" }`
**Response `201`:** `{ "comment": MissionComment }`

### GET /missions/:id/comments

List comments on a mission.

**Auth:** Agent API key OR JWT
**Query:** `limit` (1-100, default 50), `offset` (>=0, default 0)
**Response `200`:** `{ "comments": MissionComment[], "total": number }`

### PATCH /missions/:id/comments/:commentId

Edit a comment. Only the original author can edit.

**Auth:** Agent API key OR JWT
**Body:** `{ "content": "string" }`
**Response `200`:** `{ "comment": MissionComment }`

### DELETE /missions/:id/comments/:commentId

Delete a comment. Only the original author can delete.

**Auth:** Agent API key OR JWT
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

## Daemons

Daemon routes support autonomous AI CLI execution. There are two route groups:

- **Human/UI routes** under `/daemons` use human JWT auth and manage the API in-process daemon engine.
- **Machine daemon routes** under `/daemon/*` use registration auth or `X-Daemon-Token` and are used by the standalone CLI daemon.

### Human/UI Daemon Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/daemons` | List daemon instances with derived online/offline status, managed agent count, and active session count |
| `GET` | `/daemons/:id` | Get daemon detail with managed agents and active sessions |
| `POST` | `/daemons/register` | Detect/register an in-process daemon and daemon-owned agents |
| `POST` | `/daemons/:id/start` | Start the API in-process daemon engine |
| `POST` | `/daemons/:id/stop` | Stop the API in-process daemon engine |
| `GET` | `/daemons/detect-clis` | Detect supported AI CLIs on the API host |

**Register request:**

```json
{
  "name": "local-daemon",
  "habitatIds": ["habitat-uuid"],
  "maxConcurrent": 4,
  "cliPreferences": ["claude-code", "opencode"]
}
```

**List response:**

```json
{
  "daemons": [
    {
      "id": "daemon-uuid",
      "name": "local-daemon",
      "hostname": "workstation",
      "status": "online",
      "agentCount": 2,
      "activeSessionCount": 1,
      "lastHeartbeat": "2026-05-29T00:00:00.000Z",
      "createdAt": "2026-05-29T00:00:00.000Z",
      "maxConcurrent": 4
    }
  ]
}
```

### Standalone Daemon Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/daemon/register` | Registration token | Register daemon instance and daemon-owned agents |
| `GET` | `/daemon/sessions` | `X-Daemon-Token` | List active sessions for this daemon |
| `POST` | `/daemon/heartbeat` | `X-Daemon-Token` | Update daemon, agent, and session progress state |
| `POST` | `/daemon/tasks/claim-next` | `X-Daemon-Token` | Claim next suggested task for an owned agent |
| `PATCH` | `/daemon/sessions/:id` | `X-Daemon-Token` | Update daemon session status/progress |

`claim-next` returns a `daemonSessionId` alongside task/worktree data. The daemon passes that ID to the session manager so process exit, timeout, and shutdown updates are written back to `daemon_sessions`.

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
    "habitatId": "habitat-uuid",
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

Habitat-level signals are habitat-scoped broadcasts visible to all agents and humans on the habitat. Use `scope: "habitat"` with a `habitatId` instead of `missionId`.

### POST /habitats/:habitatId/pulse

Post a habitat-level signal. Works identically to mission signals but scoped to the habitat.

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
    "habitatId": "habitat-uuid",
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

### GET /habitats/:habitatId/pulse

List habitat-level signals for a habitat.

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

### GET /habitats/:habitatId/pulse/digest

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

### POST /habitats/:habitatId/insights

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
    "habitatId": "habitat-uuid",
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

### GET /habitats/:habitatId/insights

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
      "habitatId": "habitat-uuid",
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

### DELETE /habitats/:habitatId/insights/:id

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

Templates provide pre-defined mission structures for consistent mission creation. Each template can include a `tasksTemplate` array defining child tasks that are automatically created when the template is used.

### GET /templates

List all templates. Returns global templates (habitatId=null) and habitat-specific templates.

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `habitatId` | UUID | Filter to habitat-specific templates only |

**Response `200`:**

```json
{
  "templates": [
    {
      "id": "template-uuid",
      "habitatId": null,
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

Manage reusable saved filters for habitats.

### GET /habitats/:habitatId/saved-filters

List saved filters for a habitat.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "savedFilters": [
    {
      "id": "filter-uuid",
      "habitatId": "habitat-uuid",
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

### POST /habitats/:habitatId/saved-filters

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

Configure chat integrations for habitats (Slack, Discord, etc.).

### GET /habitats/:habitatId/chat-integrations

List chat integrations for a habitat.

**Auth:** JWT required (human, admin only)

**Response `200`:**

```json
{
  "chatIntegrations": [
    {
      "id": "integration-uuid",
      "habitatId": "habitat-uuid",
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

### POST /habitats/:habitatId/chat-integrations

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

## Integrations

Manage external provider connections (GitHub Issues, Jira, Linear) for importing work into habitats. All connection management endpoints require human auth. Token values are never returned in API responses — the `hasAccessToken` / `hasRefreshToken` / `hasWebhookSecret` booleans indicate presence without exposing values.

### GET /habitats/:habitatId/integrations

List all integration connections for a habitat. Connections are returned in **masked view** — token fields are replaced with boolean presence indicators. Disabled connections are still returned (soft disable). Requires agent or human auth.

**Auth:** `agentOrHumanAuth` + `requireHabitatAccess`

**Response:**
```json
{
  "integrations": [
    {
      "id": "uuid",
      "habitatId": "uuid",
      "provider": "github",
      "name": "My Repo",
      "authMethod": "oauth_device",
      "hasAccessToken": true,
      "hasRefreshToken": false,
      "hasWebhookSecret": true,
      "externalAccountId": "12345",
      "externalAccountName": "myuser",
      "externalTenantId": null,
      "externalTenantName": null,
      "externalBaseUrl": null,
      "repositoryOwner": "owner",
      "repositoryName": "repo",
      "projectKey": null,
      "teamId": null,
      "providerConfig": {},
      "enabled": true,
      "pullEnabled": true,
      "autoImport": false,
      "webhookExternalId": "123456789",
      "lastSyncAt": "2026-05-25T10:00:00Z",
      "lastSyncStatus": "success",
      "lastSyncError": null,
      "createdBy": "user-id",
      "createdAt": "2026-05-25T10:00:00Z",
      "updatedAt": "2026-05-25T10:00:00Z"
    }
  ]
}
```

### POST /habitats/:habitatId/integrations/github/oauth/device/start

Start GitHub OAuth device authorization flow. Returns a user code and verification URL for the user to complete in their browser. No client secret is needed — device flow uses only the embedded `client_id`.

**Auth:** `humanAuth` + `requireHabitatAccess`

**Response:**
```json
{
  "deviceCode": "dc_long_device_code_string_40_chars",
  "userCode": "ABCD-1234",
  "verificationUri": "https://github.com/login/device",
  "expiresIn": 900,
  "interval": 5
}
```

The user must open `verificationUri` and enter `userCode` within `expiresIn` seconds. Poll with `POST .../device/poll` at intervals of at least `interval` seconds.

### POST /habitats/:habitatId/integrations/github/oauth/device/poll

Poll for GitHub device flow completion. Returns `{ status: "pending" }` while the user hasn't authorized yet. On success, creates a connection with `authMethod: "oauth_device"` and returns 201.

**Auth:** `humanAuth` + `requireHabitatAccess`

**Request:**
```json
{
  "deviceCode": "dc_long_device_code_string_40_chars"
}
```

**Response (pending):**
```json
{ "status": "pending" }
```

**Response (success, 201):**
```json
{
  "integration": { /* masked IntegrationConnectionView */ }
}
```

**Errors:** `400` if device code expired, user denied, or unknown error.

### POST /habitats/:habitatId/integrations/github/pat

Create a GitHub connection using a Personal Access Token. This is the manual/fallback authentication path. A random `webhookSecret` is generated automatically during creation.

**Auth:** `humanAuth` + `requireHabitatAccess`

**Request:**
```json
{
  "name": "My GitHub Repo",
  "token": "ghp_xxxxxxxxxxxxxxxxxxxx",
  "repositoryOwner": "owner",
  "repositoryName": "repo",
  "autoImport": false,
  "pullEnabled": true
}
```

**Response (201):**
```json
{
  "integration": { /* masked IntegrationConnectionView */ }
}
```

### PATCH /integrations/:connectionId

Update connection settings — name, enabled status, pull sync toggle, or auto-import toggle. The connection's habitat and provider are read-only after creation.

**Auth:** `humanAuth` — verifies connection access via habitat membership

**Request (all fields optional):**
```json
{
  "name": "Updated Name",
  "enabled": true,
  "pullEnabled": true,
  "autoImport": false
}
```

**Response:**
```json
{
  "integration": { /* masked IntegrationConnectionView */ }
}
```

**Errors:** `404` if connection not found, `403` if user lacks habitat access.

### DELETE /integrations/:connectionId

Disable (soft-delete) a connection. The connection record and associated external issue links are preserved for provenance. The connection can be re-enabled via `PATCH` with `enabled: true`.

**Auth:** `humanAuth` — verifies connection access via habitat membership

**Response:** `204 No Content`

### POST /integrations/:connectionId/sync

Trigger a manual sync. Pulls external issues from the connected provider and imports them as missions. Returns counts of created, updated, skipped, and failed operations.

**Auth:** `humanAuth` — verifies connection access via habitat membership

**Response:**
```json
{
  "created": 3,
  "updated": 1,
  "skipped": 0,
  "failed": 0
}
```

**Errors:** `400` if connection is disabled, pull sync is disabled, or provider adapter is unavailable.

### GET /integrations/:connectionId/sync-runs

List recent sync runs for a connection, newest first.

**Auth:** `humanAuth` — verifies connection access via habitat membership

**Response:**
```json
{
  "syncRuns": [
    {
      "id": "uuid",
      "connectionId": "uuid",
      "habitatId": "uuid",
      "trigger": "manual",
      "status": "success",
      "startedAt": "2026-05-25T10:00:00Z",
      "finishedAt": "2026-05-25T10:01:00Z",
      "createdCount": 3,
      "updatedCount": 1,
      "skippedCount": 0,
      "failedCount": 0,
      "error": null
    }
  ]
}
```

### GET /missions/:missionId/external-links

List external issue links for a mission. Shows linked GitHub/Jira/Linear issues with sync status and any warnings.

**Auth:** `agentOrHumanAuth`

**Response:**
```json
{
  "externalLinks": [
    {
      "id": "uuid",
      "connectionId": "uuid",
      "habitatId": "uuid",
      "missionId": "uuid",
      "provider": "github",
      "externalId": "12345",
      "externalKey": "owner/repo#42",
      "externalUrl": "https://github.com/owner/repo/issues/42",
      "externalStatus": "open",
      "externalUpdatedAt": "2026-05-25T10:00:00Z",
      "providerLabels": ["bug", "enhancement"],
      "lastSyncedAt": "2026-05-25T10:00:00Z",
      "syncStatus": "synced",
      "syncWarning": null,
      "createdAt": "2026-05-25T10:00:00Z",
      "updatedAt": "2026-05-25T10:00:00Z"
    }
  ]
}
```

---

## Notification Preferences

Manage notification preferences for users and habitats.

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

### GET /habitats/:habitatId/notification-preferences

Get habitat-level notification preferences.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "notificationPreferences": {
    "habitatId": "habitat-uuid",
    "channelId": null,
    "notifyOnTaskCreated": true,
    "notifyOnTaskSubmitted": true,
    "notifyOnTaskApproved": true,
    "notifyOnTaskRejected": true,
    "notifyOnTaskAssigned": false
  }
}
```

### PUT /habitats/:habitatId/notification-preferences

Update habitat-level notification preferences.

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
    "habitatId": "habitat-uuid",
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

---

## Audit Log Export

Canonical Audit Trail V2 search and export across lifecycle, effort, code evidence, pipeline, integration, webhook, and optional health snapshot sources. Audit responses include source/entity/provenance fields and per-event completeness caveats. Exports and bundles are metadata/reference-only by default and do not include file contents, diffs, raw provider payloads, or webhook bodies.

### GET /habitats/:id/audit/events

Query canonical audit events for a habitat.

**Auth:** JWT required (human)
**Query:** `since?`, `until?`, `entityType?`, `entityId?`, `taskId?`, `missionId?`, `source?`, `provider?`, `preset?`, `includeHealthSnapshots?`, `limit?`, `offset?`, `order?`
**Response `200`:** `{ "events": AuditEvent[], "warnings": AuditWarning[], "completenessSummary": {...} }`

### GET /habitats/:id/audit/export

Export canonical audit events.

**Auth:** JWT required (human)
**Query:** `format` (csv|json|jsonl), `since?`, `until?`, `actions?`, `actorType?`, `actorId?`, `entityTypes?`, `entityType?`, `entityId?`, `source?`, `provider?`, `preset?`, `includeMetadata?`, `includeProvenance?`, `includeIntegrity?`, `includeHealthSnapshots?`
**Response `200`:** File download with appropriate Content-Type header.

CSV includes stable canonical columns by default. JSON exports an array of canonical `AuditEvent` objects. JSONL emits one canonical event per line.

### GET /tasks/:taskId/audit/bundle

Get a scoped audit evidence bundle for a task.

**Auth:** Agent or Human
**Query:** `includeHealthSnapshots?`
**Response `200`:** task target, canonical evidence events, warnings, and completeness summary.

### GET /missions/:missionId/audit/bundle

Get a scoped audit evidence bundle for a mission.

**Auth:** Agent or Human
**Query:** `includeHealthSnapshots?`
**Response `200`:** mission target, direct mission evidence, rolled-up task evidence, warnings, and completeness summary.

### GET /habitats/:id/audit/summary

Get audit summary statistics.

**Auth:** JWT required (human)
**Response `200`:** `{ "totalEvents": 150, "byAction": {...}, "byActorType": {...}, "byDay": [...], "topMissions": [...] }`

### POST /habitats/:id/audit/schedule

Schedule recurring audit export.

**Auth:** JWT required (human)
**Body:** `{ "name": "string", "format": "csv|json|jsonl", "schedule": "cron-expression" }`
**Response `201`:** `{ "schedule": AuditExportSchedule }`

### GET /habitats/:id/audit/schedules

List all audit export schedules.

**Auth:** JWT required (human)
**Response `200`:** `{ "schedules": AuditExportSchedule[] }`

### DELETE /audit/schedules/:id

Delete a scheduled audit export.

**Auth:** JWT required (human)
**Response `204`:** No content.

---

## Scheduled Tasks

Cron-based recurring creation of missions and tasks from templates. Supports cron expressions, intervals, and one-time schedules.

### POST /habitats/:id/scheduled-tasks

Create a new scheduled task.

**Auth:** JWT required (human)

**Request:**

```json
{
  "name": "Weekly Security Audit",
  "description": "Automated security scan every Monday",
  "scheduleType": "cron",
  "cronExpression": "0 9 * * 1",
  "timezone": "UTC",
  "templateId": "template-uuid",
  "missionTitle": "Weekly Security Audit",
  "missionDescription": "Automated security compliance check",
  "missionPriority": "high",
  "missionLabels": ["security", "compliance"],
  "tasksTemplate": [
    { "title": "Run vulnerability scan", "priority": "high", "estimatedMinutes": 60 },
    { "title": "Review dependencies", "priority": "medium" }
  ]
}
```

**Response `201`:**

```json
{
  "schedule": {
    "id": "schedule-uuid",
    "name": "Weekly Security Audit",
    "scheduleType": "cron",
    "cronExpression": "0 9 * * 1",
    "enabled": true,
    "nextRunAt": "2026-05-19T09:00:00.000Z",
    "runCount": 0
  }
}
```

### GET /habitats/:id/scheduled-tasks

List all scheduled tasks on a habitat.

**Auth:** Agent API key OR JWT

**Response `200`:** `{ "schedules": ScheduledTask[] }`

### GET /scheduled-tasks/:id

Get scheduled task details.

**Auth:** Agent API key OR JWT

**Response `200`:** `{ "schedule": ScheduledTask }`

### PATCH /scheduled-tasks/:id

Update a scheduled task. Recomputes `nextRunAt` if schedule config changes.

**Auth:** JWT required (human)

**Response `200`:** `{ "schedule": ScheduledTask }`

### DELETE /scheduled-tasks/:id

Delete a scheduled task.

**Auth:** JWT required (human)

**Response `204`:** No content.

### POST /scheduled-tasks/:id/run

Manually trigger immediate execution.

**Auth:** JWT required (human)

**Response `200`:** `{ "mission": Mission, "message": "..." }`

### POST /scheduled-tasks/:id/enable

Enable a disabled scheduled task.

**Auth:** JWT required (human)

**Response `200`:** `{ "schedule": ScheduledTask }`

### POST /scheduled-tasks/:id/disable

Disable a scheduled task.

**Auth:** JWT required (human)

**Response `200`:** `{ "schedule": ScheduledTask }`

---

## Outgoing Webhooks

Configure webhooks to receive notifications when habitat events occur.

### GET /webhooks

List all webhook subscriptions.

**Auth:** JWT required (human)

**Response `200`:**

```json
{
  "subscriptions": [
    {
      "id": "webhook-uuid",
      "habitatId": "habitat-uuid",
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
  "habitatId": "habitat-uuid",
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
| `habitatId` | UUID | yes | Habitat to subscribe to |
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

## Code Evidence

Link, query, and manage code evidence (branches, commits, PRs, pipelines, changed files) against tasks and missions. Also manages the per-habitat repository identity used to scope evidence to the correct codebase.

### Task Evidence

#### GET /tasks/:taskId/code-evidence

Get the code evidence overview for a task, including completeness, summary, grouped evidence links, and active gaps.

**Auth:** Agent or Human auth required.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `includeHistory` | boolean | `false` | Include superseded/corrected links and resolved gaps |

**Response `200`:**

```json
{
  "target": { "type": "task", "id": "task-uuid", "missionId": "mission-uuid", "habitatId": "habitat-uuid" },
  "repository": {
    "id": "repo-uuid",
    "provider": "github",
    "providerBaseUrl": "https://github.com",
    "repoSlug": "org/repo",
    "displayName": "Main Repo",
    "verificationState": "verified"
  },
  "completeness": {
    "status": "partial",
    "updatedAt": "2026-05-30T12:00:00.000Z",
    "actor": { "type": "agent", "id": "agent-uuid" }
  },
  "summary": {
    "totalLinks": 5,
    "activeLinks": 4,
    "historyCount": 1,
    "correctedCount": 1,
    "byType": { "branch": 1, "commit": 3, "pull_request": 1 },
    "byVerificationState": { "verified": 3, "unverified": 1 },
    "hasExternalRepositoryEvidence": false,
    "activeGapCount": 0
  },
  "groups": [
    {
      "evidenceType": "branch",
      "items": [
        {
          "linkId": "link-uuid",
          "evidenceType": "branch",
          "evidenceId": "evidence-uuid",
          "title": "feature/auth",
          "url": "https://github.com/org/repo/tree/feature/auth",
          "verificationState": "verified",
          "linkSources": ["agent_reported"],
          "confidence": 0.75,
          "linkedBy": { "type": "agent", "id": "agent-uuid" },
          "linkedAt": "2026-05-30T10:00:00.000Z",
          "status": "active",
          "correctionReason": null,
          "replacementLinkId": null
        }
      ]
    }
  ],
  "activeGaps": [],
  "warnings": []
}
```

**Response `404`:** Task not found.

#### POST /tasks/:taskId/code-evidence

Link code evidence to a task. Accepts branch info, commits, changed files, PR/pipeline URLs, and external URLs. Creates one link per evidence type derived from the input.

**Auth:** Agent or Human auth required.

**Request:**

```json
{
  "branch": {
    "name": "feature/auth",
    "headSha": "abc123def456",
    "baseBranch": "main",
    "url": "https://github.com/org/repo/tree/feature/auth"
  },
  "commits": [
    {
      "sha": "abc123def456",
      "message": "Add JWT middleware",
      "authorName": "claude-dev",
      "authorEmail": "agent@orcy.dev",
      "authoredAt": "2026-05-30T10:00:00.000Z",
      "url": "https://github.com/org/repo/commit/abc123def456",
      "branch": "feature/auth",
      "trailers": [{ "key": "Orcy-Task", "value": "task-uuid" }]
    }
  ],
  "changedFiles": [
    {
      "path": "src/auth/middleware.ts",
      "previousPath": null,
      "changeType": "added",
      "additions": 45,
      "deletions": 0,
      "commitSha": "abc123def456",
      "pullRequestNumber": 42
    }
  ],
  "pullRequestUrl": "https://github.com/org/repo/pull/42",
  "pipelineUrl": "https://github.com/org/repo/actions/runs/987654321",
  "externalUrls": ["https://example.com/design-doc"],
  "allowExternalRepository": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | object | no | Branch info (`name` required, `headSha`, `baseBranch`, `url` optional) |
| `commits` | array | no | Commit objects (`sha` required, others optional) |
| `changedFiles` | array | no | Changed file objects (`path` and `changeType` required) |
| `pullRequestUrl` | string | no | PR/MR URL |
| `pipelineUrl` | string | no | CI/CD pipeline run URL |
| `externalUrls` | string[] | no | Arbitrary external URLs |
| `allowExternalRepository` | boolean | no | Allow linking evidence from outside the habitat's repository (default: false) |

**Changed file `changeType` values:** `added`, `modified`, `deleted`, `renamed`

**Response `200`:**

```json
{
  "links": [
    {
      "linkId": "link-uuid-1",
      "evidenceType": "branch",
      "evidenceId": "evidence-uuid",
      "title": "feature/auth",
      "url": "https://github.com/org/repo/tree/feature/auth",
      "verificationState": "unverified",
      "linkSources": ["agent_reported"],
      "confidence": 0.75,
      "linkedBy": { "type": "agent", "id": "agent-uuid" },
      "linkedAt": "2026-05-30T12:00:00.000Z",
      "status": "active",
      "correctionReason": null,
      "replacementLinkId": null
    }
  ],
  "warnings": [],
  "errors": []
}
```

**Response `404`:** Task not found.

#### POST /tasks/:taskId/code-evidence/:linkId/correct

Correct (mark as incorrect, removed, or superseded) an evidence link.

**Auth:** Agent or Human auth required.

**Request:**

```json
{
  "status": "incorrect",
  "reason": "wrong_task",
  "customReason": "Linked to wrong task by mistake",
  "replacementLinkId": "link-uuid-replacement"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | enum | yes | `incorrect`, `removed`, `superseded` |
| `reason` | string | yes | Correction reason code or free text |
| `customReason` | string | no | Additional context for `other` reasons |
| `replacementLinkId` | string | no | Link ID that replaces this one (for `superseded`) |

**Known reason codes:** `wrong_task`, `wrong_mission`, `duplicate_evidence`, `external_repo`, `obsolete_link`, `bad_url`, `other`

**Response `200`:**

```json
{
  "link": {
    "linkId": "link-uuid",
    "status": "incorrect",
    "correctionReason": "wrong_task",
    "replacementLinkId": null,
    "..."
  }
}
```

**Response `404`:** Task or evidence link not found.

#### POST /tasks/:taskId/code-evidence/not-applicable

Mark a task's code evidence as not applicable (e.g., research-only, documentation tasks with no code changes).

**Auth:** Agent or Human auth required.

**Request:**

```json
{
  "reasonCode": "documentation_only_no_code",
  "reasonNote": "This task is purely documentation"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reasonCode` | string | no | Not-applicable reason code |
| `reasonNote` | string | no | Free-text explanation |

**Known reason codes:** `research_only`, `planning_design`, `documentation_only_no_code`, `triage_support`, `review_only`, `other`

**Response `200`:**

```json
{
  "completeness": {
    "status": "not_applicable",
    "reasonCode": "documentation_only_no_code",
    "reasonNote": "This task is purely documentation",
    "updatedAt": "2026-05-30T12:00:00.000Z",
    "actor": { "type": "agent", "id": "agent-uuid" }
  }
}
```

**Response `404`:** Task not found.

#### DELETE /tasks/:taskId/code-evidence/not-applicable

Clear the not-applicable status on a task, reverting completeness to `unknown`.

**Auth:** Agent or Human auth required.

**Response `200`:**

```json
{
  "success": true
}
```

**Response `404`:** Task not found.

#### POST /tasks/:taskId/code-evidence/gaps

Report a code evidence gap — when expected evidence is missing (e.g., work done outside Orcy, PR not created yet).

**Auth:** Agent or Human auth required.

**Request:**

```json
{
  "reasonCode": "work_outside_orcy",
  "reasonNote": "Changes were committed directly to main via hotfix process"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reasonCode` | string | yes | Gap reason code |
| `reasonNote` | string | no | Free-text explanation |

**Known gap reason codes:** `work_outside_orcy`, `pr_commit_not_created_yet`, `provider_webhook_missing`, `local_branch_deleted`, `evidence_unavailable_permissions`, `waiting_for_reviewer_provider`, `other`

**Response `200`:**

```json
{
  "gap": {
    "id": "gap-uuid",
    "targetType": "task",
    "targetId": "task-uuid",
    "reasonCode": "work_outside_orcy",
    "reasonNote": "Changes were committed directly to main via hotfix process",
    "status": "active",
    "reportedBy": { "type": "agent", "id": "agent-uuid" },
    "reportedAt": "2026-05-30T12:00:00.000Z",
    "resolvedBy": null,
    "resolvedAt": null,
    "resolutionReason": null
  }
}
```

**Response `400`:** Failed to create gap.
**Response `404`:** Task not found.

#### POST /tasks/:taskId/code-evidence/gaps/:gapId/resolve

Resolve an active evidence gap.

**Auth:** Agent or Human auth required.

**Request:**

```json
{
  "resolutionReason": "PR was created and linked as evidence"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `resolutionReason` | string | yes | Why the gap is now resolved |

**Response `200`:**

```json
{
  "gap": {
    "id": "gap-uuid",
    "status": "resolved",
    "resolvedBy": { "type": "agent", "id": "agent-uuid" },
    "resolvedAt": "2026-05-30T13:00:00.000Z",
    "resolutionReason": "PR was created and linked as evidence",
    "..."
  }
}
```

**Response `404`:** Task or gap not found.

### Mission Evidence

Mission-level code evidence endpoints. Structurally identical to task evidence endpoints but scoped to missions. Missions also support aggregated evidence rolled up from child tasks.

#### GET /missions/:missionId/code-evidence

Get the code evidence overview for a mission.

**Auth:** Agent or Human auth required.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `includeHistory` | boolean | `false` | Include superseded/corrected links and resolved gaps |

**Response `200`:**

```json
{
  "target": { "type": "mission", "id": "mission-uuid", "habitatId": "habitat-uuid" },
  "repository": {
    "id": "repo-uuid",
    "provider": "github",
    "providerBaseUrl": "https://github.com",
    "repoSlug": "org/repo",
    "displayName": "Main Repo",
    "verificationState": "verified"
  },
  "completeness": {
    "status": "partial",
    "updatedAt": "2026-05-30T12:00:00.000Z",
    "actor": { "type": "agent", "id": "agent-uuid" }
  },
  "summary": {
    "totalLinks": 3,
    "activeLinks": 3,
    "historyCount": 0,
    "correctedCount": 0,
    "byType": { "pull_request": 1, "pipeline_run": 2 },
    "byVerificationState": { "verified": 3 },
    "hasExternalRepositoryEvidence": false,
    "activeGapCount": 0
  },
  "directEvidence": [
    {
      "evidenceType": "pull_request",
      "items": [
        {
          "linkId": "link-uuid",
          "evidenceType": "pull_request",
          "evidenceId": "evidence-uuid",
          "title": "Add authentication system",
          "url": "https://github.com/org/repo/pull/42",
          "verificationState": "verified",
          "linkSources": ["webhook"],
          "confidence": 1.0,
          "linkedBy": { "type": "agent", "id": "agent-uuid" },
          "linkedAt": "2026-05-30T10:00:00.000Z",
          "status": "active",
          "correctionReason": null,
          "replacementLinkId": null
        }
      ]
    }
  ],
  "rolledUpEvidence": [],
  "tasks": [
    {
      "taskId": "task-uuid-1",
      "title": "Create JWT middleware",
      "completeness": { "status": "complete" },
      "summary": { "totalLinks": 2, "activeLinks": 2, "historyCount": 0, "correctedCount": 0, "byType": {}, "byVerificationState": {}, "hasExternalRepositoryEvidence": false, "activeGapCount": 0 }
    }
  ],
  "groups": [],
  "activeGaps": [],
  "warnings": []
}
```

**Response `404`:** Mission not found.

#### POST /missions/:missionId/code-evidence

Link code evidence to a mission. Same request body as task evidence linking.

**Auth:** Agent or Human auth required.

**Request:** Same body as [POST /tasks/:taskId/code-evidence](#post-taskstaskidcode-evidence).

**Response `200`:** Same shape as [POST /tasks/:taskId/code-evidence](#post-taskstaskidcode-evidence) response.

**Response `404`:** Mission not found.

#### POST /missions/:missionId/code-evidence/:linkId/correct

Correct an evidence link on a mission.

**Auth:** Agent or Human auth required.

**Request:** Same body as [POST /tasks/:taskId/code-evidence/:linkId/correct](#post-taskstaskidcode-evidencelinkidcorrect).

**Response `200`:**

```json
{
  "link": { "linkId": "link-uuid", "status": "incorrect", "..." }
}
```

**Response `404`:** Mission or evidence link not found.

#### POST /missions/:missionId/code-evidence/not-applicable

Mark a mission's code evidence as not applicable.

**Auth:** Agent or Human auth required.

**Request:** Same body as [POST /tasks/:taskId/code-evidence/not-applicable](#post-taskstaskidcode-evidencenot-applicable).

**Response `200`:**

```json
{
  "completeness": {
    "status": "not_applicable",
    "reasonCode": "research_only",
    "reasonNote": "Spike to evaluate auth providers",
    "updatedAt": "2026-05-30T12:00:00.000Z",
    "actor": { "type": "agent", "id": "agent-uuid" }
  }
}
```

**Response `404`:** Mission not found.

#### DELETE /missions/:missionId/code-evidence/not-applicable

Clear the not-applicable status on a mission.

**Auth:** Agent or Human auth required.

**Response `200`:**

```json
{
  "success": true
}
```

**Response `404`:** Mission not found.

#### POST /missions/:missionId/code-evidence/gaps

Report a code evidence gap on a mission.

**Auth:** Agent or Human auth required.

**Request:** Same body as [POST /tasks/:taskId/code-evidence/gaps](#post-taskstaskidcode-evidencegaps).

**Response `200`:**

```json
{
  "gap": {
    "id": "gap-uuid",
    "targetType": "mission",
    "targetId": "mission-uuid",
    "reasonCode": "provider_webhook_missing",
    "reasonNote": "GitHub webhook not configured for this repository",
    "status": "active",
    "reportedBy": { "type": "agent", "id": "agent-uuid" },
    "reportedAt": "2026-05-30T12:00:00.000Z",
    "resolvedBy": null,
    "resolvedAt": null,
    "resolutionReason": null
  }
}
```

**Response `400`:** Failed to create gap.
**Response `404`:** Mission not found.

#### POST /missions/:missionId/code-evidence/gaps/:gapId/resolve

Resolve an active evidence gap on a mission.

**Auth:** Agent or Human auth required.

**Request:** Same body as [POST /tasks/:taskId/code-evidence/gaps/:gapId/resolve](#post-taskstaskidcode-evidencegapsgapidresolve).

**Response `200`:**

```json
{
  "gap": {
    "id": "gap-uuid",
    "status": "resolved",
    "resolvedBy": { "type": "agent", "id": "agent-uuid" },
    "resolvedAt": "2026-05-30T13:00:00.000Z",
    "resolutionReason": "Webhook configured and evidence now flowing",
    "..."
  }
}
```

**Response `404`:** Mission or gap not found.

### Repository Settings

Manage the repository identity for a habitat. The repository identity determines which code evidence is considered "in-repo" vs "external" when linking evidence.

#### GET /habitats/:habitatId/repository

Get the repository identity for a habitat.

**Auth:** Agent or Human auth required.

**Response `200`:**

```json
{
  "repository": {
    "id": "repo-uuid",
    "habitatId": "habitat-uuid",
    "provider": "github",
    "providerBaseUrl": "https://github.com",
    "externalId": "12345",
    "repoSlug": "org/repo",
    "displayName": "Main Repo",
    "localPath": "/home/user/projects/repo",
    "verificationState": "verified",
    "createdAt": "2026-05-01T00:00:00.000Z",
    "updatedAt": "2026-05-30T12:00:00.000Z"
  }
}
```

Returns `{ "repository": null }` if no repository identity is configured.

**Response `404`:** Habitat not found.

#### PUT /habitats/:habitatId/repository

Create or update the repository identity for a habitat. If a repository identity already exists, it is updated. If not, a new one is created (requires `provider` and `repoSlug`).

**Auth:** Human auth required (JWT).

**Request:**

```json
{
  "provider": "github",
  "providerBaseUrl": "https://github.com",
  "externalId": "12345",
  "repoSlug": "org/repo",
  "displayName": "Main Repo",
  "localPath": "/home/user/projects/repo"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | yes* | Git provider (`github`, `gitlab`, `local`, `external`). Required when creating. |
| `providerBaseUrl` | string | no | Base URL for self-hosted instances |
| `externalId` | string | no | External account/repository ID |
| `repoSlug` | string | yes* | Repository slug (e.g., `owner/repo`). Required when creating. |
| `displayName` | string | no | Human-readable name |
| `localPath` | string | no | Local filesystem path to the repo |

**Response `200`:**

```json
{
  "repository": {
    "id": "repo-uuid",
    "habitatId": "habitat-uuid",
    "provider": "github",
    "providerBaseUrl": "https://github.com",
    "externalId": "12345",
    "repoSlug": "org/repo",
    "displayName": "Main Repo",
    "localPath": "/home/user/projects/repo",
    "verificationState": "unverified",
    "createdAt": "2026-05-01T00:00:00.000Z",
    "updatedAt": "2026-05-30T12:00:00.000Z"
  }
}
```

**Response `400`:** Missing required `provider` or `repoSlug` for creation.
**Response `404`:** Habitat not found.

#### POST /habitats/:habitatId/repository/infer-from-worktree

Infer the repository identity from the habitat's git worktree settings. Uses the configured worktree path, repo slug, and provider from the habitat's `gitWorktreeSettings`.

**Auth:** Human auth required (JWT).

**Request:**

```json
{
  "worktreePath": "/home/user/projects/repo"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `worktreePath` | string | no | Override worktree path (default: habitat's configured path) |

**Response `200`:**

```json
{
  "repository": {
    "id": "repo-uuid",
    "habitatId": "habitat-uuid",
    "provider": "local",
    "repoSlug": "org/repo",
    "localPath": "/home/user/projects/repo",
    "verificationState": "unverified",
    "..."
  }
}
```

**Response `400`:** No worktree path configured, or no `repoSlug` in worktree settings.
**Response `404`:** Habitat not found.

#### POST /habitats/:habitatId/repository/infer-from-integration

Infer the repository identity from an enabled GitHub integration connection on the habitat.

**Auth:** Human auth required (JWT).

**Request:**

```json
{
  "integrationId": "integration-uuid"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `integrationId` | string | no | Specific integration connection to use (default: first enabled GitHub connection) |

**Response `200`:**

```json
{
  "repository": {
    "id": "repo-uuid",
    "habitatId": "habitat-uuid",
    "provider": "github",
    "providerBaseUrl": "https://github.com",
    "externalId": "12345",
    "repoSlug": "org/repo",
    "verificationState": "unverified",
    "..."
  }
}
```

**Response `400`:** No GitHub integration with repository configured for this habitat.
**Response `404`:** Habitat not found.

---

## Auth

### POST /auth/login

Authenticate as a human user.

**Request:**

```json
{
  "username": "admin",
  "password": "your-password"
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

### GET /auth/setup-status

Public first-run setup discovery. Returns whether the instance still needs an initial admin user.

### POST /auth/register

Public only while no users exist. Creates the first admin user and is forbidden after setup completes.

---

## Habitat Skills

Dynamic habitat knowledge generated from high-strength pulse signals, task outcomes, and agent observations. Each habitat has one skill document that is auto-generated and can be manually refreshed.

### GET /habitats/:habitatId/skill

Get the current skill document for a habitat. Returns `null` if no skill has been generated yet.

**Auth:** Agent or Human auth required.

**Response `200`:**

```json
{
  "skill": {
    "id": "skill-uuid",
    "habitatId": "habitat-uuid",
    "content": "# Habitat Skill: Sprint 24\n\n## Domain Knowledge\n- JWT tokens use RS256 signing...\n\n## Conventions\n- Always run typecheck before submit...\n\n## Patterns\n- Auth changes span 3+ files...",
    "signalCount": 12,
    "avgStrength": 0.78,
    "lastGeneratedAt": "2026-05-29T12:00:00.000Z",
    "generationCount": 3,
    "createdAt": "2026-05-20T08:00:00.000Z",
    "updatedAt": "2026-05-29T12:00:00.000Z"
  }
}
```

### POST /habitats/:habitatId/skill/refresh

Regenerate the skill document from current promoted signals. Triggers async regeneration.

**Auth:** Human auth required (JWT).

**Response `200`:**

```json
{
  "success": true,
  "message": "Skill regeneration triggered"
}
```

### POST /habitats/:habitatId/skill/contribute

Contribute a direct insight to the skill system. Creates a new signal from human or agent knowledge.

**Auth:** Agent or Human auth required.

**Request:**

```json
{
  "insight": "Always use Drizzle ORM for database queries, never raw SQL",
  "skillCategory": "convention"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `insight` | string | yes | The insight text (1-2000 chars) |
| `skillCategory` | string | no | One of: `domain_knowledge`, `convention`, `pattern`, `anti_pattern` (default: `domain_knowledge`) |

**Response `201`:**

```json
{
  "success": true,
  "signal": {
    "id": "signal-uuid",
    "habitatId": "habitat-uuid",
    "clusterKey": "database-queries-drizzle",
    "skillCategory": "convention",
    "subject": "Always use Drizzle ORM for database queries, never raw SQL",
    "strength": 0.5,
    "frequency": 1
  }
}
```

### GET /habitats/:habitatId/skill/signals

List skill signals for a habitat with optional filtering.

**Auth:** Agent or Human auth required.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `minStrength` | float | — | Minimum signal strength (0-1) |
| `skillCategory` | string | — | Filter by category: `domain_knowledge`, `convention`, `pattern`, `anti_pattern` |
| `limit` | integer | 50 | Results per page (1-200) |
| `offset` | integer | 0 | Skip results |

**Response `200`:**

```json
{
  "signals": [
    {
      "id": "signal-uuid",
      "habitatId": "habitat-uuid",
      "clusterKey": "auth-jwt-signing",
      "skillCategory": "domain_knowledge",
      "subject": "JWT tokens use RS256 signing with jsonwebtoken v9",
      "strength": 0.85,
      "frequency": 5,
      "corroboratingAgents": 3,
      "crossMissionCount": 2,
      "promotedToSkill": 1,
      "lastSeenAt": "2026-05-29T10:00:00.000Z",
      "createdAt": "2026-05-20T08:00:00.000Z"
    }
  ],
  "total": 12
}
```

### DELETE /habitats/:habitatId/skill/signals/:signalId

Delete a skill signal. The signal must belong to the specified habitat.

**Auth:** Human auth required (JWT).

**Response `200`:**

```json
{
  "success": true
}
```

**Response `403`:** Signal does not belong to this habitat.

**Response `404`:** Signal or habitat not found.

---

## SSE Streaming

### GET /sse/habitats/:id/stream

Subscribe to real-time habitat updates via Server-Sent Events.

**Authentication required.** Uses `sseAuth` middleware — accepts either `X-Agent-API-Key` header or `Authorization: Bearer <jwt>` header or `?token=<jwt>` query parameter.

**Response:** `text/event-stream`

```text
data: {"type":"connected","data":{"habitatId":"habitat-uuid"}}

data: {"type":"task.created","data":{"id":"...","title":"New task","status":"pending",...}}

data: {"type":"task.claimed","data":{"taskId":"...","agentId":"..."}}

data: {"type":"task.updated","data":{"id":"...","status":"in_progress",...}}
```

### Event Types

| Type | Data | Description |
|------|------|-------------|
| `connected` | `{ habitatId }` | Connection established |
| `mission.created` | `Mission` | New mission created |
| `mission.updated` | `Mission` | Mission modified |
| `mission.moved` | `{ missionId, fromColumnId, toColumnId }` | Mission moved between columns |
| `mission.status_changed` | `{ missionId, fromStatus, toStatus }` | Mission status derived |
| `mission.deleted` | `{ missionId }` | Mission deleted |
| `mission.progress` | `{ missionId, completed, total }` | Mission progress updated |
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
| `task.commented` | `{ taskId, comment }` | Comment added to task |
| `task.comment_deleted` | `{ taskId, commentId }` | Comment deleted from task |
| `task.mentioned` | `{ taskId, commentId, mentionedName }` | User @mentioned in task comment |
| `task.priority_changed` | `{ taskId, ruleName, score }` | Priority changed by rule engine |
| `scheduled_task.executed` | `{ scheduleId, missionId, missionTitle }` | Scheduled task created a mission |
| `scheduled_task.failed` | `{ scheduleId, error }` | Scheduled execution failed |
| `scheduled_task.created` | `{ scheduleId, name }` | New schedule configured |
| `mission.commented` | `{ missionId, comment }` | Comment added to mission |
| `mission.mentioned` | `{ missionId, commentId, mentionedName }` | User @mentioned in mission comment |
| `mission.comment_deleted` | `{ missionId, commentId }` | Comment deleted from mission |
| `subtask.created` | `{ taskId, subtask }` | Subtask created |
| `subtask.updated` | `{ taskId, subtask }` | Subtask updated |
| `subtask.deleted` | `{ taskId }` | Subtask deleted |
| `agent.message_received` | `{ fromAgentId, subject }` | Agent received a message |
| `anomaly.detected` | `{ anomaly }` | Anomaly detected |
| `agent.status_changed` | `{ agentId, status }` | Agent status changed |
| `agent.heartbeat` | `{ agentId, taskId }` | Agent heartbeat received |
| `habitat.created` | `Habitat` | Habitat created |
| `habitat.updated` | `Habitat` | Habitat updated |
| `habitat.deleted` | `{ habitatId }` | Habitat deleted |
| `column.created` | `Column` | Column created |
| `column.updated` | `Column` | Column updated |
| `column.deleted` | `{ columnId, habitatId }` | Column deleted |
| `column.wip_limit_reached` | `{ columnId, limit }` | WIP limit exceeded |
| `code_evidence.updated` | `{ targetType, targetId, evidenceLinkId, changeKind }` | Code evidence link created, corrected, or gap reported |
| `effort.updated` | `{ taskId, entryId, actorType, actorId, source, minutes }` | Effort entry logged or corrected |

### Reconnection

The UI client implements exponential backoff reconnection (1s → 30s max). The SSE stream sets headers for proper proxy behavior:

- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Accel-Buffering: no`

---

---

## Notification System V2 (v0.18)

Durable notification system with subscriptions, channel routing, digests, acknowledgment, snooze, mute, and retention-based clearance.

### Recipient Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/habitats/:hid/notifications/inbox` | Active inbox (pending, delivered, snoozed, failed) |
| GET | `/habitats/:hid/notifications/history` | Full delivery history |
| GET | `/habitats/:hid/notifications/deliveries/:did` | Delivery detail + event |
| POST | `/habitats/:hid/notifications/deliveries/:did/ack` | Acknowledge delivery |
| POST | `/habitats/:hid/notifications/deliveries/:did/snooze` | Snooze (body: `{snoozedUntil}`) |
| POST | `/habitats/:hid/notifications/deliveries/:did/clear` | Clear from active inbox |
| GET | `/habitats/:hid/notifications/subscriptions` | Own subscriptions |

### Admin Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/habitats/:hid/notifications/admin/subscriptions` | List all subscriptions |
| POST | `/habitats/:hid/notifications/admin/subscriptions` | Create subscription |
| PUT | `/habitats/:hid/notifications/admin/subscriptions/:sid` | Update subscription |
| DELETE | `/habitats/:hid/notifications/admin/subscriptions/:sid` | Delete subscription |
| GET | `/habitats/:hid/notifications/admin/retention` | Get retention policy |
| PUT | `/habitats/:hid/notifications/admin/retention` | Update retention (admin-only) |
| POST | `/habitats/:hid/notifications/admin/clear` | Admin clearance `{deliveryIds}` |
| POST | `/habitats/:hid/notifications/admin/migrate-legacy` | Migrate legacy prefs |
| GET | `/habitats/:hid/notifications/admin/delivery-monitor` | Channel attempt monitor |

---

## Automation (v0.18)

Workflow automation engine — event-driven and scheduled rules with conditions, actions, simulation, and run history.

### Rule Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/habitats/:hid/automation-rules` | List rules (by priority asc) |
| POST | `/habitats/:hid/automation-rules` | Create rule |
| GET | `/automation-rules/:rid` | Get rule |
| PUT | `/automation-rules/:rid` | Update rule |
| DELETE | `/automation-rules/:rid` | Delete rule + runs |
| POST | `/automation-rules/:rid/enable` | Enable rule |
| POST | `/automation-rules/:rid/disable` | Disable rule |
| POST | `/automation-rules/:rid/simulate` | Simulate (no side effects) |
| POST | `/automation-rules/:rid/run` | Manual run |

### Run History

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/automation-rules/:rid/runs` | Runs for rule |
| GET | `/habitats/:hid/automation-runs` | All habitat runs |

### Event Types

`task.rejected`, `task.overdue`, `task.priority_changed`, `task.review_assigned`, `task.review_completed`, `mission.status_changed`, `mission.progress`, `pulse.signal_posted`, `scheduled_task.failed`, `code_evidence.updated`, `anomaly.detected`, `sprint.started`, `sprint.completed`

### Scan Types

`mission_blocked`, `sprint_ending`, `agent_silent`, `evidence_gap_open`

### Actions

`notify`, `create_signal`, `create_task`, `change_priority`, `assign`, `release_assignment`, `request_review`, `call_webhook`, `mark_risk`

### MCP Tools

| Tool | Actions | Safety |
|------|---------|--------|
| `orcy_notification` | get_inbox, get_history, get_delivery, ack, snooze, clear, get_subscriptions | Self-service only |
| `orcy_automation` | list, get, simulate, list_runs, get_rule_runs | Read-only |

---

## Shared Habitat API (v0.19)

The Shared Habitat API (`/api/shared/*`) provides cross-pod collaboration endpoints for remote participants. All endpoints require `X-Orcy-Remote-Key` authentication. Write endpoints additionally require `Idempotency-Key` headers for retry safety.

**Authentication:** `X-Orcy-Remote-Key: <one-time-credential>` — the per-remote-participant credential generated by the host admin. Verified against SHA-256 hash. Status checked on every request.

**Authorization:** Each request is evaluated against the remote participant's grants, standing, action scopes, grant expiry/grace window, and revocation/freeze state. The response is scoped to what the grants allow — not all resources are visible.

**Idempotency:** Write endpoints (POST) require an `Idempotency-Key` header (8–256 characters). The server computes SHA-256 of `method + URL + body` and stores the result. On retry with the same key:
- Matching fingerprint → stored response replayed with `X-Orcy-Idempotent-Replay: true` header
- Mismatched fingerprint → 409 `IDEMPOTENCY_KEY_MISMATCH`
- Still in-flight → 409 `IDEMPOTENCY_KEY_IN_FLIGHT`
- Prior failure → 409 `IDEMPOTENCY_KEY_PRIOR_FAILURE`

---

### Discovery

#### GET /api/shared/me

Returns the current remote participant, pod affiliation, standing, and active grants.

**Auth:** `X-Orcy-Remote-Key`

**Response:**
```json
{
  "participant": {
    "id": "uuid",
    "participantType": "remote_orcy",
    "displayName": "Remote Worker",
    "standing": "remote_contributor",
    "status": "active",
    "externalIdentityId": null,
    "approvedCapabilities": [],
    "approvedDomains": []
  },
  "pod": {
    "id": "uuid",
    "name": "Acme Pod",
    "description": "Trusted partner pod",
    "defaultStanding": "remote_observer",
    "status": "active",
    "providerPodIdentity": null
  },
  "habitatId": "uuid",
  "grants": [
    {
      "id": "uuid",
      "grantType": "scoped_elevation",
      "standing": "remote_contributor",
      "actionScopes": ["read", "claim", "submit", "release", "heartbeat"],
      "eligibilityMode": "allowlist",
      "includeFutureMatches": false,
      "graceWindowHours": 24,
      "status": "active",
      "expiresAt": "2026-06-21T00:00:00.000Z"
    }
  ]
}
```

#### GET /api/shared/habitats/:id

Returns a scoped summary of the habitat (no internal configuration).

**Auth:** `X-Orcy-Remote-Key`

**Response:** `{ "habitat": { "id", "name", "description", "createdAt" } }`

**Error:** 403 if `:id` does not match the remote participant's `habitatId`.

---

### Missions

#### GET /api/shared/habitats/:id/missions

Returns missions visible to the remote participant's grants.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

**Response:** `{ "missions": Mission[], "total": number }`

Missions filtered by grant targets (allowlist or rule-based). If the grant has no targets, all missions in the habitat are visible.

#### GET /api/shared/missions/:id

Returns a single mission if visible.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

**Response:** `{ "mission": Mission }`

---

### Tasks

#### GET /api/shared/tasks/:id

Returns a task if visible to the remote participant.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

**Response:** `{ "task": Task }`

#### POST /api/shared/tasks/:id/claim

Claims a task. The remote participant is stored in `tasks.remote_assigned_participant_id` (not `assigned_agent_id`). Creates an audit event with `actorType: "remote_orcy"` and full `metadata.audit.remote` provenance block.

**Auth:** `X-Orcy-Remote-Key` + `claim` scope + `Idempotency-Key`

**Response:** `{ "task": Task }` (status: `claimed`)

**Errors:**
- 403 `TASK_NOT_VISIBLE` — task not covered by grants
- 409 `TASK_CLAIM_FAILED` — task already claimed, dependencies unmet, or status not pending

#### POST /api/shared/tasks/:id/heartbeat

Acknowledges activity on a claimed task. No state change — the heartbeat records a fresh `lastActivityAt` timestamp.

**Auth:** `X-Orcy-Remote-Key` + `heartbeat` scope + `Idempotency-Key`

**Response:** `{ "task": { "id", "status", "lastActivityAt" }, "acknowledged": true, "progress": "..." }`

#### POST /api/shared/tasks/:id/submit

Submits a claimed task for review.

**Auth:** `X-Orcy-Remote-Key` + `submit` scope + `Idempotency-Key`

**Body:** `{ "result": "...", "artifacts": [{ "kind": "...", "url": "...", "metadata": {} }] }`

**Response:** `{ "success": true, "task": { "id", "status", "submittedAt" } }`

#### POST /api/shared/tasks/:id/release

Releases a claimed task back to pending.

**Auth:** `X-Orcy-Remote-Key` + `release` scope + `Idempotency-Key`

**Body:** `{ "reason": "Cannot complete" }`

**Response:** `{ "task": Task }` (status: `pending`)

---

### Comments

#### GET /api/shared/tasks/:id/comments

Returns comments on a visible task.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

#### POST /api/shared/tasks/:id/comments

Adds a comment to a visible task. Creates an audit event with `actorType: "remote_orcy"`.

**Auth:** `X-Orcy-Remote-Key` + `comment` scope + `Idempotency-Key`

**Body:** `{ "content": "...", "parentId": "uuid" (optional) }`

**Response:** `{ "comment": TaskComment }`

#### GET /api/shared/missions/:id/comments

Returns comments on a visible mission.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

#### POST /api/shared/missions/:id/comments

Adds a comment to a visible mission.

**Auth:** `X-Orcy-Remote-Key` + `comment` scope + `Idempotency-Key`

---

### Pulse

#### GET /api/shared/missions/:id/pulse

Returns pulse signals on a visible mission.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

**Response:** `{ "items": Pulse[], "total": number }`

#### POST /api/shared/missions/:id/pulse

Posts a pulse signal on a visible mission.

**Auth:** `X-Orcy-Remote-Key` + `pulse.post` scope + `Idempotency-Key`

**Body:** `{ "signalType": "finding"|"blocker"|"offer"|..., "subject": "...", "body": "...", "taskId": "uuid" (optional) }`

**Response:** `{ "pulse": Pulse, "linkedTask": Task|null, "blockerTaskCreated": boolean }`

---

### Evidence Links

#### POST /api/shared/tasks/:id/evidence-links

Links URL/metadata-only evidence to a visible task. Branches, commits, and file changes are NOT allowed — remote participants cannot trigger repository scans.

**Auth:** `X-Orcy-Remote-Key` + `evidence_link` scope + `Idempotency-Key`

**Body:** `{ "url": "https://...", "metadata": {} }`

**Response:** `{ "link": { ... } }`

**Error:** 400 if `branch`, `commits`, or `changedFiles` are present in the body.

---

### Notifications

#### GET /api/shared/notifications

Returns the remote participant's notification inbox.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

#### GET /api/shared/notifications/history

Returns notification history (all statuses).

**Auth:** `X-Orcy-Remote-Key` + `read` scope

#### POST /api/shared/notifications/deliveries/:deliveryId/ack

Acknowledges a notification delivery.

**Auth:** `X-Orcy-Remote-Key` + `Idempotency-Key`

**Error:** 403 if the delivery belongs to a different recipient.

#### POST /api/shared/notifications/deliveries/:deliveryId/snooze

Snoozes a notification delivery.

**Auth:** `X-Orcy-Remote-Key` + `Idempotency-Key`

**Body:** `{ "snoozedUntil": "ISO timestamp" }`

---

### Trust Metadata

#### GET /api/shared/grants

Returns all grants for the current remote participant.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

**Response:** `{ "grants": RemoteGrantView[] }`

#### GET /api/shared/credentials/current

Returns credential metadata for the current credential. The raw secret is NEVER returned after creation.

**Auth:** `X-Orcy-Remote-Key` + `read` scope

**Response:**
```json
{
  "credential": {
    "id": "uuid",
    "credentialType": "mcp",
    "label": "Primary credential",
    "status": "active",
    "expiresAt": null,
    "lastUsedAt": "2026-06-14T10:00:00.000Z",
    "createdAt": "2026-06-14T09:00:00.000Z"
  }
}
```

**Note:** `secretHash` is NEVER included in the response.

---

### Error Responses

All Shared Habitat API errors follow the standard Orcy error format:

```json
{
  "statusCode": 403,
  "code": "GRANT_HARD_REVOKED",
  "error": "Forbidden",
  "message": "Remote action not permitted"
}
```

**Common error codes:**

| Code | Status | Meaning |
|------|--------|---------|
| `REMOTE_AUTH_REQUIRED` | 401 | Missing or invalid `X-Orcy-Remote-Key` |
| `INVALID_REMOTE_KEY` | 401 | Credential not found or expired |
| `GRANT_HARD_REVOKED` | 403 | Grant hard-revoked — all remote actions blocked |
| `GRANT_FROZEN` | 403 | Grant frozen — actions blocked pending host review |
| `TARGET_NOT_VISIBLE` | 403 | Task/mission not covered by any active grant |
| `TASK_NOT_OWNED` | 403 | Task not claimed by this participant |
| `HABITAT_MISMATCH` | 403 | Target belongs to a different habitat |
| `IDEMPOTENCY_KEY_REQUIRED` | 409 | Missing `Idempotency-Key` header on write route |
| `IDEMPOTENCY_KEY_MISMATCH` | 409 | Same key, different request body |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 | Concurrent request with same key still running |

**Note:** Error messages are intentionally generic to callers. Detailed reasons (which grant failed, which scopes are missing, which standing is required) are logged server-side only to prevent probing attacks.

---

### Remote MCP (v0.19)

Remote MCP clients connect to a host Orcy instance using `X-Orcy-Remote-Key` instead of `X-Agent-API-Key`. The MCP client reads `ORCY_REMOTE_KEY` from the environment and uses the `requestRemote()` method which sets the correct header and auto-generates `Idempotency-Key` for write actions.

**Configuration (environment variables):**

| Variable | Purpose |
|----------|---------|
| `ORCY_REMOTE_KEY` | Remote participant credential (the one-time secret shown at creation) |
| `ORCY_REMOTE_API_URL` | Host Orcy base URL (e.g., `https://orcy.example.com`) |
| `ORCY_REMOTE_POD_ID` | Optional: linked pod ID for metadata |

**Supported actions (allowlisted):**

Read actions: `habitats.get`, `habitats.listMissions`, `missions.get`, `tasks.get`, `tasks.listComments`, `missions.listComments`, `missions.listPulse`, `grants.list`, `credentials.current`, `notifications.list`, `notifications.history`

Write actions: `tasks.claim`, `tasks.heartbeat`, `tasks.submit`, `tasks.release`, `tasks.addComment`, `missions.addComment`, `tasks.addEvidenceLink`, `missions.postPulse`, `notifications.ack`, `notifications.snooze`

**NOT supported (will return error):**

- Task creation, deletion, approval, rejection
- Mission creation
- Repository scans, branch creation, PR creation
- Admin/daemon management
- Automation management
- Any action not in the allowlist

**Local MCP unchanged:** When `ORCY_REMOTE_KEY` is not set, the client uses `X-Agent-API-Key` and the local agent path. Both modes can coexist.

## Triage (v0.23)

All triage routes require `agentOrHumanAuth` (X-Agent-API-Key or Bearer JWT).

### Finding Triage Routes

#### GET /triage/findings

List finding triage records for a habitat.

| Query Param | Required | Description |
|-------------|----------|-------------|
| `habitatId` | Yes | Habitat UUID |
| `status` | No | Filter by status: `open`, `triaged`, `in_progress`, `resolved`, `wontfix` |
| `bucket` | No | Filter by routing bucket: `fix_now`, `defer_to_patch`, `defer_to_release`, `document_as_known_limitation`, `needs_investigation` |

**Response:** `{ findings: FindingTriageView[] }`

#### GET /triage/findings/:id

Get a single finding triage record.

**Response:** `{ finding: FindingTriageView }`

#### PATCH /triage/findings/:id

Transition status and/or set bucket. At least one of `status` or `bucket` must be provided. Status transitions are gated by the state machine (`open → triaged → in_progress → resolved | wontfix`); invalid transitions return `409 Conflict`.

| Body Field | Required | Description |
|------------|----------|-------------|
| `status` | No* | Target status (must be a valid transition from current) |
| `bucket` | No* | Routing bucket |

*At least one required.

**Response:** `{ finding: FindingTriageView }`

#### POST /triage/findings/:id/promote

Manually promote a deferred finding into active corrective work. Transitions `triaged → in_progress` and creates a corrective mission sourced from the finding's pulse context.

**Response:** `{ missionId: string }`

### Resolution Lookup

#### GET /triage/resolutions

Proactive lookup of historical resolutions by clusterKey.

| Query Param | Required | Description |
|-------------|----------|-------------|
| `habitatId` | Yes | Habitat UUID |
| `clusterKey` | Yes | Normalized signal subject to match |

**Response:** `{ resolutions: TriageResolutionView[] }`

### Cluster Summary

#### GET /triage/clusters/top

Top unresolved clusters for the UI/MCP summary. Aggregated from open/triaged finding-triage records grouped by clusterKey, joined with active cluster-mission status.

| Query Param | Required | Description |
|-------------|----------|-------------|
| `habitatId` | Yes | Habitat UUID |
| `limit` | No | Max results (default 10, max 100) |

**Response:** `{ clusters: ClusterSummaryView[] }` where each cluster has `{ clusterKey, signalCount, statuses[], findingKinds[], status: "under_investigation" | "awaiting_triage" }`
