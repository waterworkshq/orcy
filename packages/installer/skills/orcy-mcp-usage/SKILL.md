---
name: orcy-mcp-usage
description: Complete reference for the orcy MCP dispatch tools — orcy_habitat, orcy_habitat_mission, orcy_habitat_task, orcy_habitat_agent, orcy_suggest, orcy_habitat_message, orcy_habitat_subscription, orcy_worktree
license: MIT
---

# Orcy MCP Usage

This skill covers using Orcy via **MCP tools** from within an AI agent session. All tools use a **dispatch pattern** with a consolidated `action` parameter.

If you also have the CLI installed, **prefer MCP for intra-session tool use** — structured input/output integrates better with agent reasoning than shell parsing.

---

## Consolidated Dispatch Tools

| Tool | Actions | Covers |
|------|---------|--------|
| `orcy_habitat` | `list`, `find`, `get-settings`, `summary`, `metrics` | Habitat-level operations |
| `orcy_habitat_mission` | `list`, `create`, `delete`, `archive`, `unarchive`, `get-context` | Mission CRUD and lifecycle |
| `orcy_habitat_task` | `list-in-mission`, `create-in-mission`, `update`, `delete`, `claim`, `start`, `submit`, `complete`, `approve`, `reject`, `release`, `retry`, `fail`, `get-context`, `get-events`, `get-comments`, `add-comment`, `get-time-report`, `get-blocked-status`, `get-approval-status`, `add-dependency`, `remove-dependency`, `get-quality-checklist`, `update-quality-checklist-item`, `validate-quality-gates`, `list-subtasks`, `create-subtask`, `delete-subtask`, `batch-assign`, `batch-set-priority`, `batch-delete` | Full task lifecycle, history, quality, dependencies, subtasks. Batch boundary: `batch-assign` returns agents `403` ("Batch assignment is admin-only. Use POST /tasks/:id/claim to claim a task.") — use claim instead; `batch-set-priority` and `batch-delete` remain agent-usable |
| `orcy_habitat_agent` | `register`, `list`, `heartbeat`, `get-stats` | Agent registration and presence |
| `orcy_suggest` | `suggest-next-task` | AI-ranked task recommendations |
| `orcy_habitat_message` | `send`, `get-messages` | Cross-agent communication |
| `orcy_pulse` | `post`, `check` | Mission signal board — post findings, blockers, offers; auto-tasks on BLOCKER |
| `orcy_habitat_subscription` | `subscribe`, `unsubscribe` | Real-time event subscriptions |
| `orcy_worktree` | `get-worktree` | Git worktree for tasks |
| `orcy_notification` | `get_inbox`, `get_history`, `get_delivery`, `ack`, `snooze`, `clear`, `get_subscriptions` | Own notification self-service (see Notifications section) |
| `orcy_automation` | `list`, `get`, `simulate`, `list_runs`, `get_rule_runs` | Automation inspection for habitats where you hold active work (see Automation section) |
| `orcy_triage` | `investigate`, `top_issues`, `resolution_lookup`, `insert_deferred_mission`, `map_orphan_mission`, `set_focus_mission` | Triage investigation surface (see Triage section) |
| `orcy_habitat_skill` | `get`, `refresh`, `contribute` | Dynamic habitat skills — living knowledge document |
| `orcy_learning` | `list_accepted`, `get` | Read accepted findings from the learning loop (active task required) |
| `orcy_wiki` | `search`, `get_page`, `list_pages`, `get_authoring_context`, `create_page`, `save_version`, `restore_version`, `update_metadata`, `add_link`, `remove_link`, `mark_no_update_needed`, `trigger_refresh`, `get_signal_surface` | Authored habitat wiki |
| `orcy_wiki_instructions` | (tool) | Wiki authoring skill guide |
| `orcy_pulse_instructions` | (tool) | Pulse signal-posting skill guide |
| `orcy_instructions` | (tool) | Orcy workflow skill guide (read this first) |
| `orcy_sprint` | `list`, `get`, `get_active`, `get_metrics`, `get_burndown`, `get_carry_over`, `create`, `update`, `delete`, `start`, `complete`, `cancel`, `add_mission`, `remove_mission` | Sprint planning, lifecycle, mission membership, and sprint analytics |
| `orcy_review` | `list_rules`, `create_rule`, `update_rule`, `delete_rule`, `list_reviewers`, `add_reviewer`, `remove_reviewer` | Review assignment rules and task reviewer management |
| `orcy_get_workflow_context` | _(single action — pass `taskId`)_ | Read your position in a workflow chain: upstream gates, downstream waiting tasks, gate states |
| `orcy_get_failure_context` | _(single action — pass `taskId`)_ | Read the FailureContext for a task (used by recovery agents to understand what went wrong) |

---

## Startup Sequence

When an agent starts a session:

```
1. Read ORCY_HABITAT_ID and ORCY_AGENT_ID from environment
2. Read orcy_instructions() to get the skill guide
3. Call orcy_habitat_agent({ action: "heartbeat" }) to register presence
4. Call orcy_habitat({ action: "summary", habitatId }) to understand board state
5. Call orcy_habitat_mission({ action: "list", boardId }) to browse missions
6. Call orcy_habitat_mission({ action: "get-context", featureId }) for mission brief — pulse digest included
7. If the mission has partners, check pulse data in get-context. For full Pulse protocol, call orcy_pulse_instructions()
8. Call orcy_suggest({ action: "suggest-next-task", boardId }) to find work
9. Call orcy_habitat_task({ action: "claim", taskId }) to lock a task
10. Begin work
```

---

## Habitat — `orcy_habitat`

### Summary

**Call this first.** Get a compact temporal overview of what was done, by whom, and when. Prevents N+1 loading of individual missions.

```
orcy_habitat({ action: "summary", habitatId: "uuid", since: "7d", maxTasks: 20, includeDigest: true })

Input:
{
  "action": "summary",
  "habitatId": "uuid-of-board",
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
orcy_habitat({ action: "get-settings", habitatId: "uuid" })
Output: { "board": { "name": "Sprint 24", "description": "...", ... } }
```

### Metrics

```
orcy_habitat({ action: "metrics", habitatId: "uuid" })
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

Success: { "success": true, "task": { "id": "...", "status": "claimed", "assignedAgentId": "agent-uuid", "executionToken": "<epoch-token>" } }
Failure (already claimed): { "success": false, "reason": "already_claimed" }
Failure (capability): { "success": false, "reason": "capability_mismatch", "missingCapabilities": ["postgresql"] }
Failure (domain): { "success": false, "reason": "domain_mismatch" }
Failure (dependencies): { "success": false, "reason": "dependencies_unmet" }
```

**Execution token (epoch fence).** The claim response includes `task.executionToken`. You MUST capture it and present it as `executionToken` on the four task mutations — `start`, `submit`, `release`, `fail` — and on `update` calls that set `status` to `in_progress`/`submitted`/`failed`. If the task was released and re-claimed (a new epoch), your old token is rejected:

```unknown
{ "error": "task was claimed in a different execution epoch; present `executionToken` from your claim response (`task.executionToken`)", "code": "EPOCH_MISMATCH" }  // HTTP 409
```

On receiving `EPOCH_MISMATCH`, stop mutating the task and diagnose before acting: a missing/null token on your CURRENT claim is rejected identically — supply the most recent `task.executionToken` you captured — from your claim response, or from your rework start response after a rejection — never re-GET the task for a fresh token. If your token is known stale (a new epoch was minted — including your own rework start, which returns the newer token in its response) or the original is unrecoverable, do not abandon a still-valid claim on the error code alone — stop mutations and recover ownership explicitly (verify current ownership via `get-context`) before moving to different work. The `claim` action never takes a token (claiming mints one). Legacy pre-token tasks accept mutations without one.

**Rejected-task rework (owner continuation).** If your submission is rejected, the task stays assigned to you — not claimable by others while it remains rejected. Reject preserves your claim token X as the rejected-continuation token. Restart with `start` presenting X: the start atomically mints the rework token **Y** and returns it in the start response — capture Y from YOUR START RESPONSE (never a task GET, never the original claim token; a still-running process presenting the old X is correctly fenced with `409 EPOCH_MISMATCH` after the mint). All further mutations (`submit`, `release`, `fail`) use Y. Existing review rows are retained with no automatic reset: pending rows still await decision, prior approvals still count (authorized human managers can still change reviewer assignments). There is no daemon claim for rejected tasks: rework runs from your still-live session (it rebinds to Y) or a manual run.

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
| `approved` | `POST /tasks/:id/approve` — canonical review approval under existing review authorization (admitted human or pending assigned agent reviewer row) | ❌ skipped |
| `done` | POST /tasks/:id/complete | Enforced |
| `failed` | POST /tasks/:id/fail | n/a |

Status transitions to `in_progress`/`submitted`/`failed` additionally pass your `executionToken` (see Claim Task). Keep `status` and metadata edits in separate `update` calls — the status branch returns before any metadata is applied.

```
orcy_habitat_task({ action: "update", taskId: "uuid", status: "in_progress", executionToken: "<epoch-token from your claim>" })

Input:
{
  "action": "update",
  "taskId": "uuid",
  "status": "in_progress",    // routes to the lifecycle start endpoint
  "executionToken": "<epoch-token from your claim>"
}

Metadata-only (no status — apply field edits on their own):
orcy_habitat_task({ action: "update", taskId: "uuid", title: "Updated title", priority: "high", version: 3 })
```

### Submit Task

Submit completed work for review. Triggers mission status recalculation.

```
orcy_habitat_task({
  action: "submit",
  taskId: "uuid",
  result: "Implemented the login redirect fix. Changes in auth.ts and router.ts.",
  executionToken: "<epoch-token from your claim>",
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

### Approve Task (Review Decision)

Reviewer approves a submitted task under existing review authorization (`POST /tasks/:id/approve`). Admits a human reviewer or an agent holding a pending agent-typed reviewer row (reviewer identity from authenticated principal; no executionToken required; normal authentication and reviewer authorization still apply; no quality gates). A pending row alone never approves: assignee self-review is refused and task-state checks still apply.

```
orcy_habitat_task({ action: "approve", taskId: "uuid" })
Output: { "success": true, "task": { "id": "uuid", "status": "approved" } }
```

The returned task row is echoed verbatim: with several required reviewers, the task may stay `submitted` until the last approval lands.

### Reject Task (Review Decision)

Reviewer rejects a submitted task back for rework under existing review authorization (`POST /tasks/:id/reject`). Same admission contract as approve; `reason` is required (1–1000 chars).

```
orcy_habitat_task({ action: "reject", taskId: "uuid", reason: "Tests are missing for new endpoints" })
Output: { "success": true, "task": { "id": "uuid", "status": "rejected" } }
```

### Release Task

Give a claimed task back to the pool.

```
orcy_habitat_task({ action: "release", taskId: "uuid", reason: "blocked_by_dependency", executionToken: "<epoch-token from your claim>" })
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
1. orcy_habitat({ action: "summary", habitatId })                              → Understand the board
2. orcy_habitat_mission({ action: "list", boardId })                          → Browse missions
3. orcy_habitat_mission({ action: "get-context", featureId })                 → Read mission brief
4. orcy_suggest({ action: "suggest-next-task", boardId })                   → Find best task
5. orcy_habitat_task({ action: "claim", taskId })                             → Claim it
6. orcy_habitat_task({ action: "get-context", taskId })                       → Full task details
7. orcy_habitat_task({ action: "update", taskId, status: "in_progress", executionToken }) → Start working
8. [ Work on the task; heartbeat every 5 min ]
9. orcy_habitat_task({ action: "submit", taskId, result, executionToken, artifacts }) → Submit
10. orcy_habitat_task({ action: "complete", taskId, reviewNote, artifacts })  → Gated completion
11. Claim next task
```

### Path B: Pod Review

Approval and rejection admit a human reviewer or an agent holding a pending agent-typed reviewer row. Reviewer identity always derives from the authenticated caller (a body `reviewerId` is ignored); an agent equal to the task's current assignee is refused (typed anti-self); agent status is never an admission gate (offline ≠ revoked). Reviewer MANAGEMENT (`orcy_review` add/remove) is human-only: every `orcy_review`/`orcy_sprint` mutation is human-authenticated (JWT) — an agent API key gets `401` (not 403); on team habitats humans additionally need team membership, with no admin-role distinction. Reviewer management can name `reviewerType: "agent"` targets validated against the agent registry. The reads (`orcy_review` `list_rules`/`list_reviewers`, `orcy_sprint` `list`/`get_active` on any habitat shape, and the four id-keyed sprint reads `get`/`get_metrics`/`get_burndown`/`get_carry_over` on personal habitats) are agent-capable; the id-keyed sprint reads 403 agents on team habitats.

```
1. orcy_habitat({ action: "summary", habitatId })                              → Understand the board
2. orcy_habitat_mission({ action: "list", boardId })                          → Browse missions
3. orcy_habitat_mission({ action: "get-context", featureId })                 → Read mission brief
4. orcy_suggest({ action: "suggest-next-task", boardId })                   → Find best task
5. orcy_habitat_task({ action: "claim", taskId })                             → Claim it
6. orcy_habitat_task({ action: "get-context", taskId })                       → Full task details
7. orcy_habitat_task({ action: "update", taskId, status: "in_progress", executionToken }) → Start working
8. [ Work on the task ]
9. orcy_habitat_task({ action: "submit", taskId, result, executionToken, artifacts }) → Submit for review
10. orcy_habitat_agent({ action: "heartbeat" })                               → Stay alive while awaiting review
11. Wait for the reviewer verdict — a human, or an agent holding a pending agent-typed reviewer row, may approve or reject (reviewer identity derives from the authenticated caller; an agent equal to the current assignee is refused)
11a. If approved → orcy_habitat_task({ action: "complete", taskId, reviewNote, artifacts }) → done (gates re-checked)
11b. If rejected: orcy_habitat_task({ action: "get-comments", taskId }), then restart with
    orcy_habitat_task({ action: "start", taskId, executionToken: X }) — that start response mints the
    fresh rework token Y (capture it), fix, resubmit with Y
```

### Rejection Recovery

```
1. orcy_habitat_task({ action: "get-comments", taskId })                      → Read feedback
2. Address the rejection reason
   (your claim token X survives the rejection — the task stays assigned to you)
3. orcy_habitat_task({ action: "start", taskId, executionToken: X })          → Restart rework;
   THIS response returns the fresh rework token Y — capture Y here (never a task GET, never X again)
4. orcy_habitat_task({ action: "submit", taskId, result, executionToken: Y, artifacts }) → Resubmit
```

---

## Example Agent Session

```
# Agent starts
> orcy_habitat_agent({ action: "heartbeat" })
{ "success": true, "agentStatus": "idle", "nextCheckIn": 300 }

# Understand the board
> orcy_habitat({ action: "summary", habitatId: "sprint-24-uuid", since: "7d" })
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
{ "success": true, "task": { "id": "t-2", "status": "claimed", "executionToken": "tok-9f3a", ... } }
# capture task.executionToken — every start/submit/release/fail below presents it

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
    executionToken: "tok-9f3a",
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
12. **Use Pulse signals** — When working on multi-agent missions, check the pulse digest in `get-context` and post signals about discoveries and blockers

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

## Notifications — `orcy_notification`

Self-service over YOUR OWN notification deliveries — the recipient is always the authenticated agent (your API key), never a request-supplied id. Actions: `get_inbox` (active attention), `get_history` (past deliveries), `get_delivery` (one delivery + its event), `ack`, `snooze` (body: ISO `snoozedUntil`), `clear`, `get_subscriptions` (your overrides + habitat defaults, read-only — subscription writes are admin-only).

```
orcy_notification({ action: "get_inbox", habitatId })
orcy_notification({ action: "get_history", habitatId, limit: 50, offset: 0 })
orcy_notification({ action: "get_delivery", habitatId, deliveryId })
orcy_notification({ action: "ack", habitatId, deliveryId })
orcy_notification({ action: "snooze", habitatId, deliveryId, snoozedUntil: "2030-01-01T00:00:00Z" })
orcy_notification({ action: "clear", habitatId, deliveryId })
orcy_notification({ action: "get_subscriptions", habitatId })
```

- Scoping: every action is scoped to the path habitat AND your own recipient id + type. A delivery ID queried under the wrong habitat answers 404 there (under its correct habitat it works); someone else's delivery answers 403. Inbox/history under a wrong habitat return a filtered empty list, not 404.
- `get_delivery` event content: agents receive the canonical row fields (`eventType`, `severity`, `title`, `body`) plus a fixed allowlist of string context keys (`taskId`, `missionId`, `actorId`, `reason`, `mentionedUserId`, `mentionedByName`, `commentContent`, `oldPriority`, `newPriority`, `reviewerId` — opaque passthrough, not semantically validated). The raw payload, creator fields, and history summaries are never exposed to agents.
- Inbox/history show delivery rows (channels, status, timestamps) only — same shape a human sees.

## Automation — `orcy_automation`

Read-only automation inspection, available in habitats where YOU hold active work (a task you have in `claimed` / `in_progress` / `submitted` status there — approved/rejected/done/failed history does not qualify; a rejected task counts again once its rework start returns it to `in_progress`). Actions: `list` (rules in a habitat), `get` (one rule), `simulate` (dry-run a rule's condition), `list_runs` (habitat run history), `get_rule_runs` (one rule's runs).

```
orcy_automation({ action: "list", habitatId })
orcy_automation({ action: "get", ruleId })
orcy_automation({ action: "simulate", ruleId, targetType: "task", targetId })
orcy_automation({ action: "list_runs", habitatId, limit: 50, offset: 0 })
orcy_automation({ action: "get_rule_runs", ruleId, limit: 50, offset: 0 })
```

- Scoping: without active work in the habitat, `list`/`list_runs` answer 403 and the rule-id actions answer 404 (uniform with unknown or foreign rule ids — you cannot probe rule existence). Denial windows: before your first claim in a habitat and while you hold no assigned task there in `claimed` / `in_progress` / `submitted`.
- Rules arrive as projections: trigger/cooldown/priority/enabled plus a `{type, summary}` condition view and `{type, description}` static action labels. Configuration webhook URL/header fields, signal content, and plugin params are never exposed; authored `name` / `description` free text passes through unchanged.
- `simulate`: pass `targetType`/`targetId` (a task/mission/sprint/pulse/habitat of the same habitat; `agent` targets are rejected). You may not pass `overrideCondition` or `payload` — both are rejected with fixed 400 codes. Plugin-typed conditions anywhere in the rule's tree answer `validation.code = "unsupported_plugin_condition"` without evaluation. The response carries `{ruleId, ruleName, wouldExecute, skipReason?, validation, actionPreviews, conditionResult}` only.
- Runs arrive as `{id, ruleId, status?, startedAt, finishedAt}` plus `skipReason` when it is one of the canonical union values; non-canonical legacy statuses and skip reasons are omitted. No error details, action results, or metadata.

## Triage — `orcy_triage`

Triage investigation surface. Reads (`top_issues`, `resolution_lookup`, `investigate`) work in your unteamed habitats; `insert_deferred_mission` and `map_orphan_mission` require the current investigation claim; `set_focus_mission` uses the existing unteamed-habitat access policy without a claim requirement.

```
orcy_triage({ action: "top_issues", habitatId, limit: 10 })
orcy_triage({ action: "investigate", habitatId, clusterKey })            # clusterKey may be "orphan-mission:<missionId>"
orcy_triage({ action: "resolution_lookup", habitatId, clusterKey })
orcy_triage({ action: "insert_deferred_mission", habitatId, findingId,
              missionTitle, missionDescription,
              releaseGateType: "patch",                      # REQUIRED; allowed: patch, minor, major
              releaseGateVersion: "v0.25.0",                 # REQUIRED
              dependsOn: ["<missionId>"] })                   # optional positioning edges
orcy_triage({ action: "map_orphan_mission", habitatId, missionId,
              dependsOn: ["<missionId>"],                     # REQUIRED (>= 1)
              releaseGateType: "minor", releaseGateVersion: "v0.41",  # optional
              expectedVersion: 3 })                           # optional CAS
orcy_triage({ action: "set_focus_mission", habitatId, missionId })      # missionId: null clears
```

- `insert_deferred_mission` sends ONE atomic lifecycle route: the gated corrective mission, its dependency placement, and the finding link commit together. `releaseGateType` and `releaseGateVersion` are REQUIRED (patch → `defer_to_patch`; minor/major → `defer_to_release`). Authorized only when you currently claim the finding's admitted investigation task.
- `map_orphan_mission` positions an unmapped orphan mission through a dedicated bounded route — never the generic mission PATCH. Authorized only when you currently claim that orphan's GENUINE published investigate task (proved by the publication ledger — a claimed replacement task never authorizes); the server re-verifies orphan state, open investigation, and your claim in one transaction.
- `investigate` returns `clusterMissionId` = the investigation mission id (`admittedByTriageMissionId`), plus `openFindings[]` carrying `correctiveMissionId` (the corrective work, a different mission) and the admitted investigation provenance. An `orphan-mission:{id}` investigation additionally verifies the open investigation junction: a disconnected mission with NO open orphan investigation is reported not investigable (no mapping instruction).
