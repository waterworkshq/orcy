---
name: orcy-mcp-usage
description: Complete reference for the orcy MCP dispatch tools — orcy_habitat, orcy_habitat_mission, orcy_habitat_task, orcy_habitat_agent, orcy_suggest, orcy_habitat_message, orcy_habitat_subscription, orcy_admin, orcy_worktree
license: MIT
---

# Orcy MCP Usage

This skill covers using Orcy via **MCP tools** from within an AI agent session. All tools use a **dispatch pattern** with a consolidated `action` parameter.

If you also have the CLI installed, **prefer MCP for intra-session tool use** — structured input/output integrates better with agent reasoning than shell parsing.

---

## Consolidated Dispatch Tools

| Tool | Actions | Covers |
|------|---------|--------|
| `orcy_habitat` | `list`, `find`, `get-settings`, `update-settings`, `summary`, `metrics` | Habitat-level operations |
| `orcy_habitat_mission` | `list`, `create`, `delete`, `archive`, `unarchive`, `get-context` | Mission CRUD and lifecycle |
| `orcy_habitat_task` | `list-in-mission`, `create-in-mission`, `update`, `delete`, `claim`, `submit`, `complete`, `release`, `retry`, `get-context`, `get-events`, `get-comments`, `add-comment`, `get-time-report`, `get-blocked-status`, `get-approval-status`, `add-dependency`, `remove-dependency`, `get-quality-checklist`, `update-quality-checklist-item`, `validate-quality-gates`, `list-subtasks`, `create-subtask`, `delete-subtask` | Full task lifecycle, history, quality, dependencies, subtasks |
| `orcy_habitat_agent` | `register`, `list`, `heartbeat`, `get-stats` | Agent registration and presence |
| `orcy_suggest` | `suggest-next-task` | AI-ranked task recommendations |
| `orcy_habitat_message` | `send`, `get-messages` | Cross-agent communication |
| `orcy_habitat_subscription` | `subscribe`, `unsubscribe` | Real-time event subscriptions |
| `orcy_admin` | `list-webhooks`, `create-webhook`, `delete-webhook`, `list-templates`, `create-template`, `delete-template`, `batch-assign-tasks`, `batch-set-priority`, `batch-delete-tasks` | Admin operations |
| `orcy_worktree` | `get-worktree` | Git worktree for tasks |

---

## Startup Sequence

When an agent starts a session:

```
1. Read ORCY_HABITAT_ID and ORCY_AGENT_ID from environment
2. Read orcy_instructions() to get the skill guide
3. Call orcy_habitat_agent({ action: "heartbeat" }) to register presence
4. Call orcy_habitat({ action: "summary", boardId }) to understand board state
5. Call orcy_habitat_mission({ action: "list", boardId }) to browse missions
6. Call orcy_habitat_mission({ action: "get-context", featureId }) for mission brief
7. Call orcy_suggest({ action: "suggest-next-task", boardId }) to find work
8. Call orcy_habitat_task({ action: "claim", taskId }) to lock a task
9. Begin work
```

---

## Habitat — `orcy_habitat`

### Summary

**Call this first.** Get a compact temporal overview of what was done, by whom, and when. Prevents N+1 loading of individual missions.

```
orcy_habitat({ action: "summary", boardId: "uuid", since: "7d", maxTasks: 20, includeDigest: true })

Input:
{
  "action": "summary",
  "boardId": "uuid-of-board",
  "since": "7d",           // 24h, 7d, 30d, all (default: 7d)
  "maxTasks": 20,          // 1-50 (default: 20)
  "includeDigest": true    // include markdown digest
}

Output:
{
  "board": { "name": "Sprint 24", "columns": [...], "totalFeatures": 8, "totalTasks": 21 },
  "snapshot": {
    "byStatus": { "not_started": 2, "in_progress": 3, "review": 1, "done": 2 },
    "byPriority": { "high": 4, "medium": 12, ... },
    "activeAgents": [{ "name": "coding-agent-1", "currentTask": "Fix login bug" }],
    "missionProgress": [
      { "featureId": "...", "title": "Auth System", "status": "in_progress", "completed": 2, "total": 5 }
    ]
  },
  "recentActivity": [...],
  "digest": "# Board Summary: Sprint 24\n\n## Current State\n..."
}
```

### List Habitats

```
orcy_habitat({ action: "list" })
Output: { "boards": [{ "id": "uuid", "name": "Sprint 24", "description": "..." }] }
```

### Find Habitat

```
orcy_habitat({ action: "find", name: "sprint" })
Output: { "boards": [{ "id": "uuid", "name": "Sprint 24", ... }] }
```

### Get Settings

```
orcy_habitat({ action: "get-settings", boardId: "uuid" })
Output: { "board": { "name": "Sprint 24", "description": "...", ... } }
```

### Update Settings

```
orcy_habitat({ action: "update-settings", boardId: "uuid", name: "Sprint 25", description: "..." })
```

### Metrics

```
orcy_habitat({ action: "metrics", boardId: "uuid" })
Output: { "averageCycleTime": 45, "overdueTasks": 2, "agentMetrics": [...] }
```

---

## Missions — `orcy_habitat_mission`

### List Missions

```
orcy_habitat_mission({ action: "list", boardId: "uuid", status: "in_progress", priority: "high", isArchived: false, limit: 20 })

Output:
{
  "features": [
    {
      "id": "feat-uuid",
      "title": "Implement Authentication",
      "status": "in_progress",
      "priority": "high",
      "description": "...",
      "acceptanceCriteria": "...",
      "labels": ["security", "auth"],
      "columnId": "col-uuid",
      "dependsOn": [],
      "blocks": [],
      "dueAt": null,
      "progress": { "completed": 2, "total": 5, "percentage": 40 },
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "total": 8
}
```

### Create Mission

```
orcy_habitat_mission({
  action: "create",
  boardId: "uuid",
  title: "User Authentication",
  description: "Implement JWT-based auth",
  acceptanceCriteria: "Users can sign in",
  priority: "high",
  labels: ["security", "auth"],
  dependsOn: ["other-feat-uuid"],
  dueAt: "2025-06-01T00:00:00Z",
  slaMinutes: 1440
})

Output: { "feature": { "id": "new-feat-uuid", "status": "not_started", ... } }
```

### Get Mission Context

**Call this before claiming a task.** Shows the mission brief, all tasks with their statuses and results, and dependencies.

```
orcy_habitat_mission({ action: "get-context", featureId: "feat-uuid" })

Output:
{
  "feature": {
    "id": "feat-uuid", "title": "Implement Authentication",
    "description": "...", "acceptanceCriteria": "...",
    "status": "in_progress", "priority": "high",
    "labels": ["security", "auth"],
    "progress": { "completed": 2, "total": 5, "percentage": 40 }
  },
  "tasks": [
    { "id": "t-1", "title": "Create JWT middleware", "status": "done", "result": "...", "assignedAgentId": "agent-uuid" },
    { "id": "t-2", "title": "Add login endpoint", "status": "pending", "assignedAgentId": null }
  ],
  "events": [{ "action": "created", "timestamp": "...", ... }],
  "progress": { "completed": 2, "total": 5, "byStatus": { "done": 2, "pending": 3 } },
  "dependencies": { "dependsOn": [], "blocks": [] }
}
```

### List Archived Missions

```
orcy_habitat_mission({ action: "list", boardId: "uuid", isArchived: true, limit: 20 })
Output: { "features": [...], "total": 2 }
```

### Archive Mission

Mission must have status `done` to be archived.

```
orcy_habitat_mission({ action: "archive", featureId: "feat-uuid" })
Output: { "success": true, "feature": { "id": "feat-uuid", "isArchived": true, ... } }
```

### Unarchive Mission

```
orcy_habitat_mission({ action: "unarchive", featureId: "feat-uuid" })
Output: { "success": true, "feature": { "id": "feat-uuid", "isArchived": false, ... } }
```

### Delete Mission

Permanent. Deletes all child tasks too.

```
orcy_habitat_mission({ action: "delete", featureId: "feat-uuid" })
Output: { "success": true, "featureId": "feat-uuid", "message": "Feature feat-uuid deleted" }
```

---

## Tasks — `orcy_habitat_task`

### List Tasks in Mission

```
orcy_habitat_task({ action: "list-in-mission", featureId: "feat-uuid" })

Output:
{
  "tasks": [
    {
      "id": "task-uuid", "title": "Create JWT middleware",
      "status": "pending", "priority": "high",
      "requiredDomain": "backend",
      "requiredCapabilities": ["typescript", "nodejs"],
      "estimatedMinutes": 60,
      "assignedAgentId": null
    }
  ],
  "total": 5
}
```

### Create Task

```
orcy_habitat_task({
  action: "create-in-mission",
  featureId: "feat-uuid",
  title: "Add refresh token rotation",
  description: "7-day expiry rotation",
  priority: "medium",
  requiredDomain: "backend",
  requiredCapabilities: ["typescript", "postgresql"],
  estimatedMinutes: 120
})

Output: { "task": { "id": "new-task-uuid", "status": "pending", "featureId": "feat-uuid", ... } }
```

### Claim Task

Atomically locks the task to your agent. Only one agent can claim at a time.

```
orcy_habitat_task({ action: "claim", taskId: "uuid" })

Success: { "success": true, "task": { "id": "...", "status": "claimed", "assignedAgentId": "agent-uuid" } }
Failure (already claimed): { "success": false, "reason": "already_claimed" }
Failure (capability): { "success": false, "reason": "capability_mismatch", "missingCapabilities": ["postgresql"] }
Failure (domain): { "success": false, "reason": "domain_mismatch" }
Failure (dependencies): { "success": false, "reason": "dependencies_unmet" }
```

### Get Task Context

Full task details including parent mission, siblings, dependencies, and board context.

```
orcy_habitat_task({ action: "get-context", taskId: "uuid" })

Output:
{
  "task": { /* full task object */ },
  "feature": { "id": "feat-uuid", "title": "Implement Authentication", "description": "...", "acceptanceCriteria": "..." },
  "siblingTasks": [
    { "id": "t-1", "title": "Create JWT middleware", "status": "done", "result": "..." },
    { "id": "t-2", "title": "Add login endpoint", "status": "pending" }
  ],
  "dependencies": [],
  "blockedBy": [],
  "blocking": [],
  "boardContext": { "name": "Sprint 24", "columns": [...] }
}
```

### Update Task

Modify task fields. When `status` is provided, routes to the lifecycle endpoint:

| Status | Behavior | Quality Gates |
|--------|----------|---------------|
| `in_progress` | POST /tasks/:id/start | n/a |
| `submitted` | POST /tasks/:id/submit | n/a |
| `approved` | PATCH /tasks/:id (human override) | Skipped |
| `done` | POST /tasks/:id/complete | Enforced |
| `failed` | POST /tasks/:id/fail | n/a |

```
orcy_habitat_task({ action: "update", taskId: "uuid", status: "in_progress", title: "Updated title", priority: "high" })

Input:
{
  "action": "update",
  "taskId": "uuid",
  "status": "in_progress",    // optional: routes to lifecycle endpoint
  "title": "Updated title",
  "priority": "high",
  "version": 3                // optimistic locking
}
```

### Submit Task

Submit completed work for review. Triggers mission status recalculation.

```
orcy_habitat_task({
  action: "submit",
  taskId: "uuid",
  result: "Implemented the login redirect fix. Changes in auth.ts and router.ts.",
  artifacts: [
    { type: "pr", url: "https://github.com/org/repo/pull/42", description: "Fix login redirect" }
  ]
})

Output: { "success": true, "task": { "id": "uuid", "status": "submitted" }, "message": "Task submitted for review." }
```

### Complete Task (Self-Approval)

Gated completion. Validates quality gates, dependencies, and time tracking before moving to `done`. Task must be in `submitted` or `approved` status.

```
orcy_habitat_task({
  action: "complete",
  taskId: "uuid",
  reviewNote: "All tests pass. Code reviewed.",
  artifacts: []
})

Output: { "success": true, "task": { "status": "done" }, "message": "Task completed." }
```

**Quality gates enforced:** All checklist items complete, dependencies resolved, time tracking calculated, artifacts merged.

### Release Task

Give a claimed task back to the pool.

```
orcy_habitat_task({ action: "release", taskId: "uuid", reason: "blocked_by_dependency" })
Output: { "success": true, "task": { "id": "uuid", "status": "pending", "assignedAgentId": null } }
```

### Retry Task

Move a failed task back to pending for rework.

```
orcy_habitat_task({ action: "retry", taskId: "uuid" })
Output: { "success": true, "task": { "status": "pending" } }
```

### Delete Task

```
orcy_habitat_task({ action: "delete", taskId: "uuid" })
Output: { "success": true, "taskId": "uuid" }
```

---

## Task Events & Comments — `orcy_habitat_task`

### Get Events

```
orcy_habitat_task({ action: "get-events", taskId: "uuid", limit: 20, offset: 0 })
Output: { "events": [{ "action": "created", "actorId": "...", "timestamp": "..." }], "total": 12 }
```

### Get Comments

Use after rejection to read reviewer feedback.

```
orcy_habitat_task({ action: "get-comments", taskId: "uuid", limit: 50, offset: 0 })
Output: { "comments": [{ "content": "Please add tests for edge cases", ... }], "total": 3 }
```

### Add Comment

```
orcy_habitat_task({ action: "add-comment", taskId: "uuid", content: "Working on the edge case tests now", parentId: "parent-comment-uuid" })
Output: { "success": true, "comment": { ... } }
```

---

## Subtasks — `orcy_habitat_task`

### List Subtasks

```
orcy_habitat_task({ action: "list-subtasks", taskId: "uuid" })
Output: { "subtasks": [{ "id": "sub-uuid", "title": "Write unit tests", "completed": false, "assigneeId": null }] }
```

### Create Subtask

```
orcy_habitat_task({ action: "create-subtask", taskId: "uuid", title: "Write unit tests", order: 1, assigneeId: "agent-uuid" })
Output: { "subtask": { "id": "sub-uuid", "title": "Write unit tests", "completed": false } }
```

### Delete Subtask

```
orcy_habitat_task({ action: "delete-subtask", taskId: "uuid", subtaskId: "sub-uuid" })
Output: { "success": true }
```

### Update Subtask Completion

```
orcy_habitat_task({ action: "update", taskId: "uuid", subtaskId: "sub-uuid", subtaskCompleted: true })
```

---

## Quality Gates & Dependencies — `orcy_habitat_task`

### Get Quality Checklist

```
orcy_habitat_task({ action: "get-quality-checklist", taskId: "uuid" })
Output: { "taskId": "uuid", "canApprove": false, "checklists": [{ "category": "Testing", "items": [...], "category": "Code Review", "items": [...] }] }
```

### Update Quality Checklist Item

```
orcy_habitat_task({
  action: "update-quality-checklist-item",
  taskId: "uuid",
  checklistId: "uuid",
  itemId: "uuid",
  isCompleted: true,
  evidenceUrl: "https://github.com/org/repo/actions/runs/123",
  notes: "All tests pass"
})
```

### Validate Quality Gates

Called automatically by `complete`. Useful to check before attempting completion.

```
orcy_habitat_task({ action: "validate-quality-gates", taskId: "uuid" })
Output: { "passed": false, "failures": [{ "category": "Testing", "missingItems": ["Unit tests required"] }] }
```

### Get Approval Status

```
orcy_habitat_task({ action: "get-approval-status", taskId: "uuid" })
Output: { "canBeApproved": false, "reasons": ["Quality checklist incomplete"], "requirements": { "qualityChecklist": {...}, "dependencies": {...}, "timeTracking": {...} } }
```

### Get Blocked Status

```
orcy_habitat_task({ action: "get-blocked-status", taskId: "uuid" })
Output: { "isBlocked": true, "blockedBy": [{ "taskId": "uuid", "title": "Create JWT middleware", "status": "pending" }] }
```

### Add Dependency

```
orcy_habitat_task({ action: "add-dependency", taskId: "uuid", dependsOnTaskId: "prerequisite-task-uuid" })
Output: { "success": true }
```

### Remove Dependency

```
orcy_habitat_task({ action: "remove-dependency", taskId: "uuid", dependencyTaskId: "prerequisite-task-uuid" })
Output: { "success": true }
```

### Get Time Report

```
orcy_habitat_task({ action: "get-time-report", taskId: "uuid" })
Output: { "estimatedMinutes": 120, "actualMinutes": 95, "cycleTimeMinutes": 180, "estimationAccuracy": 0.79 }
```

---

## Agent Management — `orcy_habitat_agent`

### Register Agent

Required first time. The response includes your API key.

```
orcy_habitat_agent({
  action: "register",
  name: "coding-agent-1",
  type: "claude-code",
  domain: "backend",
  capabilities: "typescript,postgresql,docker"
})

Output: { "agent": { "id": "agent-uuid", "name": "coding-agent-1", ... }, "apiKey": "sk-..." }
```

### List Agents

```
orcy_habitat_agent({ action: "list", status: "working", domain: "backend" })
Output: { "agents": [...] }
```

### Heartbeat

Call every 5 minutes while working to prevent stale release (30 min timeout).

```
orcy_habitat_agent({ action: "heartbeat", taskId: "current-task-uuid", progress: "Halfway through implementing the redirect logic" })
Output: { "success": true, "agentStatus": "working", "nextCheckIn": 300, "taskStatus": "in_progress" }
```

### Get Stats

```
orcy_habitat_agent({ action: "get-stats" })
Output: { "agentId": "agent-uuid", "stats": { "completed": 12, "failed": 1, "avgCycleTime": 180, ... } }
```

---

## Suggestions — `orcy_suggest`

### Suggest Next Task

AI-ranked recommendations based on priority, urgency, your capabilities, workload, and specialization across all missions.

```
orcy_suggest({ action: "suggest-next-task", boardId: "sprint-24-uuid", limit: 3 })

Output:
{
  "suggestions": [
    { "taskId": "t-2", "taskTitle": "Add refresh token rotation", "score": 0.92, "reasons": ["High priority", "Matches domain"] }
  ]
}
```

---

## Messaging — `orcy_habitat_message`

### Send Message

Provide either `toAgentId` or `toAgentName` (resolved automatically).

```
orcy_habitat_message({
  action: "send",
  boardId: "board-uuid",
  subject: "Need help with database migration",
  body: "Can you review the schema changes?",
  toAgentName: "coding-agent-2",
  taskId: "optional-task-uuid",
  messageType: "request",     // info, request, response, alert
  priority: "normal"          // low, normal, high, urgent
})
```

### Get Messages

```
orcy_habitat_message({ action: "get-messages", unreadOnly: true, taskId: "optional-task-uuid", limit: 50, offset: 0 })
Output: { "messages": [...], "total": 3, "unreadCount": 1 }
```

---

## Subscriptions — `orcy_habitat_subscription`

Subscribe to real-time board events via MCP notifications.

```
orcy_habitat_subscription({ action: "subscribe", boardId: "uuid" })
orcy_habitat_subscription({ action: "unsubscribe", boardId: "uuid" })
```

---

## Admin — `orcy_admin`

### Webhooks

```
# Create
orcy_admin({
  action: "create-webhook",
  boardId: "uuid",
  name: "Slack notifications",
  url: "https://hooks.slack.com/...",
  events: ["task.created", "task.completed", "task.rejected"],
  format: "slack"              // standard, slack, discord
})

# List
orcy_admin({ action: "list-webhooks", boardId: "uuid" })
Output: { "webhooks": [...] }

# Delete
orcy_admin({ action: "delete-webhook", webhookId: "webhook-uuid" })
```

### Templates

```
# Create
orcy_admin({
  action: "create-template",
  boardId: "uuid",
  name: "Bug Fix",
  titlePattern: "Fix: {title}",
  descriptionPattern: "Bug description: {description}",
  priority: "high",
  labels: ["bug"],
  domain: "backend"
})

# List
orcy_admin({ action: "list-templates", boardId: "uuid" })
Output: { "templates": [...] }

# Delete
orcy_admin({ action: "delete-template", templateId: "template-uuid" })
```

### Batch Operations

```
# Assign tasks
orcy_admin({
  action: "batch-assign-tasks",
  boardId: "uuid",
  taskIds: ["task-uuid-1", "task-uuid-2"],
  agentId: "agent-uuid"
})

# Set priority
orcy_admin({
  action: "batch-set-priority",
  boardId: "uuid",
  taskIds: ["task-uuid-1", "task-uuid-2"],
  priority: "critical"
})

# Delete tasks
orcy_admin({
  action: "batch-delete-tasks",
  boardId: "uuid",
  taskIds: ["task-uuid-1", "task-uuid-2"]
})
```

---

## Worktree — `orcy_worktree`

### Get Worktree

```
orcy_worktree({ action: "get-worktree", taskId: "uuid" })
Output: { "worktree": { "path": "/repo/worktrees/task-uuid", "branch": "task/fix-login", "repoRoot": "/repo" }, "enabled": true }
```

---

## Task Lifecycle for Agents

### Path A: Self-Approval (Gated — Recommended)

```
1. orcy_habitat({ action: "summary", boardId })                               → Understand the board
2. orcy_habitat_mission({ action: "list", boardId })                          → Browse missions
3. orcy_habitat_mission({ action: "get-context", featureId })                 → Read mission brief
4. orcy_suggest({ action: "suggest-next-task", boardId })                   → Find best task
5. orcy_habitat_task({ action: "claim", taskId })                             → Claim it
6. orcy_habitat_task({ action: "get-context", taskId })                       → Full task details
7. orcy_habitat_task({ action: "update", taskId, status: "in_progress" })     → Start working
8. [ Work on the task; heartbeat every 5 min ]
9. orcy_habitat_task({ action: "submit", taskId, result, artifacts })         → Submit
10. orcy_habitat_task({ action: "complete", taskId, reviewNote, artifacts })  → Gated completion
11. Claim next task
```

### Path B: Human Review

```
1. orcy_habitat({ action: "summary", boardId })                               → Understand the board
2. orcy_habitat_mission({ action: "list", boardId })                          → Browse missions
3. orcy_habitat_mission({ action: "get-context", featureId })                 → Read mission brief
4. orcy_suggest({ action: "suggest-next-task", boardId })                   → Find best task
5. orcy_habitat_task({ action: "claim", taskId })                             → Claim it
6. orcy_habitat_task({ action: "get-context", taskId })                       → Full task details
7. orcy_habitat_task({ action: "update", taskId, status: "in_progress" })     → Start working
8. [ Work on the task ]
9. orcy_habitat_task({ action: "submit", taskId, result, artifacts })         → Submit for review
10. orcy_habitat_agent({ action: "heartbeat" })                               → Stay alive
11a. If approved: orcy_habitat_task({ action: "update", taskId, status: "done" })
11b. If rejected: orcy_habitat_task({ action: "get-comments", taskId }), rework, resubmit
```

### Rejection Recovery

```
1. orcy_habitat_task({ action: "get-comments", taskId })                      → Read feedback
2. Address the rejection reason
3. orcy_habitat_task({ action: "submit", taskId, result, artifacts })         → Resubmit
```

---

## Example Agent Session

```
# Agent starts
> orcy_habitat_agent({ action: "heartbeat" })
{ "success": true, "agentStatus": "idle", "nextCheckIn": 300 }

# Understand the board
> orcy_habitat({ action: "summary", boardId: "sprint-24-uuid", since: "7d" })
{
  "digest": "# Board Summary: Sprint 24\n\n## Current State\n**Columns:** Backlog: 3 | In Progress: 2 | Review: 1 | Done: 3\n**Total features:** 9 | **Total tasks:** 24\n\n## Mission Progress\n- Auth System: 3/5 tasks done (in_progress)\n- Rate Limiting: done\n- Dashboard UI: 0/4 tasks (not_started)\n\n## Activity: Today\nCompleted: 2 tasks | Created: 1 mission | Rejected: 0",
  ...
}

# Browse missions
> orcy_habitat_mission({ action: "list", boardId: "sprint-24-uuid" })
{
  "features": [
    { "id": "feat-1", "title": "Auth System", "status": "in_progress", "progress": { "completed": 3, "total": 5 } },
    { "id": "feat-2", "title": "Dashboard UI", "status": "not_started", "progress": { "completed": 0, "total": 4 } }
  ]
}

# Read mission context before claiming
> orcy_habitat_mission({ action: "get-context", featureId: "feat-1" })
{
  "feature": { "title": "Auth System", "description": "...", "acceptanceCriteria": "..." },
  "tasks": [
    { "id": "t-1", "title": "Create JWT middleware", "status": "done", "result": "..." },
    { "id": "t-2", "title": "Add refresh token rotation", "status": "pending" }
  ]
}

# Get AI suggestion
> orcy_suggest({ action: "suggest-next-task", boardId: "sprint-24-uuid" })
{
  "suggestions": [
    { "taskId": "t-2", "taskTitle": "Add refresh token rotation", "score": 0.92, "reasons": ["High priority", "Matches domain"] }
  ]
}

# Claim it
> orcy_habitat_task({ action: "claim", taskId: "t-2" })
{ "success": true, "task": { "id": "t-2", "status": "claimed", ... } }

# Get full context
> orcy_habitat_task({ action: "get-context", taskId: "t-2" })
{
  "task": { "title": "Add refresh token rotation", "description": "...", ... },
  "feature": { "title": "Auth System", "acceptanceCriteria": "..." },
  "siblingTasks": [...]
}

# Work on it...
> orcy_habitat_agent({ action: "heartbeat", taskId: "t-2", progress: "Implementing token rotation" })

# Submit
> orcy_habitat_task({
    action: "submit",
    taskId: "t-2",
    result: "Implemented refresh token rotation with 7-day expiry...",
    artifacts: [{ type: "pr", url: "https://github.com/org/repo/pull/42", description: "..." }]
  })
{ "success": true, "task": { "status": "submitted" }, "message": "Task submitted for review." }

# Self-approve (gated)
> orcy_habitat_task({ action: "complete", taskId: "t-2", reviewNote: "All tests pass" })
{ "success": true, "task": { "status": "done" }, "message": "Task completed." }
```

---

## Best Practices

1. **Summary first** — Always call `orcy_habitat({ action: "summary" })` before diving into individual missions
2. **Mission context before claiming** — Use `orcy_habitat_mission({ action: "get-context" })` to understand the mission brief and sibling task results
3. **Use suggestions** — `orcy_suggest({ action: "suggest-next-task" })` picks better than manual browsing
4. **Always heartbeat** — Call `orcy_habitat_agent({ action: "heartbeat" })` every 5 minutes to prevent stale release
5. **Submit artifacts** — Always link a PR or commit, even for small fixes
6. **Write clear results** — Human reviewers need to understand what you did
7. **Respect domain** — Only claim tasks in your assigned domain
8. **Handle rejection gracefully** — Read comments, fix it, resubmit
9. **One task at a time** — Don't hoard tasks; submit current work before claiming more
10. **Check mission dependencies** — Missions with unmet dependencies won't show their tasks
11. **Communicate** — Use `orcy_habitat_message({ action: "send" })` when you need help from another agent

---

## Error Handling

### Claim Failures

```
{ "success": false, "reason": "already_claimed" }
{ "success": false, "reason": "not_found" }
{ "success": false, "reason": "domain_mismatch" }           // agent domain != task requiredDomain
{ "success": false, "reason": "dependencies_unmet" }         // prerequisite task not done
{ "success": false, "reason": "capability_mismatch", "missingCapabilities": ["react"] }
```

If claim fails, try the next available task. Do not retry the same task.

### Stale Tasks

If disconnected for more than 30 minutes while holding a task, it is auto-released. Call `orcy_habitat_agent({ action: "heartbeat" })` every 5 minutes while working. On reconnection, call `orcy_habitat({ action: "summary" })` to find work.
