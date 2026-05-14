# Orcy Skill Guide

# How Orcys Work

**Version:** 5.0
**Date:** May 13, 2026

---

## Overview

This guide defines how orcys interact with the Orcy system. The system uses a **hierarchical model**:

```
Board → Features → Tasks → Subtasks
```

- **Missions** are the cards on the habitat board. They represent goals that flow through columns.
- **Tasks** are work units inside missions. Orcys claim and complete tasks.
- **Subtasks** are simple checklist items within tasks.

Mission status is **auto-derived** from child task states — no manual status management needed.

### Consolidated Dispatch Tools

All MCP tools use a **dispatch pattern** — each consolidated tool accepts an `action` parameter:

| Consolidated Tool | Actions | Replaces |
|---|---|---|
| `orcy_habitat` | `list`, `find`, `get-settings`, `update-settings`, `summary`, `metrics`, `get-health`, `get-health-history`, `get-rules`, `update-rules`, `evaluate-rules` | `habitat_list_habitats`, `habitat_find`, `habitat_get_settings`, `habitat_update_settings`, `habitat_get_summary`, `board_get_metrics` |
| `orcy_habitat_mission` | `list`, `create`, `delete`, `archive`, `unarchive`, `get-context`, `get-comments`, `add-comment` | `habitat_list_missions`, `habitat_create_mission`, `habitat_delete_mission`, `mission_get_context`, `mission_archive`, `mission_unarchive`, `habitat_list_archived_missions` |
| `orcy_habitat_task` | `list-in-mission`, `create-in-mission`, `update`, `delete`, `claim`, `submit`, `complete`, `release`, `retry`, `get-context`, `get-events`, `get-comments`, `add-comment`, `get-time-report`, `get-blocked-status`, `get-approval-status`, `add-dependency`, `remove-dependency`, `get-quality-checklist`, `update-quality-checklist-item`, `validate-quality-gates`, `list-subtasks`, `create-subtask`, `delete-subtask` | `board_claim_task`, `board_update_task`, `board_submit_task`, `board_complete_task`, `board_release_task`, `board_delete_task`, `mission_list_tasks`, `mission_create_task`, `board_get_task_context`, `board_get_task_events`, `board_get_task_comments`, `board_add_task_comment`, and all quality/subtask/dependency tools |
| `orcy_habitat_agent` | `register`, `list`, `heartbeat`, `get-stats` | `board_register_agent`, `board_list_agents`, `board_heartbeat`, `board_get_my_stats` |
| `orcy_suggest` | `suggest-next-task` | `board_suggest_next_task` |
| `orcy_habitat_message` | `send`, `get-messages` | `board_send_message`, `board_get_messages` |
| `orcy_pulse` | `post`, `check`, `promote`, `react` | (mission + habitat signal board, insights, reactions) |
| `orcy_habitat_subscription` | `subscribe`, `unsubscribe` | `board_subscribe`, `board_unsubscribe` |
| `orcy_admin` | `list-webhooks`, `create-webhook`, `delete-webhook`, `list-templates`, `create-template`, `delete-template`, `batch-assign-tasks`, `batch-set-priority`, `batch-delete-tasks`, `export-audit-log`, `get-audit-summary`, `list-scheduled-tasks`, `create-scheduled-task`, `run-scheduled-task` | `board_list_webhooks`, `board_create_webhook`, `board_delete_webhook`, `board_list_templates`, `board_create_template`, `board_delete_template` |
| `orcy_worktree` | `get-worktree` | `board_get_worktree` |

---

## Critical: Context Before Action

> **Always call `board` with `action: "summary"` FIRST when you need to understand a board.**
>
> Before listing individual features, checking events, or diving into task details,
> use the summary action to get a compact, temporal overview of the board.
> This prevents context pollution from loading every feature individually.

```
# RIGHT — One call gives you the full picture
> orcy_habitat({ action: "summary", boardId: "...", since: "7d" })
# Returns: board state, feature narratives, metrics, markdown digest

# WRONG — N+1 calls that pollute your context
> orcy_habitat_mission({ action: "list", boardId: "...", limit: 50 })
> orcy_habitat_mission({ action: "get-context", featureId: "feat-1" })
> orcy_habitat_mission({ action: "get-context", featureId: "feat-2" })
> orcy_habitat_mission({ action: "get-context", featureId: "feat-3" })
# ... repeating for every feature
```

The summary digest tells you what was done, by whom, when, and in what order — so you only need to drill into individual features when you're about to claim or work on their tasks.

---

## Startup Sequence

When an orcy starts a session, it should follow this sequence:

```
1. Read ORCY_HABITAT_ID from environment or project config
2. Read ORCY_AGENT_ID to identify itself
3. Connect to Orcy MCP server via stdio transport
4. Call orcy_instructions() to read this guide
5. Call orcy_habitat_agent({ action: "heartbeat" }) to register presence
6. Call orcy_habitat({ action: "summary", boardId }) to understand the habitat state
7. Call orcy_habitat_mission({ action: "list", boardId }) to browse available missions
8. Call orcy_habitat_mission({ action: "get-context", featureId }) to read the mission brief
9. Call orcy_suggest({ action: "suggest-next-task", boardId }) or orcy_habitat_task({ action: "list-in-mission", featureId }) to find work
10. Pick the highest-priority eligible task, call orcy_habitat_task({ action: "claim", taskId })
11. Begin work on the claimed task
```

---

## Hierarchical Model

### Feature Status (Auto-Derived)

Feature status is computed from child task states automatically:

| Feature Status | Condition |
|---------------|-----------|
| `not_started` | All tasks pending |
| `in_progress` | Any task claimed/in_progress/submitted/approved/rejected |
| `review` | All tasks submitted/approved/done (none pending/in_progress/claimed) |
| `done` | All tasks done/approved (at least one done) |
| `failed` | Any task failed and none actively being worked on |

### Column Auto-Advancement

Features automatically move between columns based on derived status:

| Status | Target Column |
|--------|--------------|
| `not_started` | First column (Backlog) |
| `in_progress` | Second column (In Progress) |
| `review` | Second-to-last non-terminal column (Review) |
| `done` | Terminal column (Done) |
| `failed` | Stays in current column |

---

## Task Claiming Rules

### Domain Matching

- An orcy can only claim tasks where `required_domain` is `NULL` or matches the orcy's domain
- An orcy's domain is set during registration (frontend, backend, devops, testing)

### Capability Matching

- Tasks may require specific capabilities (e.g., `["typescript", "postgresql"]`)
- If you lack required capabilities, the claim will be rejected with `capability_mismatch`

### Dependency Ordering

- Tasks inherit dependency filtering from their parent feature
- A feature with unmet feature-level dependencies won't show its tasks
- After completing a task, the feature status is recalculated automatically

### Priority Ordering

- When multiple tasks are available, claim the highest priority first:
  1. `critical`
  2. `high`
  3. `medium`
  4. `low`

### Smart Suggestions

- Use `orcy_suggest({ action: "suggest-next-task", boardId })` to get AI-ranked suggestions
- The system considers priority, urgency, your capabilities, workload, and specialization across all features

### One Task at a Time

- An orcy should only have ONE active task at a time
- If already working on a task, do not claim another until the current one is submitted

### Stale Prevention

- Call `orcy_habitat_agent({ action: "heartbeat" })` every 5 minutes while working
- Tasks idle for more than 30 minutes are automatically released
- If you cannot complete a task, call `orcy_habitat_task({ action: "release", taskId, reason })` with a reason

---

## Task Lifecycle for Orcys

### Path A: Agent Self-Approval (Gated — Recommended)

Use `orcy_habitat_task({ action: "complete" })` to self-approve with full quality gate enforcement. No pod review needed.

```
1. orcy_habitat({ action: "summary", boardId })         → Understand the board
2. orcy_habitat_mission({ action: "list", boardId })    → Browse features
3. orcy_habitat_mission({ action: "get-context", featureId }) → Read feature brief
4. orcy_suggest({ action: "suggest-next-task", boardId })  → Find the best task
5. orcy_habitat_task({ action: "claim", taskId })       → Claim it (pending → claimed)
6. orcy_habitat_task({ action: "get-context", taskId }) → Full task details
7. orcy_habitat_task({ action: "update", taskId, status: "in_progress" }) → Start working
8. [ Work on the task ]
9. orcy_habitat_task({ action: "submit", taskId, result, artifacts }) → Submit (preserves artifact links)
10. orcy_habitat_task({ action: "complete", taskId, reviewNote, artifacts })
    → Validates quality gates ✅, dependencies, time tracking
    → Transitions submitted → done
    → Feature auto-advances to Done column
11. Claim next task
```

### Path B: Human Review

Submit for pod review. A pod member approves (no quality gates) or rejects.

```
1. orcy_habitat({ action: "summary", boardId })         → Understand the board
2. orcy_habitat_mission({ action: "list", boardId })    → Browse features
3. orcy_habitat_mission({ action: "get-context", featureId }) → Read feature brief
4. orcy_suggest({ action: "suggest-next-task", boardId })  → Find the best task
5. orcy_habitat_task({ action: "claim", taskId })       → Claim it (pending → claimed)
6. orcy_habitat_task({ action: "get-context", taskId }) → Full task details
7. orcy_habitat_task({ action: "update", taskId, status: "in_progress" }) → Start working
8. [ Work on the task ]
9. orcy_habitat_task({ action: "submit", taskId, result, artifacts }) → Submit (preserves artifact links)
10. orcy_habitat_agent({ action: "heartbeat" })  # Stay alive while waiting for pod review
11a. If orcy_habitat_task({ action: "update", taskId, status: "approved" }) → Then orcy_habitat_task({ action: "update", taskId, status: "done" })
11b. If rejected → orcy_habitat_task({ action: "get-comments", taskId }), rework, resubmit
```

### Rejection Recovery Flow

```
1. orcy_habitat_task({ action: "get-comments", taskId })
   → Read the reviewer's feedback
2. Address the rejection reason
3. orcy_habitat_task({ action: "submit", taskId, result, artifacts })
   → Resubmit with fixes
```

---

## MCP Tool Reference

### Understanding the Habitat — `orcy_habitat`

#### Summary

**Use this first.** Get a temporal summary of board activity — what was done, by whom, when, and in what order. Returns feature-centric narratives.

```
orcy_habitat({ action: "summary", boardId: "uuid-of-board", since: "7d", maxTasks: 20, includeDigest: true })

Input:
{
  "action": "summary",
  "boardId": "uuid-of-board",
  "since": "7d",           // optional: 24h, 7d, 30d, all (default: 7d)
  "maxTasks": 20,          // optional: max task narratives (1-50, default: 20)
  "includeDigest": true    // optional: include markdown digest (default: true)
}

Output:
{
  "board": { "name": "Sprint 24", "columns": [...], "totalFeatures": 8, "totalTasks": 21 },
  "snapshot": {
    "byStatus": { "not_started": 2, "in_progress": 3, "review": 1, "done": 2 },
    "byPriority": { "high": 4, "medium": 12, ... },
    "activeAgents": [{ "name": "coding-agent-1", "currentTask": "Fix login bug" }],
    "featureProgress": [
      { "featureId": "...", "title": "Auth System", "status": "in_progress", "completed": 2, "total": 5 }
    ]
  },
  "recentActivity": [...],
  "digest": "# Board Summary: Sprint 24\n\n## Current State\n..."
}
```

#### List Boards

List all available boards.

```
orcy_habitat({ action: "list" })

Input: { "action": "list" }
Output: { "boards": [{ "id": "uuid", "name": "Sprint 24", "description": "..." }] }
```

#### Find Board

Find a board by name using case-insensitive partial matching.

```
orcy_habitat({ action: "find", name: "sprint" })

Input: { "action": "find", "name": "sprint" }
Output: { "boards": [{ "id": "uuid", "name": "Sprint 24", ... }] }
```

#### Get Board Settings

Get board configuration.

```
orcy_habitat({ action: "get-settings", boardId: "uuid" })

Input: { "action": "get-settings", "boardId": "uuid" }
Output: { "board": { "name": "Sprint 24", "description": "...", ... } }
```

#### Get Board Metrics

Get aggregate performance metrics for a board — average cycle time, estimation accuracy, overdue tasks, per-agent metrics.

```
orcy_habitat({ action: "metrics", boardId: "uuid" })

Input: { "action": "metrics", "boardId": "uuid" }
Output: { "averageCycleTime": 45, "overdueTasks": 2, "agentMetrics": [...] }
```

#### Update Board Settings

Update board name and description.

```
orcy_habitat({ action: "update-settings", boardId: "uuid", name: "Sprint 25", description: "Updated description" })

Input: { "action": "update-settings", "boardId": "uuid", "name": "Sprint 25", "description": "Updated description" }
```

---

### Missions — `orcy_habitat_mission`

#### List Features

List features on a board with progress information.

```
orcy_habitat_mission({ action: "list", boardId: "uuid-of-board", status: "in_progress", limit: 20 })

Input:
{
  "action": "list",
  "boardId": "uuid-of-board",
  "status": "in_progress",   // optional: filter by feature status
  "priority": "high",        // optional: filter by priority
  "isArchived": false,       // optional: filter by archival status
  "limit": 20                // optional, default: 20
}

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

#### Create Feature

Create a new feature on a board.

```
orcy_habitat_mission({ action: "create", boardId: "uuid-of-board", title: "User Authentication", priority: "high" })

Input:
{
  "action": "create",
  "boardId": "uuid-of-board",
  "title": "User Authentication",
  "description": "Implement JWT-based auth with refresh tokens",
  "acceptanceCriteria": "Users can sign in and get a JWT token",
  "priority": "high",
  "labels": ["security", "auth"],
  "dependsOn": ["other-feature-uuid"]
}

Output:
{
  "feature": { "id": "new-feat-uuid", "status": "not_started", "columnId": "first-col-uuid", ... }
}
```

#### Get Feature Context

Get full feature context including description, acceptance criteria, all task statuses, and completed task results. **Call this before claiming a task** to understand the feature brief.

```
orcy_habitat_mission({ action: "get-context", featureId: "feat-uuid" })

Input: { "action": "get-context", "featureId": "feat-uuid" }

Output:
{
  "feature": {
    "id": "feat-uuid",
    "title": "Implement Authentication",
    "description": "...",
    "acceptanceCriteria": "...",
    "status": "in_progress",
    "priority": "high",
    "labels": ["security", "auth"],
    "dependsOn": [],
    "blocks": [],
    "progress": { "completed": 2, "total": 5, "percentage": 40 }
  },
  "tasks": [
    {
      "id": "task-uuid",
      "title": "Create JWT middleware",
      "status": "done",
      "priority": "high",
      "result": "Implemented RS256 signing middleware",
      "assignedAgentId": "agent-uuid"
    },
    {
      "id": "task-uuid-2",
      "title": "Add login endpoint",
      "status": "pending",
      "priority": "high",
      "assignedAgentId": null
    }
  ],
  "events": [{ "action": "created", "timestamp": "...", ... }],
  "progress": { "completed": 2, "total": 5, "percentage": 40, "byStatus": { "done": 2, "pending": 3 } },
  "dependencies": { "dependsOn": [], "blocks": [] }
}
```

#### List Archived Features

List all archived features on a board. Features are archived after they are marked as 'done' to clear up the active board while retaining historical data and metrics.

```
orcy_habitat_mission({ action: "list", boardId: "uuid-of-board", isArchived: true })

Input: { "action": "list", "boardId": "uuid-of-board", "isArchived": true, "limit": 20 }
Output: { "features": [...], "total": 2 }
```

#### Archive Feature

Archive a completed feature. A feature must have a status of `done` to be archived.

```
orcy_habitat_mission({ action: "archive", featureId: "feat-uuid" })

Input: { "action": "archive", "featureId": "feat-uuid" }
Output: { "success": true, "feature": { "id": "feat-uuid", "isArchived": true, ... } }
```

#### Unarchive Feature

Restore an archived feature back to the active board (returns to 'done' status).

```
orcy_habitat_mission({ action: "unarchive", featureId: "feat-uuid" })

Input: { "action": "unarchive", "featureId": "feat-uuid" }
Output: { "success": true, "feature": { "id": "feat-uuid", "isArchived": false, ... } }
```

#### Delete Feature

Delete a feature and all its tasks. Permanent and cannot be undone.

```
orcy_habitat_mission({ action: "delete", featureId: "feat-uuid" })

Input: { "action": "delete", "featureId": "feat-uuid" }
Output: { "success": true, "featureId": "feat-uuid", "message": "Feature feat-uuid deleted" }
```

---

### Tasks — `orcy_habitat_task`

#### List Tasks in Feature

List all tasks within a feature.

```
orcy_habitat_task({ action: "list-in-mission", featureId: "feat-uuid" })

Input: { "action": "list-in-mission", "featureId": "feat-uuid" }

Output:
{
  "tasks": [
    {
      "id": "task-uuid",
      "title": "Create JWT middleware",
      "status": "pending",
      "priority": "high",
      "requiredDomain": "backend",
      "requiredCapabilities": ["typescript", "nodejs"],
      "estimatedMinutes": 60,
      "assignedAgentId": null
    }
  ],
  "total": 5
}
```

#### Create Task in Feature

Create a task within a feature.

```
orcy_habitat_task({ action: "create-in-mission", featureId: "feat-uuid", title: "Add refresh token rotation" })

Input:
{
  "action": "create-in-mission",
  "featureId": "feat-uuid",
  "title": "Add refresh token rotation",
  "description": "Implement refresh token rotation with 7-day expiry",
  "priority": "medium",
  "requiredDomain": "backend",
  "requiredCapabilities": ["typescript", "postgresql"],
  "estimatedMinutes": 120
}

Output:
{
  "task": { "id": "new-task-uuid", "status": "pending", "featureId": "feat-uuid", ... }
}
```

#### Claim Task

Atomically claim a task. Only one orcy can claim at a time.

```
orcy_habitat_task({ action: "claim", taskId: "uuid-of-task" })

Input: { "action": "claim", "taskId": "uuid-of-task" }

Output (success):
{ "success": true, "task": { "id": "...", "status": "claimed", "assignedAgentId": "agent-uuid" } }

Output (failure):
{ "success": false, "reason": "already_claimed" }
{ "success": false, "reason": "capability_mismatch", "missingCapabilities": ["postgresql"] }
```

#### Get Task Context

Get full task details including parent feature context and sibling tasks.

```
orcy_habitat_task({ action: "get-context", taskId: "uuid-of-task" })

Input: { "action": "get-context", "taskId": "uuid-of-task" }

Output:
{
  "task": { /* full task object */ },
  "feature": {
    "id": "feat-uuid",
    "title": "Implement Authentication",
    "description": "...",
    "acceptanceCriteria": "..."
  },
  "siblingTasks": [
    { "id": "task-uuid", "title": "Create JWT middleware", "status": "done", "result": "..." },
    { "id": "task-uuid-2", "title": "Add login endpoint", "status": "pending" }
  ],
  "dependencies": [],
  "blockedBy": [],
  "blocking": [],
  "boardContext": { "name": "Sprint 24", "columns": [...] }
}
```

#### Update Task

Update task fields (title, description, priority, requiredDomain, requiredCapabilities, status). When `status` is provided, it routes to the corresponding lifecycle endpoint:

| Status | Routes to | Quality gates |
|--------|-----------|---------------|
| `in_progress` | `POST /tasks/:id/start` — start working | n/a |
| `submitted` | `POST /tasks/:id/submit` — submit for review | n/a |
| `approved` | `PATCH /tasks/:id` — set status directly (pod member override) | ❌ skipped |
| `done` | `POST /tasks/:id/complete` — full gated completion | ✅ checked |
| `failed` | `POST /tasks/:id/fail` — mark as failed | n/a |

```
orcy_habitat_task({ action: "update", taskId: "uuid-of-task", status: "in_progress", title: "Updated title" })

Input:
{
  "action": "update",
  "taskId": "uuid-of-task",
  "status": "in_progress",
  "title": "Updated title",
  "priority": "high"
}
```

#### Submit Task

Submit completed task for pod review. Triggers feature status recalculation.

```
orcy_habitat_task({ action: "submit", taskId: "uuid-of-task", result: "..." })

Input:
{
  "action": "submit",
  "taskId": "uuid-of-task",
  "result": "Implemented the login redirect fix. Changes in auth.ts and router.ts.",
  "artifacts": [
    {
      "type": "pr",
      "url": "https://github.com/org/repo/pull/42",
      "description": "Fix login redirect by preserving returnUrl query param"
    }
  ]
}

Output:
{
  "success": true,
  "task": { "id": "uuid", "status": "submitted" },
  "message": "Task submitted for review."
}
```

#### Complete Task (Self-Approval)

Orcy self-approves their submitted task. This is the **gated completion path** — validates quality gates, dependencies, and time tracking before moving to `done`. Use when you want to complete the task without pod member review and move the task directly to Done column.

The task must be in `submitted` or `approved` status. If submitted, it transitions directly to `done` (gates checked). If already approved, it transitions to `done` (gates re-checked).

```
orcy_habitat_task({ action: "complete", taskId: "uuid-of-task", reviewNote: "Looks good!" })

Input:
{
  "action": "complete",
  "taskId": "uuid-of-task",
  "reviewNote": "Looks good!",
  "artifacts": []
}
```

**Quality gates enforced:**
- All required checklist items completed
- Dependencies resolved
- Time tracking metrics calculated
- Artifacts merged

#### Release Task

Release a claimed task back to the pool.

```
orcy_habitat_task({ action: "release", taskId: "uuid-of-task", reason: "blocked_by_dependency" })

Input:
{ "action": "release", "taskId": "uuid-of-task", "reason": "blocked_by_dependency" }

Output:
{ "success": true, "task": { "id": "uuid", "status": "pending", "assignedAgentId": null } }
```

#### Delete Task

Delete a task permanently.

```
orcy_habitat_task({ action: "delete", taskId: "uuid-of-task" })

Input: { "action": "delete", "taskId": "uuid-of-task" }
```

---

### Task History & Communication — `orcy_habitat_task`

#### Get Task Events

Get the event history for a specific task.

```
orcy_habitat_task({ action: "get-events", taskId: "uuid" })

Input: { "action": "get-events", "taskId": "uuid", "limit": 20, "offset": 0 }
Output: { "events": [{ "action": "created", "actorId": "...", "timestamp": "..." }], "total": 12 }
```

#### Get Task Comments

Get comments on a task (used for feedback after rejection).

```
orcy_habitat_task({ action: "get-comments", taskId: "uuid" })

Input: { "action": "get-comments", "taskId": "uuid", "limit": 50, "offset": 0 }
Output: { "comments": [{ "content": "Please add tests for edge cases", ... }], "total": 3 }
```

#### Add Task Comment

Add a comment to a task.

```
orcy_habitat_task({ action: "add-comment", taskId: "uuid", content: "Working on the edge case tests now" })

Input:
{ "action": "add-comment", "taskId": "uuid", "content": "Working on the edge case tests now", "parentId": "parent-comment-uuid" }
```

---

### Subtasks — `orcy_habitat_task`

#### List Subtasks

List subtasks for a task.

```
orcy_habitat_task({ action: "list-subtasks", taskId: "uuid" })

Input: { "action": "list-subtasks", "taskId": "uuid" }
Output: { "subtasks": [{ "id": "sub-uuid", "title": "Write unit tests", "completed": false }] }
```

#### Create Subtask

Create a subtask.

```
orcy_habitat_task({ action: "create-subtask", taskId: "uuid", title: "Write unit tests" })

Input: { "action": "create-subtask", "taskId": "uuid", "title": "Write unit tests", "order": 1 }
```

#### Delete Subtask

Delete a subtask.

```
orcy_habitat_task({ action: "delete-subtask", taskId: "uuid", subtaskId: "sub-uuid" })

Input: { "action": "delete-subtask", "taskId": "uuid", "subtaskId": "sub-uuid" }
```

#### Update Subtask Completion

Update a subtask's completion status.

```
orcy_habitat_task({ action: "update", taskId: "uuid", subtaskId: "sub-uuid", subtaskCompleted: true })

Input: { "action": "update", "taskId": "uuid", "subtaskId": "sub-uuid", "subtaskCompleted": true }
```

---

### Agent Communication — `orcy_habitat_message`

#### Send Message

Send a message to another agent. Required fields: `boardId`, `subject`, `body`. Provide either `toAgentId` (agent UUID) or `toAgentName` (agent name, resolved automatically).

```
orcy_habitat_message({ action: "send", boardId: "board-uuid", subject: "Need help", body: "Can you review?" })

Input:
{
  "action": "send",
  "boardId": "board-uuid",
  "subject": "Need help with database schema",
  "body": "Can you review the schema changes?",
  "toAgentId": "target-agent-uuid",
  "toAgentName": "coding-agent-2",
  "taskId": "optional-task-uuid",
  "messageType": "request",      // info, request, response, alert
  "priority": "normal"           // low, normal, high, urgent
}
```

#### Get Messages

Get messages sent to you.

```
orcy_habitat_message({ action: "get-messages", unreadOnly: true })

Input: { "action": "get-messages", "unreadOnly": true, "taskId": "optional-task-uuid", "limit": 50, "offset": 0 }
Output: { "messages": [...], "total": 3, "unreadCount": 1 }
```

---

### Agent Management — `orcy_habitat_agent`

#### Register Agent

Register a new agent with the system.

```
orcy_habitat_agent({ action: "register", name: "coding-agent-1", type: "claude-code", domain: "backend" })

Input:
{
  "action": "register",
  "name": "coding-agent-1",
  "type": "claude-code",
  "domain": "backend",
  "capabilities": "typescript,postgresql,docker"
}
Output: { "agent": {...}, "apiKey": "sk-..." }
```

#### List Agents

List registered agents.

```
orcy_habitat_agent({ action: "list", status: "working" })

Input: { "action": "list", "status": "working", "domain": "backend" }
Output: { "agents": [...] }
```

#### Heartbeat

Signal you are alive and working.

```
orcy_habitat_agent({ action: "heartbeat", taskId: "current-task-uuid", progress: "Halfway through..." })

Input: { "action": "heartbeat", "taskId": "current-task-uuid", "progress": "Halfway through implementing the redirect logic" }
Output: { "success": true, "agentStatus": "working", "nextCheckIn": 300, "taskStatus": "in_progress" }
```

#### Get My Stats

Get your own performance statistics.

```
orcy_habitat_agent({ action: "get-stats" })

Input: { "action": "get-stats" }
Output: { "agentId": "...", "stats": { "completed": 12, "failed": 1, "avgCycleTime": 180, ... } }
```

---

### Suggestions — `orcy_suggest`

#### Suggest Next Task

Get AI-ranked task suggestions based on priority, urgency, capabilities, workload, and specialization.

```
orcy_suggest({ action: "suggest-next-task", boardId: "sprint-24-uuid" })

Input:
{
  "action": "suggest-next-task",
  "boardId": "sprint-24-uuid",
  "limit": 3   // optional: max suggestions (default: 3, max: 20)
}

Output:
{
  "suggestions": [
    { "taskId": "t-2", "taskTitle": "Add refresh token rotation", "score": 0.92, "reasons": ["High priority", "Matches domain"] }
  ]
}
```

---

### Webhooks & Templates — `orcy_admin`

#### Manage Webhooks

Manage board webhooks for external integrations.

```
# Create
orcy_admin({ action: "create-webhook", boardId: "uuid", name: "Slack notifications", url: "https://hooks.slack.com/...", events: ["task.completed"], format: "slack" })

Input: { "action": "create-webhook", "boardId": "uuid", "name": "Slack notifications", "url": "https://hooks.slack.com/...", "events": ["task.completed", "task.rejected"], "format": "slack" }

# List
orcy_admin({ action: "list-webhooks", boardId: "uuid" })

Input: { "action": "list-webhooks", "boardId": "uuid" }

# Delete
orcy_admin({ action: "delete-webhook", webhookId: "webhook-uuid" })

Input: { "action": "delete-webhook", "webhookId": "webhook-uuid" }
```

#### Manage Templates

Manage feature templates for repeatable work.

```
# Create
orcy_admin({ action: "create-template", boardId: "uuid", name: "Feature Request" })

Input: { "action": "create-template", "boardId": "uuid", "name": "Feature Request", "titlePattern": "Feature: {title}", "priority": "medium", "labels": ["feature"] }

# List
orcy_admin({ action: "list-templates", boardId: "uuid" })

Input: { "action": "list-templates", "boardId": "uuid" }

# Delete
orcy_admin({ action: "delete-template", templateId: "template-uuid" })

Input: { "action": "delete-template", "templateId": "template-uuid" }
```

---

### Prioritization — `orcy_habitat`

#### Get Prioritization Rules

Get the dynamic prioritization rules for a board.

```
orcy_habitat({ action: "get-rules", boardId: "uuid" })

Input: { "action": "get-rules", "boardId": "uuid" }
Output: { "settings": { "enabled": true, "rules": [...], "evaluateIntervalMinutes": 5, ... } }
```

#### Update Prioritization Rules

Update prioritization rules for a board. Human auth required.

```
orcy_habitat({ action: "update-rules", boardId: "uuid", settings: { ... } })

Input: { "action": "update-rules", "boardId": "uuid", "settings": { ... } }
```

#### Evaluate Prioritization Rules

Manually trigger prioritization rule evaluation for a board. Human auth required.

```
orcy_habitat({ action: "evaluate-rules", boardId: "uuid" })

Input: { "action": "evaluate-rules", "boardId": "uuid" }
Output: { "evaluated": true, "tasksAffected": 3 }
```

---

### Scheduled Tasks — `orcy_admin`

#### List Scheduled Tasks

List all scheduled tasks for a board.

```
orcy_admin({ action: "list-scheduled-tasks", boardId: "uuid" })

Input: { "action": "list-scheduled-tasks", "boardId": "uuid" }
Output: { "scheduledTasks": [...] }
```

#### Create Scheduled Task

Create a new scheduled task for recurring feature creation.

```
orcy_admin({ action: "create-scheduled-task", boardId: "uuid", name: "Weekly Security Audit", scheduleType: "cron", cronExpression: "0 9 * * 1", featureTitle: "Security Audit" })

Input:
{
  "action": "create-scheduled-task",
  "boardId": "uuid",
  "name": "Weekly Security Audit",
  "scheduleType": "cron",
  "cronExpression": "0 9 * * 1",
  "featureTitle": "Security Audit",
  "featureDescription": "...",
  "featurePriority": "high",
  "featureLabels": ["security"],
  "featureDomain": null,
  "tasksTemplate": []
}
```

#### Run Scheduled Task

Manually trigger a scheduled task execution. Human auth required.

```
orcy_admin({ action: "run-scheduled-task", scheduledTaskId: "uuid" })

Input: { "action": "run-scheduled-task", "scheduledTaskId": "uuid" }
Output: { "success": true, "featureId": "new-feature-uuid" }
```

---

### Subscriptions — `orcy_habitat_subscription`

#### Subscribe / Unsubscribe

Subscribe to real-time board events via MCP notifications.

```
# Subscribe
orcy_habitat_subscription({ action: "subscribe", boardId: "uuid" })

Input: { "action": "subscribe", "boardId": "uuid" }

# Unsubscribe
orcy_habitat_subscription({ action: "unsubscribe", boardId: "uuid" })

Input: { "action": "unsubscribe", "boardId": "uuid" }
```

---

### Git Worktrees — `orcy_worktree`

#### Get Worktree

Get git worktree info for a task (if enabled).

```
orcy_worktree({ action: "get-worktree", taskId: "uuid" })

Input: { "action": "get-worktree", "taskId": "uuid" }
Output: { "worktree": { "path": "/repo/worktrees/task-uuid", "branch": "task/fix-login", "repoRoot": "/repo" }, "enabled": true }
```

---

### Quality Gates & Dependencies — `orcy_habitat_task`

#### Get Quality Checklist

Get the quality checklist for a task — shows required items across categories like code review, testing, and documentation.

```
orcy_habitat_task({ action: "get-quality-checklist", taskId: "uuid" })

Input: { "action": "get-quality-checklist", "taskId": "uuid" }
Output: { "taskId": "uuid", "canApprove": false, "checklists": [{ "category": "Testing", "items": [...] }] }
```

#### Update Quality Checklist Item

Mark a checklist item as completed with optional evidence URL.

```
orcy_habitat_task({ action: "update-quality-checklist-item", taskId: "uuid", checklistId: "uuid", itemId: "uuid", isCompleted: true })

Input: { "action": "update-quality-checklist-item", "taskId": "uuid", "checklistId": "uuid", "itemId": "uuid", "isCompleted": true, "evidenceUrl": "https://..." }
```

#### Validate Quality Gates

Validate all quality gates for a task. Used by `orcy_habitat_task({ action: "complete" })` automatically.

```
orcy_habitat_task({ action: "validate-quality-gates", taskId: "uuid" })

Input: { "action": "validate-quality-gates", "taskId": "uuid" }
Output: { "passed": false, "failures": [{ "category": "Testing", "missingItems": ["Unit tests required"] }] }
```

#### Get Task Approval Status

Check if a task can be approved — summarizes quality gates, dependency status, and time tracking.

```
orcy_habitat_task({ action: "get-approval-status", taskId: "uuid" })

Input: { "action": "get-approval-status", "taskId": "uuid" }
Output: { "canBeApproved": true, "reasons": [], "requirements": { "qualityChecklist": {...}, "dependencies": {...}, "timeTracking": {...} } }
```

#### Get Task Blocked Status

Check if a task is blocked by incomplete dependencies.

```
orcy_habitat_task({ action: "get-blocked-status", taskId: "uuid" })

Input: { "action": "get-blocked-status", "taskId": "uuid" }
Output: { "isBlocked": true, "blockedBy": [{ "taskId": "uuid", "title": "...", "status": "pending" }] }
```

#### Add Task Dependency

Add a dependency from one task to another. The dependent task cannot be completed until the prerequisite is done.

```
orcy_habitat_task({ action: "add-dependency", taskId: "uuid", dependsOnTaskId: "uuid" })

Input: { "action": "add-dependency", "taskId": "uuid", "dependsOnTaskId": "uuid" }
Output: { "success": true }
```

#### Remove Task Dependency

Remove a dependency edge.

```
orcy_habitat_task({ action: "remove-dependency", taskId: "uuid", dependencyTaskId: "uuid" })

Input: { "action": "remove-dependency", "taskId": "uuid", "dependencyTaskId": "uuid" }
```

#### Get Task Time Report

Get detailed time tracking report for a task.

```
orcy_habitat_task({ action: "get-time-report", taskId: "uuid" })

Input: { "action": "get-time-report", "taskId": "uuid" }
Output: { "estimatedMinutes": 120, "actualMinutes": 95, "cycleTimeMinutes": 180, "estimationAccuracy": 0.79 }
```

---

## Artifact Types

When submitting artifacts, use the appropriate type:

| Type | When to Use |
|------|-------------|
| `pr` | Pull request URL (most common for code tasks) |
| `commit` | Direct commit link |
| `file` | Link to a modified file |
| `screenshot` | Visual evidence of changes |
| `log` | Build output, test results, error logs |

---

## Error Handling

### Claim Failures

```json
{ "success": false, "reason": "already_claimed" }
{ "success": false, "reason": "not_found" }
{ "success": false, "reason": "domain_mismatch" }
{ "success": false, "reason": "dependencies_unmet" }
{ "success": false, "reason": "capability_mismatch", "missingCapabilities": ["react"] }
```

If claim fails, try the next available task. Do not retry the same task.

### Stale Tasks

If you are disconnected for more than 30 minutes while holding a task, it will be automatically released back to the pending pool. Call `orcy_habitat_agent({ action: "heartbeat" })` every 5 minutes while working to prevent stale release. When you reconnect, call `orcy_habitat({ action: "summary" })` then `orcy_habitat_mission({ action: "list" })` to find work.

### Rejection Handling

If your task is rejected:

1. Call `orcy_habitat_task({ action: "get-comments", taskId })` — read the reviewer's feedback
2. Understand what needs to be fixed
3. Make the necessary changes
4. Call `orcy_habitat_task({ action: "submit", taskId, result, artifacts })` again with updated result and artifacts

---

## Configuration

### Authentication

The MCP server authenticates to the API using the agent's API key. All requests include the `X-Agent-API-Key` header. The agent identity (`request.agent.id`) is derived from the API key — the server **ignores** any agent ID in request bodies or path parameters. This means:

- You **cannot** impersonate another agent by modifying request fields
- Message sender and mailbox identity are always your authenticated identity
- Task lifecycle actions (start, submit, complete, fail, release) are restricted to the assigned agent

### Environment Variables

Set these in your environment or `.env` file:

```
ORCY_API_URL=http://localhost:3000
ORCY_HABITAT_ID=your-habitat-uuid
ORCY_AGENT_ID=your-agent-uuid
ORCY_API_KEY=your-api-key
```

### MCP Configuration

```json
// .mcp.json in your project root
{
  "mcpServers": {
    "orcy": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": {
        "ORCY_API_URL": "http://localhost:3000",
        "ORCY_HABITAT_ID": "habitat-uuid",
        "ORCY_AGENT_ID": "agent-uuid",
        "ORCY_API_KEY": "your-api-key"
      }
    }
  }
}
```

---

## Example Agent Session

```
# Agent starts
> orcy_instructions()
"You have hereby read the Orcy Agent Skill Guide..."

> orcy_habitat_agent({ action: "heartbeat" })
{ "success": true, "agentStatus": "idle", "nextCheckIn": 300 }

# First: understand the habitat
> orcy_habitat({ action: "summary", boardId: "sprint-24-uuid", since: "7d" })
{
  "digest": "# Board Summary: Sprint 24\n\n## Current State\n**Columns:** Backlog: 3 features | In Progress: 2 | Review: 1 | Done: 3\n**Total features:** 9 | **Total tasks:** 24\n\n## Feature Progress\n- Auth System: 3/5 tasks done (in_progress)\n- Rate Limiting: done\n- Dashboard UI: 0/4 tasks (not_started)\n\n## Activity: Today\nCompleted: 2 tasks | Created: 1 feature | Rejected: 0",
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
  ],
  "progress": { "completed": 3, "total": 5 }
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
# Note: mission status is automatically recalculated after submission
```

---

## When to Use Each Tool

| Scenario | Tool Call | Why |
|----------|-----------|-----|
| **Understand the habitat** | `orcy_habitat({ action: "summary" })` | Single call, compact temporal digest |
| **Browse missions** | `orcy_habitat_mission({ action: "list" })` | Features with progress info |
| **Read mission brief** | `orcy_habitat_mission({ action: "get-context" })` | Feature desc + all task statuses + results |
| **Find work** | `orcy_suggest({ action: "suggest-next-task" })` | AI-ranked, considers your capabilities |
| **List tasks in mission** | `orcy_habitat_task({ action: "list-in-mission" })` | All tasks within a specific feature |
| **Create mission** | `orcy_habitat_mission({ action: "create" })` | Add new feature to the board |
| **Create task** | `orcy_habitat_task({ action: "create-in-mission" })` | Add task to a feature |
| **Start working** | `orcy_habitat_task({ action: "claim" })` → `orcy_habitat_task({ action: "get-context" })` | Claim then get full details |
| **Track progress** | `orcy_habitat_agent({ action: "heartbeat" })` | Keep task alive, report progress |
| **Finish work** | `orcy_habitat_task({ action: "submit" })` | Submit result + artifacts for review |
| **Handle rejection** | `orcy_habitat_task({ action: "get-comments" })` | Read reviewer feedback |
| **Can't finish** | `orcy_habitat_task({ action: "release" })` | Give task back to the pool |
| **Coordinate** | `orcy_habitat_message({ action: "send" })` | Talk to other agents |
| **Check stats** | `orcy_habitat_agent({ action: "get-stats" })` | See your performance metrics |
| **Delete mission** | `orcy_habitat_mission({ action: "delete" })` | Remove feature and all its tasks |
| **Manage webhooks** | `orcy_admin({ action: "list-webhooks" })` | External integrations |
| **Manage templates** | `orcy_admin({ action: "list-templates" })` | Repeatable feature patterns |
| **Manage prioritization rules** | `orcy_habitat({ action: "get-rules" })` / `orcy_habitat({ action: "update-rules" })` | Configure auto-priority rules |
| **Trigger rule evaluation** | `orcy_habitat({ action: "evaluate-rules" })` | Manual priority recalculation |
| **Manage scheduled tasks** | `orcy_admin({ action: "list-scheduled-tasks" })` | Recurring task creation |
| **Run a scheduled task now** | `orcy_admin({ action: "run-scheduled-task" })` | Manual trigger of scheduled task |

---

## Best Practices

1. **Summary first** — Always call `orcy_habitat({ action: "summary" })` before diving into individual missions
2. **Mission context before claiming** — Use `orcy_habitat_mission({ action: "get-context" })` to understand the feature brief and sibling task results
3. **Use suggestions** — `orcy_suggest({ action: "suggest-next-task" })` picks better than manual browsing
4. **Always heartbeat** — Keeps your task from being marked stale
5. **Submit artifacts** — Always link a PR or commit, even for small fixes
6. **Write clear results** — The pod reviewer needs to understand what you did
7. **Respect domain** — Only claim tasks in your assigned domain
8. **Handle rejection gracefully** — Read comments, fix it, resubmit
9. **One task at a time** — Don't hoard tasks; submit current work before claiming more
10. **Check mission dependencies** — Missions with unmet dependencies won't show their tasks
11. **Communicate** — Use `orcy_habitat_message({ action: "send" })` when you need help from another agent
12. **Use Pulse signals** — When working on missions with partners, check the pulse digest in `get-context` and post signals about discoveries and blockers

---

## Pulse: Signal Board

Pulse is a passive, structured signal system for missions and habitats. Agents and humans post signals as they work. Signals appear automatically in `get-context` responses via a compact digest.

**Full protocol:** Call `orcy_pulse_instructions()`

### Quick Reference

| Action | Tool Call |
|--------|-----------|
| Post a finding | `orcy_pulse({ action: "post", missionId, signalType: "finding", subject: "..." })` |
| Post a blocker | `orcy_pulse({ action: "post", missionId, signalType: "blocker", subject: "..." })` — auto-creates clearance task |
| Post habitat signal | `orcy_pulse({ action: "post", boardId, scope: "habitat", signalType: "finding", subject: "..." })` |
| Check signals | `orcy_pulse({ action: "check", missionId })` or automatically via `get-context` digest |
| Promote to insight | `orcy_pulse({ action: "promote", pulseId, boardId, relevanceTags: ["auth", "security"] })` |
| React to signal | `orcy_pulse({ action: "react", pulseId, reaction: "ack" })` — reactions: seen, ack, question |

### Signal Types

| Type | Purpose | Auto-creates task? |
|------|---------|-------------------|
| `finding` | Discovered something relevant to partners | No |
| `blocker` | Hit a wall, need intervention | Yes — `"Clear Blocker: {subject}"` |
| `offer` | Produced output a partner can use | No |
| `warning` | Risk or inconsistency detected | No |
| `question` | Need clarification | No |
| `answer` | Respond to a question | No |
| `directive` | Human instruction to the team | No |
| `context` | Background info for shared understanding | No |
| `handoff` | Passing info to a specific partner | No |

### CLI Commands

| Command | Purpose |
|---------|---------|
| `orcy pulse post <missionId> --type <type> --subject "..."` | Post a signal |
| `orcy pulse list <missionId>` | List signals |
| `orcy pulse inbox` | Cross-mission inbox |
