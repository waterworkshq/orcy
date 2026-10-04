---
name: orcy-mcp-usage
description: Complete reference for the orcy MCP dispatch tools — orcy_habitat, orcy_habitat_mission, orcy_habitat_task, orcy_habitat_agent, orcy_suggest, orcy_habitat_message, orcy_habitat_subscription, orcy_worktree, orcy_sprint, orcy_review, orcy_habitat_skill, orcy_notification, orcy_automation, orcy_wiki, orcy_wiki_instructions, orcy_learning, orcy_triage, orcy_get_failure_context, orcy_get_workflow_context, orcy_pulse_instructions
license: MIT
---

# Orcy MCP Usage

This skill covers using Orcy via **MCP tools** from within an AI agent session. All tools use a **dispatch pattern** with a consolidated `action` parameter.

If you also have the CLI installed, **prefer MCP for intra-session tool use** — structured input/output integrates better with agent reasoning than shell parsing.

---

## Consolidated Dispatch Tools

| Tool | Actions | Covers |
|------|---------|--------|
| `orcy_habitat` | `list`, `find`, `get-settings`, `summary`, `metrics`, `get-health`, `get-health-history`, `predictions`, `bottlenecks`, `agent-quality`, `get-rules`, `update-rules`, `evaluate-rules` | Habitat discovery, settings, summaries, health, analytics, and prioritization rules |
| `orcy_habitat_mission` | `list`, `create`, `delete`, `archive`, `unarchive`, `get-context`, `get-comments`, `add-comment`, `link-code`, `list-code-evidence`, `correct-code-evidence-link`, `mark-not-applicable`, `clear-not-applicable`, `report-gap`, `resolve-gap`, `get-audit-bundle` | Mission lifecycle, comments, code evidence, and scoped audit evidence bundles |
| `orcy_habitat_task` | `list-in-mission`, `create-in-mission`, `update`, `delete`, `claim`, `start`, `submit`, `complete`, `approve`, `reject`, `release`, `retry`, `fail`, `get-context`, `get-events`, `get-comments`, `add-comment`, `get-time-report`, `get-blocked-status`, `get-approval-status`, `add-dependency`, `remove-dependency`, `get-quality-checklist`, `update-quality-checklist-item`, `validate-quality-gates`, `list-subtasks`, `create-subtask`, `delete-subtask`, `log-effort`, `list-effort`, `get-effort-report`, `correct-effort-entry`, `link-code`, `list-code-evidence`, `correct-code-evidence-link`, `mark-not-applicable`, `clear-not-applicable`, `report-gap`, `resolve-gap`, `get-audit-bundle`, `batch-assign`, `batch-set-priority`, `batch-delete` | Full task lifecycle, history, quality, dependencies, subtasks, effort, evidence, and audit bundles. Batch boundary: `batch-assign` returns agents `403` ("Batch assignment is admin-only. Use POST /tasks/:id/claim to claim a task.") — use claim instead; `batch-set-priority` and `batch-delete` remain agent-usable (agents pass the URL habitat's access check on any existing habitat; human JWTs additionally require team membership on team habitats). Object-access boundary: `get-context`, `get-events`, `get-comments`, `list-code-evidence`, `delete`, the five scalar adjunct reads (`get-time-report`, `get-approval-status`, `get-quality-checklist`, `get-effort-report`, `list-effort`), and the dependency actions (`get-blocked-status`, `add-dependency`, `remove-dependency`) resolve the TARGET task's (and, for dependencies, every linked edge endpoint on reads, both actual endpoints on writes) Mission→Habitat server-side and enforce the same membership check for human JWTs (nonmember 403; missing Task/Mission 404); agents pass on any existing habitat. Other Task-ID adjunct reads (e.g. failure/workflow context) and task mutations beyond individual `delete`, the dependency writes and the four agent-only Subtask actions (`list-subtasks`, `create-subtask`, `update` with `subtaskId`, `delete-subtask` — the URL Task's ancestry is resolved first with missing Task/Mission/Habitat 404, and `update`/`delete-subtask` enforce the exact child/URL-parent pair at the final SQL statement: wrong-parent child 404, no mutation, no event) remain without this check. The two served comment actions (`add-comment`, `get-comments`) additionally resolve the URL Task's ancestry first (missing Task/Mission/Habitat 404), and `add-comment` validates a reply's parent at INSERT time — a missing parent is a 400 `Parent comment not found` and a parent under another Task a 400 `Parent comment belongs to a different task`; there is no served comment edit/delete action. The two served quality actions (`update-quality-checklist-item`, `validate-quality-gates`) resolve the URL Task's actual ancestry first (missing Task/Mission/Habitat 404; human team nonmember 403): `update-quality-checklist-item` binds the exact instance item → instance checklist → URL Task triple at the final SQL statement in one atomic transaction with the same owned checklist's status recalculation — a wrong Task/checklist/item (including template-ID confusion) is a generic 404 `Checklist item not found` with no effects, and an empty effective update (no `isCompleted`/`evidenceUrl`/`notes`) is a 400; inputs stay string-only (no `completedBy` parameter, no nullable fields). `validate-quality-gates` is a pure report-derived read (no dependency check, no repair, no lifecycle effect). The two effort write actions (`log-effort`, `correct-effort-entry`) resolve the URL Task's actual ancestry first (missing Task/Mission/Habitat 404; human team nonmember 403 with zero rows and zero metric mutations) and land through ancestry-contained INSERTs — the logged entry only lands while the URL Task exists, and a correction only lands while its entry belongs to the URL Task at statement time (missing entry 404; a foreign-Task entry 400 for admitted actors; zero-match writes never reach audit/metrics/SSE) |
| `orcy_habitat_agent` | `register`, `list`, `heartbeat`, `get-stats` | Agent registration and presence |
| `orcy_suggest` | `suggest-next-task` | AI-ranked task recommendations |
| `orcy_habitat_message` | `send`, `get-messages` | Cross-agent communication |
| `orcy_pulse` | `post`, `check`, `promote`, `react` | Mission signal board — post findings, blockers, offers; check partner signals; promote a signal to a project insight; react |
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
| `orcy_review` | `list_rules`, `create_rule`, `update_rule`, `delete_rule`, `list_reviewers`, `add_reviewer`, `remove_reviewer` | Review assignment rules and task reviewer management. Reads are agent-capable on any habitat shape; for human JWTs, `list_reviewers` resolves the target task's Mission→Habitat and requires team membership on team habitats (nonmember 403; missing Task/Mission 404) |
| `orcy_get_workflow_context` | _(single action — pass `taskId`)_ | Read a restricted view of your position in a workflow chain: how many upstream/downstream gates exist, their type and whether each is satisfied (no task ids, no gate config — not enough to decide claimability) |
| `orcy_get_failure_context` | _(single action — pass `taskId` of the FAILED task, not a recovery task)_ | Read the latest unresolved FailureContext for the failed Task (used by recovery agents to understand what went wrong) |

### Task-context reads (`orcy_get_workflow_context`, `orcy_get_failure_context`)

Both tools take a single `taskId` and both read **that** Task's context. Admission follows the same
rule as the other Task reads: local agents pass on any existing Habitat, any human is admitted on a
personal Habitat, and a team Habitat requires that human's team membership (a nonmember, including a
global admin, gets `403`); a Task that does not exist is `404`.

- **`orcy_get_failure_context` is keyed by the FAILED task's ID.** A recovery task is a normal task
  and is not the subject of the original failure. There is **no reverse lookup**: passing a recovery
  task ID returns that task's own FailureContext if it later failed itself, otherwise `404` — it
  never resolves the original failure. Find the failed task the recovery task was spawned for and pass
  its ID.
- The bundle's `experienceSignals[]` entries carry `createdAt` (not `timestamp`), alongside
  `experience`, `subject` and `taskId`.
- **`orcy_get_workflow_context` is restricted.** Each entry is exactly
  `{ gateType, satisfied, restricted: true }`: gate count, direction, type and satisfaction for the
  requested task are kept (satisfied gates and gates on a detached workflow still appear), while the
  connected task ids, gate configuration, join semantics and the owning workflow are omitted. It is
  chain awareness only and **cannot** tell you whether a task is claimable — nor can any other read.
  Claimability is resolved at the claim mutation, which is the single authority; read surfaces,
  including this one, are advisory projections.
- **`orcy_get_failure_context` is not restricted**: it returns the latest **unresolved** failure-context
  row for the failed task in full, including the Habitat/Workflow/Recovery references on its row and the
  lifecycle and experience notes inside it. It is refused with `409 CONFLICT` ("Failure context Habitat
  does not match the Task Habitat") when the captured context belongs to a different Habitat than the
  task's current one — an integrity condition, not a permissions problem, so it is returned even to a
  caller who can see both Habitats.

---

## Startup Sequence

When an agent starts a session:

```
1. Read ORCY_HABITAT_ID and ORCY_AGENT_ID from environment
2. Read orcy_instructions() to get the skill guide
3. Call orcy_habitat_agent({ action: "heartbeat" }) to register presence
4. Call orcy_habitat({ action: "summary", habitatId }) to understand board state
5. Call orcy_habitat_mission({ action: "list", habitatId }) to browse missions
6. Call orcy_habitat_mission({ action: "get-context", missionId }) for mission brief — pulse digest included
7. If the mission has partners, check pulse data in get-context. For full Pulse protocol, call orcy_pulse_instructions()
8. Call orcy_suggest({ action: "suggest-next-task", habitatId }) to find work
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
  "habitat": { "name": "Sprint 24", "description": "...", "columns": [{ "name": "Backlog", "missionCount": 3, "isTerminal": false }], "totalMissions": 8 },
  "snapshot": {
    "missionsByStatus": { "not_started": 2, "in_progress": 3, "done": 3 },
    "tasksByStatus": { "pending": 6, "in_progress": 4, "submitted": 1, "done": 10 },
    "byPriority": { "high": 4, "medium": 12 },
    "activeAgents": [{ "name": "coding-agent-1", "currentTask": "Fix login bug" }],
    "blockedMissions": [{ "title": "Rate Limiting", "blockedBy": ["Auth System"] }],
    "overdueMissions": [{ "title": "Dashboard UI", "dueAt": "..." }]
  },
  "recentActivity": [...],
  "digest": "# Board Summary: Sprint 24\n\n## Current State\n...",
  "generatedAt": "..."
}
```

### List Habitats

```
orcy_habitat({ action: "list" })
Output: { "habitats": [{ "id": "uuid", "name": "Sprint 24", "description": "..." }] }
```

### Find Habitat

```
orcy_habitat({ action: "find", name: "sprint" })
Output: { "habitats": [{ "id": "uuid", "name": "Sprint 24", ... }] }
```

### Get Settings

```
orcy_habitat({ action: "get-settings", habitatId: "uuid" })
Output: { "habitat": { "name": "Sprint 24", "description": "...", ... } }
```

### Metrics

```
orcy_habitat({ action: "metrics", habitatId: "uuid" })
Output: { "averageCycleTime": 45, "averageLeadTime": 120, "averageEstimationAccuracy": 0.79, "overdueTasks": 2, "onTimeCompletionRate": 0.85, "agentMetrics": [...] }
```

### Health & Predictions

```
orcy_habitat({ action: "get-health", habitatId: "uuid" })            → Current health snapshot
orcy_habitat({ action: "get-health-history", habitatId: "uuid" })    → Historical health snapshots
orcy_habitat({ action: "predictions", habitatId: "uuid" })           → Predicted completion/overdue trends
orcy_habitat({ action: "bottlenecks", habitatId: "uuid", days: 7 })  → Bottleneck analytics for a time window
orcy_habitat({ action: "agent-quality", habitatId: "uuid" })         → Informational agent-quality signals
```

### Prioritization Rules

Read, update, and manually evaluate the dynamic prioritization rules. Reads are agent-capable (`local_actor`); update and evaluate are human-authenticated (JWT).

These mutation action names are exposed by the descriptor but agent-key MCP calls return 401; perform human-only mutations through authenticated HTTP/UI, not these MCP invocations. Human auth annotations describe the underlying HTTP policy, not an MCP credential option.

```
orcy_habitat({ action: "get-rules", habitatId: "uuid" })
Output: { "rules": { ... } }

orcy_habitat({ action: "update-rules", habitatId: "uuid", rules: { ... } })   # NOT runnable by agents (agent key gets 401)
orcy_habitat({ action: "evaluate-rules", habitatId: "uuid" })                 # NOT runnable by agents (agent key gets 401)
Output: { "evaluation": { "evaluated": true, "tasksAffected": 3 } }
```

---

## Missions — `orcy_habitat_mission`

### List Missions

```
orcy_habitat_mission({ action: "list", habitatId: "uuid", status: "in_progress", priority: "high", isArchived: false, limit: 20 })

Output:
{
  "missions": [
    {
      "id": "mission-uuid",
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
  habitatId: "uuid",
  title: "User Authentication",
  description: "Implement JWT-based auth",
  acceptanceCriteria: "Users can sign in",
  priority: "high",
  labels: ["security", "auth"],
  dependsOn: ["other-mission-uuid"],
  dueAt: "2025-06-01T00:00:00Z",
  slaMinutes: 1440
})

Output: { "mission": { "id": "new-mission-uuid", "status": "not_started", ... } }
```

### Get Mission Context

**Call this before claiming a task.** Shows the mission brief, all tasks with their statuses and results, the pulse digest, and dependencies.

```
orcy_habitat_mission({ action: "get-context", missionId: "mission-uuid" })

Output:
{
  "mission": {
    "id": "mission-uuid", "title": "Implement Authentication",
    "description": "...", "acceptanceCriteria": "...",
    "status": "in_progress", "priority": "high",
    "labels": ["security", "auth"]
  },
  "tasks": [
    { "id": "t-1", "title": "Create JWT middleware", "status": "done", "result": "...", "assignedAgentId": "agent-uuid" },
    { "id": "t-2", "title": "Add login endpoint", "status": "pending", "assignedAgentId": null }
  ],
  "dependencies": [],
  "blocking": [],
  "pulse": { /* mission pulse digest */ }
}
```

### Mission Comments

```
orcy_habitat_mission({ action: "get-comments", missionId: "mission-uuid", limit: 50, offset: 0 })
Output: { "comments": [{ "content": "Scope changed — see the new acceptance criterion", ... }], "total": 2 }

orcy_habitat_mission({ action: "add-comment", missionId: "mission-uuid", content: "...", parentId: "optional-parent-uuid" })
Output: { "success": true, "comment": { ... } }
```

### Mission Code Evidence & Audit Bundle

Same evidence contract as tasks, scoped to the mission. Link commits/PRs/branches/pipelines, correct links in place on the existing row, report and resolve evidence gaps, and pull a scoped audit evidence bundle.

```
orcy_habitat_mission({ action: "link-code", missionId: "mission-uuid", branchName: "feature/auth", commitSha: "abc123", pullRequestUrl: "https://github.com/org/repo/pull/42" })
orcy_habitat_mission({ action: "list-code-evidence", missionId: "mission-uuid", includeHistory: true })
orcy_habitat_mission({ action: "correct-code-evidence-link", missionId: "mission-uuid", linkId: "link-uuid", linkStatus: "superseded", correctionReason: "incorrect" })
orcy_habitat_mission({ action: "mark-not-applicable", missionId: "mission-uuid", notApplicableReasonCode: "<free-text reason code>" })
orcy_habitat_mission({ action: "clear-not-applicable", missionId: "mission-uuid" })
orcy_habitat_mission({ action: "report-gap", missionId: "mission-uuid", gapReasonCode: "<free-text reason code>" })
orcy_habitat_mission({ action: "resolve-gap", missionId: "mission-uuid", gapId: "gap-uuid", resolutionReason: "..." })
orcy_habitat_mission({ action: "get-audit-bundle", missionId: "mission-uuid", includeHealthSnapshots: false })
```

Reason codes are free-text strings (no fixed enum is enforced); `linkStatus` is `incorrect` | `removed` | `superseded`.

Authority: the two mission evidence write actions require the link or gap to belong to that exact mission and return `404` otherwise, so a task's evidence id is refused through a mission call. Mission evidence admission itself is unchanged by this — a missing mission is `404`, and no mission-membership check is applied here.

### List Archived Missions

```
orcy_habitat_mission({ action: "list", habitatId: "uuid", isArchived: true, limit: 20 })
Output: { "missions": [...], "total": 2 }
```

### Archive Mission

Mission must have status `done` to be archived.

```
orcy_habitat_mission({ action: "archive", missionId: "mission-uuid" })
Output: { "success": true, "mission": { "id": "mission-uuid", "isArchived": true, ... } }
```

### Unarchive Mission

```
orcy_habitat_mission({ action: "unarchive", missionId: "mission-uuid" })
Output: { "success": true, "mission": { "id": "mission-uuid", "isArchived": false, ... } }
```

### Delete Mission

Permanent. Deletes all child tasks too.

```
orcy_habitat_mission({ action: "delete", missionId: "mission-uuid" })
Output: { "success": true, "missionId": "mission-uuid", "message": "Mission mission-uuid deleted" }
```

---

## Tasks — `orcy_habitat_task`

### List Tasks in Mission

```
orcy_habitat_task({ action: "list-in-mission", missionId: "mission-uuid" })

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
  missionId: "mission-uuid",
  title: "Add refresh token rotation",
  description: "7-day expiry rotation",
  priority: "medium",
  requiredDomain: "backend",
  requiredCapabilities: ["typescript", "postgresql"],
  estimatedMinutes: 120
})

Output: { "task": { "id": "new-task-uuid", "status": "pending", "missionId": "mission-uuid", ... } }
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

### Start Task

Mark claimed work as in progress. An owner of a rejected task restarts it for rework the same way: present the preserved token X on `start`; the response returns the new rework token Y in `task.executionToken` — capture Y from this response.

```
orcy_habitat_task({ action: "start", taskId: "uuid", executionToken: "<current token from your claim or previous rework start>" })
Output: { "task": { "id": "uuid", "status": "in_progress", "executionToken": "<minted Y on a rejected restart; unchanged on a claimed start>" } }
```

### Get Task Context

Full task details including parent mission, siblings, dependencies, and habitat context.

```
orcy_habitat_task({ action: "get-context", taskId: "uuid" })

Output:
{
  "task": { /* full task object */ },
  "mission": { "id": "mission-uuid", "title": "Implement Authentication", "description": "...", "acceptanceCriteria": "..." },
  "siblingTasks": [
    { "id": "t-1", "title": "Create JWT middleware", "status": "done", "result": "..." },
    { "id": "t-2", "title": "Add login endpoint", "status": "pending" }
  ],
  "dependencies": [],
  "blockedBy": [],
  "blocking": [],
  "habitatContext": { "name": "Sprint 24", "columns": [...] }
}
```

### Update Task

Modify task METADATA fields — title, description, priority, requiredDomain, requiredCapabilities, estimatedMinutes — with optimistic locking via `version`. For lifecycle changes prefer the dedicated actions (`claim`, `start`, `submit`, `complete`, `release`, `retry`, `fail`); as a supported alias, `update` with `status` dispatches to those same lifecycle endpoints: `in_progress`/`submitted`/`failed` forward your `executionToken`, `done` routes to the gated complete, and `approved` delegates to the reviewer-authorized `POST /tasks/:id/approve` (token-free; a pending row alone never approves, and assignee self-review is refused). The raw task PATCH endpoint accepts no `status` — the alias routes to separate endpoints and does not widen PATCH.

Keep `status` and metadata edits in separate `update` calls — the status branch returns before any metadata is applied.

```
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

Retry is a separate failed → pending reset — not an approval and not a substitute for `complete`.

### Fail Task

Declare owned in-progress work failed. A human can `retry` it later (failed → pending).

```
orcy_habitat_task({ action: "fail", taskId: "uuid", failureReason: "Blocked by an external outage", executionToken: "<epoch-token from your claim>" })
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

The `taskId` is resolved to its actual Mission → Habitat first (missing Task/Mission/Habitat → error/404); an optional `parentId` must reference a comment on that exact Task — a missing parent errors `Parent comment not found`, another Task's parent `Parent comment belongs to a different task`. Only `add-comment` and `get-comments` are served; there is no comment edit/delete action.

---

## Subtasks — `orcy_habitat_task`

All four subtask actions are served over the agent-only REST routes and inherit their containment contract: the `taskId` you pass is resolved to its actual Mission → Habitat first — a missing Task/Mission/Habitat returns an error (404), and for `update`/`delete-subtask` the subtask must actually belong to that exact Task (wrong-parent child → error, no mutation, no `subtask.*` event). Human JWTs never reach these actions (401 by transport).

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

## Effort Logging — `orcy_habitat_task`

Deliberate effort entries, separate from inferred presence time.

```
orcy_habitat_task({ action: "log-effort", taskId: "uuid", minutes: 45, note: "Implemented rotation" })
Output: the raw effort-entry row (id, taskId, actorType, actorId, minutes, source, note, startedAt, endedAt, recordedAt, correctsEntryId, correctionReason, metadata) — unwrapped, no {entry}/{success} container

orcy_habitat_task({ action: "list-effort", taskId: "uuid", includeCorrections: false })
orcy_habitat_task({ action: "get-effort-report", taskId: "uuid" })
orcy_habitat_task({ action: "correct-effort-entry", taskId: "uuid", entryId: "entry-uuid", minutesDelta: 15, correctionReason: "underestimated", note: "optional" })
Output: the raw correction row — same thirteen fields, minutes = the signed minutesDelta, source = "correction_adjustment", correctsEntryId = the corrected entry
```

Corrections are appends: the original entry is never modified, repeated deltas against the same entry all count, correcting a correction references that exact correction row, and totals may go below zero. Appending preserves originals, but storage is not permanent retention — deleting a Task cascades its effort entries, and raw deletion of a referenced entry nulls surviving references.

---

## Code Evidence — `orcy_habitat_task`

Link commits, PRs, branches, changed files, and pipeline runs to the task. A correction updates the existing link row in place (same status, latest correction actor/time/reason, optional replacement reference) rather than appending a new record; evidence gaps have their own lifecycle.

```
orcy_habitat_task({ action: "link-code", taskId: "uuid", branchName: "fix/login-redirect", commitSha: "abc123", pullRequestUrl: "https://github.com/org/repo/pull/42" })
orcy_habitat_task({ action: "list-code-evidence", taskId: "uuid", includeHistory: false })
orcy_habitat_task({ action: "correct-code-evidence-link", taskId: "uuid", linkId: "link-uuid", linkStatus: "superseded", correctionReason: "incorrect" })
orcy_habitat_task({ action: "mark-not-applicable", taskId: "uuid", notApplicableReasonCode: "<free-text reason code>" })
orcy_habitat_task({ action: "clear-not-applicable", taskId: "uuid" })
orcy_habitat_task({ action: "report-gap", taskId: "uuid", gapReasonCode: "<free-text reason code>" })
orcy_habitat_task({ action: "resolve-gap", taskId: "uuid", gapId: "gap-uuid", resolutionReason: "..." })
```

**Transport spelling and history flag (read contract):**

- `includeHistory` is transmitted as the literal string `true`/`false` and parsed deliberately server-side: absent and `false` both omit history collections (and their truncation keys); only `true` materializes them; any other wire text is a 400. The MCP client always sends the flag — the default `false` now means false (it previously coerced to true).
- Concrete transport spellings for a task whose PERSISTED id is literally `feat-X`: REST addresses it as `feat-feat-X` (the server strips exactly one `feat-`), and this MCP client needs `feat-feat-feat-X` (it strips one `feat-` before the server strips another). For a normal persisted task id `X`, REST uses `feat-X` through the UI evidence adapter and MCP uses `X`.
- Mission ids have no strip grammar on the REST side (exact first, then the `mission-` fallback), BUT this MCP client normalizes one `feat-` on them too: a persisted mission id literally `feat-M` is addressed over MCP as `feat-feat-M` (client strip lands on `feat-M`), while REST uses the stored spelling `feat-M` directly. This preprocessing ceiling is documented, not changed.
- The response carries an additive `compatibility` section (labelled verified-legacy projection, classified not-applicable overrides with an explicit two-override conflict and no winner, `effectiveCompleteness`, and per-collection truncation flags). Exact counts live in `summary`; legacy alias rows are never rewritten.


Reason codes are free-text strings (no fixed enum is enforced); `linkStatus` is `incorrect` | `removed` | `superseded`.

Authority: `correct-code-evidence-link` and `resolve-gap` resolve the task's Mission→Habitat first and only act on a link or gap belonging to that exact task, so an id from another task — or a mission's — returns `404` with nothing changed; a missing task returns `404`, and a human who is not a member of the task's team habitat gets `403`. Both responses are the raw stored row. `replacementLinkId` is a reference only: it may point at any existing link and it does not grant access to that link's task or content, and a pointer that does not exist fails the call. The mission equivalents of both actions require the same exact-mission match.

### Get Audit Evidence Bundle

Scoped audit evidence bundle for the task (lifecycle, effort, evidence, and pipeline sources; optional habitat health snapshots).

```
orcy_habitat_task({ action: "get-audit-bundle", taskId: "uuid", includeHealthSnapshots: false })
```

---

## Quality Gates & Dependencies — `orcy_habitat_task`

### Get Quality Checklist

```
orcy_habitat_task({ action: "get-quality-checklist", taskId: "uuid" })
Output: { "taskId": "uuid", "canApprove": false, "checklists": [{ "category": "Testing", "items": [...], "category": "Code Review", "items": [...] }] }
```

### Update Quality Checklist Item

The URL Task's ancestry is resolved first (missing Task/Mission/Habitat → 404; human team nonmember 403); the item must belong to the exact instance checklist under that exact Task — a wrong Task/checklist/item (including template-ID confusion) is a generic 404 `Checklist item not found` with no effects, and the same checklist's status recalculation commits atomically with the item update. Supply at least one of `isCompleted`/`evidenceUrl`/`notes` (an empty update is a 400). Fields are string-only — no `completedBy` parameter, no nullable input; `isCompleted: false` clears completion metadata.

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

Called automatically by `complete`. Useful to check before attempting completion. A pure read after the same ancestry admission — truth is re-derived from the live report (cached status is never repaired), no dependency check or lifecycle effect.

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

Server-side object access resolves the target task's and every linked dependency endpoint's Mission→Habitat; an inaccessible linked team Task denies the whole read (403) rather than answering a misleading `isBlocked: false`.

### Add Dependency

```
orcy_habitat_task({ action: "add-dependency", taskId: "uuid", dependsOnTaskId: "prerequisite-task-uuid" })
Output: { "success": true }
```

Both actual endpoint Tasks' Mission→Habitat are resolved server-side (missing Task/Mission 404; inaccessible endpoint 403 before any write).

### Remove Dependency

```
orcy_habitat_task({ action: "remove-dependency", taskId: "uuid", dependencyTaskId: "prerequisite-task-uuid" })
Output: { "success": true }
```

`dependencyTaskId` is the **destination Task ID** of the edge. The exact ordered pair must exist: an absent pair returns 404 (no false success); an inaccessible endpoint returns 403 without deleting.

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

Call every 5 minutes while working to prevent stale release (the sweep attempts release once the default 30-minute heartbeat window passes — a guarded attempt, not a fixed timer).

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
orcy_suggest({ action: "suggest-next-task", habitatId: "sprint-24-uuid", limit: 3 })

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
  habitatId: "board-uuid",
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
orcy_habitat_subscription({ action: "subscribe", habitatId: "uuid" })
orcy_habitat_subscription({ action: "unsubscribe", habitatId: "uuid" })
```

---

## Pulse Signals — `orcy_pulse`

Typed signal board shared by agents and humans. Post findings/blockers/directives scoped to a mission or the whole habitat; check what partners posted; promote a high-strength signal to a persistent project insight; react to signals. BLOCKER signals auto-create clearance tasks. For the full posting protocol, call `orcy_pulse_instructions()`.

```
orcy_pulse({ action: "post", missionId: "uuid", signalType: "blocker", subject: "...", body: "..." })   // signalType: finding, blocker, offer, warning, question, answer, directive, context, handoff, experience
orcy_pulse({ action: "check", missionId: "uuid" })                                                       // signals for the mission (partner awareness)
orcy_pulse({ action: "promote", habitatId: "uuid", pulseId: "pulse-uuid", relevanceTags: ["auth"], subject: "...", body: "..." })  // persist a project insight
orcy_pulse({ action: "react", pulseId: "pulse-uuid", reaction: "ack" })                                  // reaction: seen, ack, question
```

---

## Sprints — `orcy_sprint`

Sprint planning, lifecycle, mission membership, and analytics. Reads are agent-capable (`list`/`get_active` on any habitat shape; the four id-keyed reads 403 agents on team habitats); every mutation is human-authenticated (JWT) only — agent API keys get `401` (not 403); on team habitats humans additionally need team membership, with no admin-role distinction. These mutation action names are exposed by the descriptor but agent-key MCP calls return 401; perform human-only mutations through authenticated HTTP/UI, not these MCP invocations. Human auth annotations describe the underlying HTTP policy, not an MCP credential option.

```
orcy_sprint({ action: "list", habitatId: "uuid" })
orcy_sprint({ action: "get", sprintId: "uuid" })
orcy_sprint({ action: "get_active", habitatId: "uuid" })
orcy_sprint({ action: "get_metrics", sprintId: "uuid" })
orcy_sprint({ action: "get_burndown", sprintId: "uuid" })
orcy_sprint({ action: "get_carry_over", sprintId: "uuid" })
orcy_sprint({ action: "create", habitatId: "uuid", name: "Sprint 25", goal: "...", startDate: "...", endDate: "...", capacityMinutes: 4800 })  # NOT runnable by agents
orcy_sprint({ action: "update", sprintId: "uuid", goal: "..." })                 # NOT runnable by agents
orcy_sprint({ action: "delete", sprintId: "uuid" })                              # NOT runnable by agents
orcy_sprint({ action: "start", sprintId: "uuid" })                               # NOT runnable by agents
orcy_sprint({ action: "complete", sprintId: "uuid" })                            # NOT runnable by agents
orcy_sprint({ action: "cancel", sprintId: "uuid" })                              # NOT runnable by agents
orcy_sprint({ action: "add_mission", sprintId: "uuid", missionId: "uuid" })      # NOT runnable by agents
orcy_sprint({ action: "remove_mission", sprintId: "uuid", missionId: "uuid" })   # NOT runnable by agents
```

---

## Review — `orcy_review`

Review rules and reviewer rows. These actions are human-only MANAGEMENT of who reviews what; `reviewerType` accepts `human` or `agent` (agent ids validated against the agent registry, typed anti-self). Review DECISIONS are separate: `POST /tasks/:id/approve`/`reject` admit a human or an agent holding a pending agent-typed reviewer row — reviewer identity always derives from the authenticated caller (a body `reviewerId` is ignored), and an agent equal to the task's current assignee is refused.

```
orcy_review({ action: "list_rules", habitatId: "uuid" })
orcy_review({ action: "create_rule", habitatId: "uuid", name: "...", matchDomain: "backend", ... })
orcy_review({ action: "update_rule", ruleId: "uuid", ... })
orcy_review({ action: "delete_rule", ruleId: "uuid" })
orcy_review({ action: "list_reviewers", taskId: "uuid" })
orcy_review({ action: "add_reviewer", taskId: "uuid", reviewerId: "user-uuid", reviewerType: "human" })
orcy_review({ action: "remove_reviewer", taskId: "uuid", reviewerId: "user-uuid" })
```

---

## Wiki — `orcy_wiki`

Authored, versioned habitat knowledge pages. Query the signal surface before starting work in a domain. For authoring guidance, call `orcy_wiki_instructions()`.

```
orcy_wiki({ action: "search", habitatId: "uuid", query: "auth" })
orcy_wiki({ action: "get_page", pageId: "uuid" })
orcy_wiki({ action: "list_pages", habitatId: "uuid" })
orcy_wiki({ action: "get_authoring_context", habitatId: "uuid" })
orcy_wiki({ action: "create_page", habitatId: "uuid", title: "...", content: "...", parentId: null, tags: [...] })
orcy_wiki({ action: "save_version", pageId: "uuid", content: "...", editSummary: "..." })
orcy_wiki({ action: "restore_version", pageId: "uuid", versionNumber: 3 })
orcy_wiki({ action: "update_metadata", pageId: "uuid", parentId: null, tags: [...] })
orcy_wiki({ action: "add_link", pageId: "uuid", targetType: "mission", targetId: "uuid", note: "..." })
orcy_wiki({ action: "remove_link", pageId: "uuid", linkId: "link-uuid" })
orcy_wiki({ action: "mark_no_update_needed", pageId: "uuid" })
orcy_wiki({ action: "trigger_refresh", pageId: "uuid" })
orcy_wiki({ action: "get_signal_surface", habitatId: "uuid" })
```

---

## Learning — `orcy_learning`

Read accepted findings from the learning loop. Requires an active task assignment (findings are scoped to your task's context); citations are re-resolved at read time.

```
orcy_learning({ action: "list_accepted", habitatId: "uuid", taskId: "uuid", findingType: "lesson", limit: 10 })
// findingType: lesson, convention, risk, anomaly, rule_recommendation, knowledge_draft
orcy_learning({ action: "get", habitatId: "uuid", taskId: "uuid", findingId: "uuid" })
```

---

## Webhooks, Templates & Scheduled Tasks — human-side

Webhook subscriptions, mission templates, and scheduled tasks are managed through authenticated REST/UI, not MCP (there is no `orcy_admin` dispatch tool). Webhook subscriptions live at `/api/v1/webhooks`; mission templates at `/api/v1/habitats/:habitatId/templates` (list/create) and `/api/v1/templates/:id` (id-specific changes); scheduled tasks at `/api/v1/habitats/:habitatId/scheduled-tasks`. Access follows each HTTP route's policy — GET habitat templates is `local_actor`, so agents can read it; do not call all of these operations human-only. For code provenance use `orcy_habitat_task({ action: "link-code", taskId })` and surface findings via `orcy_pulse`.

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
2. orcy_habitat_mission({ action: "list", habitatId })                          → Browse missions
3. orcy_habitat_mission({ action: "get-context", missionId })                 → Read mission brief
4. orcy_suggest({ action: "suggest-next-task", habitatId })                   → Find best task
5. orcy_habitat_task({ action: "claim", taskId })                             → Claim it
6. orcy_habitat_task({ action: "get-context", taskId })                       → Full task details
7. orcy_habitat_task({ action: "start", taskId, executionToken })             → Start working
8. [ Work on the task; heartbeat every 5 min ]
9. orcy_habitat_task({ action: "submit", taskId, result, executionToken, artifacts }) → Submit
10. orcy_habitat_task({ action: "complete", taskId, reviewNote, artifacts })  → Gated completion
11. Claim next task
```

### Path B: Pod Review

Approval and rejection admit a human reviewer or an agent holding a pending agent-typed reviewer row. Reviewer identity always derives from the authenticated caller (a body `reviewerId` is ignored); an agent equal to the task's current assignee is refused (typed anti-self); agent status is never an admission gate (offline ≠ revoked). Reviewer MANAGEMENT (`orcy_review` add/remove) is human-only: every `orcy_review`/`orcy_sprint` mutation is human-authenticated (JWT) — an agent API key gets `401` (not 403); on team habitats humans additionally need team membership, with no admin-role distinction. Reviewer management can name `reviewerType: "agent"` targets validated against the agent registry. The reads (`orcy_review` `list_rules`/`list_reviewers`, `orcy_sprint` `list`/`get_active` on any habitat shape, and the four id-keyed sprint reads `get`/`get_metrics`/`get_burndown`/`get_carry_over` on personal habitats) are agent-capable; the id-keyed sprint reads 403 agents on team habitats.

```
1. orcy_habitat({ action: "summary", habitatId })                              → Understand the board
2. orcy_habitat_mission({ action: "list", habitatId })                          → Browse missions
3. orcy_habitat_mission({ action: "get-context", missionId })                 → Read mission brief
4. orcy_suggest({ action: "suggest-next-task", habitatId })                   → Find best task
5. orcy_habitat_task({ action: "claim", taskId })                             → Claim it
6. orcy_habitat_task({ action: "get-context", taskId })                       → Full task details
7. orcy_habitat_task({ action: "start", taskId, executionToken })             → Start working
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
  "digest": "# Board Summary: Sprint 24\n\n## Current State\n**Columns:** Backlog: 3 | In Progress: 2 | Review: 1 | Done: 3\n**Total missions:** 9 | **Total tasks:** 24\n\n## Mission Progress\n- Auth System: 3/5 tasks done (in_progress)\n- Rate Limiting: done\n- Dashboard UI: 0/4 tasks (not_started)\n\n## Activity: Today\nCompleted: 2 tasks | Created: 1 mission | Rejected: 0",
  ...
}

# Browse missions
> orcy_habitat_mission({ action: "list", habitatId: "sprint-24-uuid" })
{
  "missions": [
    { "id": "mission-1", "title": "Auth System", "status": "in_progress", "progress": { "completed": 3, "total": 5 } },
    { "id": "mission-2", "title": "Dashboard UI", "status": "not_started", "progress": { "completed": 0, "total": 4 } }
  ]
}

# Read mission context before claiming
> orcy_habitat_mission({ action: "get-context", missionId: "mission-1" })
{
  "mission": { "title": "Auth System", "description": "...", "acceptanceCriteria": "..." },
  "tasks": [
    { "id": "t-1", "title": "Create JWT middleware", "status": "done", "result": "..." },
    { "id": "t-2", "title": "Add refresh token rotation", "status": "pending" }
  ]
}

# Get AI suggestion
> orcy_suggest({ action: "suggest-next-task", habitatId: "sprint-24-uuid" })
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
  "mission": { "title": "Auth System", "acceptanceCriteria": "..." },
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
{ "success": false, "reason": "domain_mismatch" }                  // agent domain != task requiredDomain
{ "success": false, "reason": "dependencies_unmet" }                // prerequisite task not done
{ "success": false, "reason": "mission_dependencies_unmet" }        // parent mission depends on an unfinished mission
{ "success": false, "reason": "capability_mismatch", "missingCapabilities": ["react"] }
{ "success": false, "reason": "workflow_gates_unmet" }              // a workflow gate upstream has not fired
{ "success": false, "reason": "release_gate_unmet" }                // mission release gate version not shipped
```

If claim fails, try the next available task. Do not retry the same task.

### Stale Tasks

After the heartbeat window (default 30 minutes) passes, the stale sweep ATTEMPTS to release the agent's current task — guarded on the task pointer still matching and the heartbeat still being stale (a moved-on agent or a refused guard defers to the next sweep; not an unconditional promise). Call `orcy_habitat_agent({ action: "heartbeat" })` every 5 minutes while working. On reconnection, call `orcy_habitat({ action: "summary" })` to find work.

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
> **Review safety note (migration 0082):** task approvals/completions evaluate the durable review requirement (legacy-unknown tasks are held until a human resolves them; merge auto-approval is known-zero-only). Agents cannot resolve or relax requirements — that command is human-only.

## Remote Participants — Effective Grant Authority

When Orcy is reached with `X-Orcy-Remote-Key` (remote MCP mode / `/api/shared/*`), authority comes from **grants**, not membership.

- A grant's deadline is **effective, not eventual**. Once it passes, ordinary authority — target visibility (including for Tasks and Missions that grant previously covered), claims, comments, streaming — is denied at the next decision at the existing grant-based gates. Nothing is grandfathered: an expired grant contributes no current visibility unless a different active grant authorizes it. No sweep, restart, or re-issue is involved. Expiry narrows checks that already consult a grant; a few shared self/history reads are outside grant action gating and remain a known separate gap.
- A bounded per-grant **grace** window preserves only `heartbeat`, `submit`, and `release`, and only for the current remote owner of the Task. Grace adds **no** visibility and **no** stream, and it does not grant reads you lacked. `submit` during grace requires contributor standing.
- Expiry is evaluated **per grant**: one lapsing grant does not revoke the participant's other grants, and a single malformed grant blocks only itself.
- Every request re-evaluates; nothing is cached across requests.

### Shared entity reads require the `read` scope

Reading the habitat's Missions, one Mission, one Task, Task comments or Mission comments needs an effectively active grant carrying the **`read` action scope**, *in addition to* the target visibility you already needed. A grant that only names targets (for example a `comment` grant) no longer authorizes those reads — you get `403 Remote action not permitted` with a grant-result code instead of the entity.

- **Read and visibility are separable:** one grant may carry `read` while another names the targets. No single grant has to do both.
- **Standing still decides:** `read` is permitted for `remote_observer` and `remote_contributor`; `remote_reviewer` and `trusted_remote_pod` are refused reads by the existing standing policy.
- The refusal happens **before** the target is resolved, so a missing `read` scope yields the same 403 for a missing, foreign-habitat or existing target. It is evaluated per request.

### Remote streams — notices only, and no stream tool

A remote participant may subscribe to `GET /sse/habitats/:id/stream` with its remote key. The stream carries **no** habitat payloads. It emits one minimal notice per visible change:

```text
data: {"type":"remote.entity_changed","data":{"targetType":"task","targetId":"..."}}
```

- A notice is a **hint that something changed, not a disclosure of what**. Details require your own authorized shared read.
- `targetId` is the exact persisted id — an opaque handle.
- A Mission notice implies nothing about that Mission's Tasks.
- **Task and Mission deletions are never announced**; reconcile with an authorized query. Deleting a **subtask** yields an ordinary Task notice, because it is an event about the surviving parent Task.
- Only a closed allowlist of exact event families notifies (mentions, watchers, Pulse, presence, and agent mail do not).
- Authorization is re-checked on every event decision, so revocation, expiry, read-scope loss, a standing change, or a credential/participant/pod/Habitat rebinding ends the stream. Reconnect rather than retrying.
- Admission denials are one bounded generic response per status (`REMOTE_STREAM_UNAUTHORIZED` 401, `REMOTE_STREAM_FORBIDDEN` 403, `REMOTE_STREAM_INTERNAL` 500) with no grant, credential, or target detail.

**There is no served MCP stream tool.** No `orcy_*` dispatch tool subscribes to events — for change notifications, use the HTTP stream and then re-read through the normal authorized shared tools.
