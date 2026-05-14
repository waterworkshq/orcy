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
- [Prioritization](#prioritization)
- [Scheduled Tasks](#scheduled-tasks)
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

### POST /features/:id/apply-template/:templateId

Apply a feature template to an existing feature. Creates child tasks from the template's `tasksTemplate` array. Merges template properties (title pattern, description pattern, labels, domain, capabilities) into the feature.

**Auth:** JWT required (human)

**Request:**

```json
{}
```

**Response `200`:**

```json
{
  "feature": { "id": "feat-uuid", "title": "Fix: Login Bug", "..." },
  "createdTasks": [
    { "id": "task-uuid-1", "title": "Investigate root cause", "order": 0 },
    { "id": "task-uuid-2", "title": "Implement fix", "order": 1 }
  ],
  "message": "Applied template and created 2 tasks"
}
```

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
| `task.priority_changed` | `{ taskId, ruleName, score }` | Task priority changed by rule engine |
| `scheduled_task.executed` | `{ scheduleId, featureId, featureTitle }` | Scheduled task created a feature |
| `scheduled_task.failed` | `{ scheduleId, error }` | Scheduled task execution failed |
| `scheduled_task.created` | `{ scheduleId, name }` | New scheduled task configured |
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
