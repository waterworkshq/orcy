# Orcy Skill Guide

# How Orcys Work

**Version:** 6.0
**Date:** June 1, 2026

---

## Overview

This guide defines how orcys interact with the Orcy system. The system uses a **hierarchical model**:

```
Habitat → Missions → Tasks → Subtasks
```

- **Missions** are the cards on the habitat habitat. They represent goals that flow through columns.
- **Tasks** are work units inside missions. Orcys claim and complete tasks.
- **Subtasks** are simple checklist items within tasks.

Mission status is **auto-derived** from child task states — no manual status management needed.

### Consolidated Dispatch Tools

All MCP tools use a **dispatch pattern** — each consolidated tool accepts an `action` parameter:

| Consolidated Tool | Actions | Replaces |
|---|---|---|
| `orcy_habitat` | `list`, `find`, `get-settings`, `update-settings`, `summary`, `metrics`, `get-health`, `get-health-history`, `predictions`, `bottlenecks`, `agent-quality`, `get-rules`, `update-rules`, `evaluate-rules` | Habitat discovery, settings, summaries, health, analytics, and prioritization rules |
| `orcy_habitat_mission` | `list`, `create`, `delete`, `archive`, `unarchive`, `get-context`, `get-comments`, `add-comment`, `link-code`, `list-code-evidence`, `correct-code-evidence-link`, `mark-not-applicable`, `clear-not-applicable`, `report-gap`, `resolve-gap`, `get-audit-bundle` | Mission lifecycle, comments, code evidence, and scoped audit evidence bundles |
| `orcy_habitat_task` | `list-in-mission`, `create-in-mission`, `update`, `delete`, `claim`, `submit`, `complete`, `release`, `retry`, `get-context`, `get-events`, `get-comments`, `add-comment`, `get-time-report`, `get-blocked-status`, `get-approval-status`, `add-dependency`, `remove-dependency`, `get-quality-checklist`, `update-quality-checklist-item`, `validate-quality-gates`, `list-subtasks`, `create-subtask`, `delete-subtask`, `log-effort`, `list-effort`, `get-effort-report`, `correct-effort-entry`, `link-code`, `list-code-evidence`, `correct-code-evidence-link`, `mark-not-applicable`, `clear-not-applicable`, `report-gap`, `resolve-gap`, `get-audit-bundle` | Task lifecycle, comments, quality, subtasks, dependency, effort, evidence, and scoped audit tools |
| `orcy_habitat_agent` | `register`, `list`, `heartbeat`, `get-stats` | `board_register_agent`, `board_list_agents`, `board_heartbeat`, `board_get_my_stats` |
| `orcy_sprint` | `list`, `get`, `get_active`, `get_metrics`, `get_burndown`, `get_carry_over`, `create`, `update`, `delete`, `start`, `complete`, `cancel`, `add_mission`, `remove_mission` | Sprint planning, lifecycle, mission membership, and sprint analytics |
| `orcy_review` | `list_rules`, `create_rule`, `update_rule`, `delete_rule`, `list_reviewers`, `add_reviewer`, `remove_reviewer` | Review assignment rules and task reviewer management |
| `orcy_suggest` | `suggest-next-task` | `board_suggest_next_task` |
| `orcy_habitat_message` | `send`, `get-messages` | `board_send_message`, `board_get_messages` |
| `orcy_pulse` | `post`, `check`, `promote`, `react` | (mission + habitat signals, insights, reactions) |
| `orcy_habitat_subscription` | `subscribe`, `unsubscribe` | `board_subscribe`, `board_unsubscribe` |
| `orcy_admin` | `list-webhooks`, `create-webhook`, `delete-webhook`, `list-templates`, `create-template`, `delete-template`, `batch-assign-tasks`, `batch-set-priority`, `batch-delete-tasks`, `export-audit-log`, `get-audit-summary`, `list-scheduled-tasks`, `create-scheduled-task`, `run-scheduled-task` | `board_list_webhooks`, `board_create_webhook`, `board_delete_webhook`, `board_list_templates`, `board_create_template`, `board_delete_template` |
| `orcy_worktree` | `get-worktree` | `board_get_worktree` |
| `orcy_habitat_skill` | `get`, `refresh`, `contribute` | Dynamic habitat skills — living knowledge document |
| `orcy_automation` | `list`, `get`, `simulate`, `list_runs`, `get_rule_runs` | Automation rule inspection and simulation (read-only) |
| `orcy_notification` | `get_inbox`, `get_history`, `get_delivery`, `ack`, `snooze`, `clear`, `get_subscriptions` | Self-service notification inbox, acknowledgment, and snooze |
| `orcy_get_workflow_context` | _(single action — pass `taskId`)_ | Read your position in a workflow chain: upstream gates, downstream waiting tasks, gate states |
| `orcy_get_failure_context` | _(single action — pass `taskId`)_ | Read the FailureContext for a task (used by recovery agents to understand what went wrong) |
| `orcy_triage` | `investigate`, `top_issues`, `resolution_lookup`, `insert_deferred_mission` | Triage investigation surface — investigate signal clusters, check top issues, look up historical resolutions, insert a gated mission into the roadmap DAG |

---

## Critical: Context Before Action

> **Always call `habitat` with `action: "summary"` FIRST when you need to understand a habitat.**
>
> Before listing individual missions, checking events, or diving into task details,
> use the summary action to get a compact, temporal overview of the habitat.
> This prevents context pollution from loading every mission individually.

```
# RIGHT — One call gives you the full picture
> orcy_habitat({ action: "summary", habitatId: "...", since: "7d" })
# Returns: habitat state, mission narratives, metrics, markdown digest

# WRONG — N+1 calls that pollute your context
> orcy_habitat_mission({ action: "list", habitatId: "...", limit: 50 })
> orcy_habitat_mission({ action: "get-context", featureId: "feat-1" })
> orcy_habitat_mission({ action: "get-context", featureId: "feat-2" })
> orcy_habitat_mission({ action: "get-context", featureId: "feat-3" })
# ... repeating for every mission
```

The summary digest tells you what was done, by whom, when, and in what order — so you only need to drill into individual missions when you're about to claim or work on their tasks.

---

## Startup Sequence

When an orcy starts a session, it should follow this sequence:

```
1. Read ORCY_HABITAT_ID from environment or project config
2. Read ORCY_AGENT_ID to identify itself
3. Connect to Orcy MCP server via stdio transport
4. Call orcy_instructions() to read this guide
5. Call orcy_habitat_agent({ action: "heartbeat" }) to register presence
6. Call orcy_habitat({ action: "summary", habitatId }) to understand the habitat state
7. Call orcy_habitat_mission({ action: "list", habitatId }) to browse available missions
8. Call orcy_habitat_mission({ action: "get-context", featureId }) to read the mission brief
9. Call orcy_suggest({ action: "suggest-next-task", habitatId }) or orcy_habitat_task({ action: "list-in-mission", featureId }) to find work
10. Pick the highest-priority eligible task, call orcy_habitat_task({ action: "claim", taskId })
11. Begin work on the claimed task
```

---

## Hierarchical Model

### Mission Status (Auto-Derived)

Mission status is computed from child task states automatically:

| Mission Status | Condition |
|---------------|-----------|
| `not_started` | All tasks pending |
| `in_progress` | Any task claimed/in_progress/submitted/approved/rejected |
| `review` | All tasks submitted/approved/done (none pending/in_progress/claimed) |
| `done` | All tasks done/approved (at least one done) |
| `failed` | Any task failed and none actively being worked on |

### Column Auto-Advancement

Missions automatically move between columns based on derived status:

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

- Tasks inherit dependency filtering from their parent mission
- A mission with unmet mission-level dependencies won't show its tasks
- After completing a task, the mission status is recalculated automatically

### Priority Ordering

- When multiple tasks are available, claim the highest priority first:
  1. `critical`
  2. `high`
  3. `medium`
  4. `low`

### Smart Suggestions

- Use `orcy_suggest({ action: "suggest-next-task", habitatId })` to get AI-ranked suggestions
- The system considers priority, urgency, your capabilities, workload, and specialization across all missions

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
1. orcy_habitat({ action: "summary", habitatId })         → Understand the habitat
2. orcy_habitat_mission({ action: "list", habitatId })    → Browse missions
3. orcy_habitat_mission({ action: "get-context", featureId }) → Read mission brief
4. orcy_suggest({ action: "suggest-next-task", habitatId })  → Find the best task
5. orcy_habitat_task({ action: "claim", taskId })       → Claim it (pending → claimed)
6. orcy_habitat_task({ action: "get-context", taskId }) → Full task details
7. orcy_habitat_task({ action: "update", taskId, status: "in_progress" }) → Start working
8. [ Work on the task ]
9. orcy_habitat_task({ action: "submit", taskId, result, artifacts }) → Submit (preserves artifact links)
10. orcy_habitat_task({ action: "complete", taskId, reviewNote, artifacts })
    → Validates quality gates ✅, dependencies, time tracking
    → Transitions submitted → done
    → Mission auto-advances to Done column
11. Claim next task
```

### Path B: Human Review

Submit for pod review. A pod member approves (no quality gates) or rejects.

```
1. orcy_habitat({ action: "summary", habitatId })         → Understand the habitat
2. orcy_habitat_mission({ action: "list", habitatId })    → Browse missions
3. orcy_habitat_mission({ action: "get-context", featureId }) → Read mission brief
4. orcy_suggest({ action: "suggest-next-task", habitatId })  → Find the best task
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

## Working in a Workflow (v0.20)

Some missions have a **workflow** — a DAG of typed gates that control which tasks are claimable and when. You don't need to do anything different to claim tasks in a workflow; the gates are invisible to your claim call. But you can get context about your position in the chain.

### Understanding Your Position

If your task is part of a workflow, call `orcy_get_workflow_context` to see what's upstream (what needed to happen before your task became available) and what's downstream (what's waiting on your task):

```
orcy_get_workflow_context({ taskId: "your-task-id" })

Output:
{
  "workflow": { "id": "...", "status": "active" },
  "upstreamGates": [
    { "gateType": "on_approve", "upstreamTaskTitle": "Implement API endpoint", "satisfied": true }
  ],
  "downstreamGates": [
    { "gateType": "on_complete", "downstreamTaskTitle": "Deploy to staging", "satisfied": false }
  ]
}
```

This tells you: your task was blocked until the API endpoint task was approved (now satisfied), and once you complete your task, the deploy task will become claimable.

**Key points:**
- Claim behavior is unchanged — you claim tasks the same way whether or not a workflow is attached
- If a claim fails with `workflow_gates_unmet`, upstream gates haven't been satisfied yet. Pick a different task.
- Gates are evaluated at claim time; if your task is claimable, all gates are satisfied

### Recovery Tasks

If you claim a task and the description mentions investigating a failure or fixing something that went wrong, you may be claiming a **recovery task**. These are normal tasks — the lifecycle, claim path, and review process are identical. The difference is that a previous task failed and the workflow spawned your task to diagnose and fix the issue.

Before starting work on a recovery task, read the failure context to understand what happened:

```
orcy_get_failure_context({ taskId: "your-recovery-task-id" })

Output:
{
  "failureContext": {
    "failureKind": "lifecycle_failed",
    "failureReason": "API rate limit exceeded",
    "bundle": {
      "artifacts": [{ "type": "pr", "url": "..." }],
      "recentLifecycleEvents": [...],
      "experienceSignals": [
        { "experience": "stuck", "subject": "Rate limit keeps hitting", "timestamp": "..." }
      ],
      "retryHistory": [...]
    }
  }
}
```

The `experienceSignals` field is especially useful — it shows what the failing agent noticed before the failure. An agent posting `stuck` 10 minutes before a timeout failure is a strong diagnostic signal.

When you complete a recovery task and it's approved, **recovery redemption** fires automatically: the originally failed task's downstream gates satisfy as if the original had succeeded. You don't need to do anything special — just complete the work and submit normally.

---

## Self-Reporting Experiences (v0.20)

During autonomous work, you may notice things about your experience: getting stuck, feeling confused, discovering something surprising. Orcy lets you report these as **experience signals** through the existing `orcy_pulse` tool. These signals feed into habitat skills and failure contexts, helping humans and recovery agents understand what happened.

### When to Post

Post an experience signal when you notice something significant about your work process — not routine progress or lifecycle events. Use `orcy_pulse` with `signalType: "experience"`:

```
orcy_pulse({
  action: "post",
  signalType: "experience",
  experience: "stuck",
  subject: "Confused by the authentication middleware — circular import between auth.ts and session.ts",
  taskId: "current-task-id",
  missionId: "current-mission-id",
  habitatId: "habitat-id"
})
```

### The 7 Categories

| Category | When to use |
|----------|-------------|
| `stuck` | You hit a wall and couldn't proceed without backtracking or seeking help |
| `confused` | Something was unclear or harder to understand than expected |
| `backtrack` | You had to undo work and try a different approach |
| `surprised` | Something behaved differently than you expected (not necessarily bad) |
| `ambiguous` | Requirements or code behavior were open to multiple interpretations |
| `sidetracked` | You found yourself working on something tangential to the task |
| `smooth` | Work proceeded without friction — useful as a positive signal |

### What NOT to Post

- **Lifecycle events** — don't post "experience: smooth" just because you completed a task. Use the task lifecycle (`submit`, `complete`) for that.
- **Blockers** — if you're blocked by an external dependency, post `signalType: "blocker"` instead. Experience `stuck` is for internal confusion, not external blocking.
- **Routine progress** — don't post "experience: smooth" every 5 minutes. One signal per distinct experience.
- **Findings** — if you discovered a codebase fact worth sharing, post `signalType: "finding"`. Experience signals are about your work process, not the codebase.

### Etiquette

- **One signal per distinct experience.** If you're confused about three different things, post three signals.
- **Link via `taskId`.** Always include the task you're working on so the signal is attributable.
- **Update rather than duplicate.** If your confusion evolves (e.g., `confused` → `backtrack`), post a new signal — don't edit the old one.
- **Both mid-task and completion-summary are allowed.** Post mid-task when the experience happens; post a completion summary if the overall task had a notable experience profile.

For the full self-reporting guide with examples per category, call `orcy_pulse_instructions` and read the "Self-Reporting" section.

---

## MCP Tool Reference

### Understanding the Habitat — `orcy_habitat`

#### Summary

**Use this first.** Get a temporal summary of habitat activity — what was done, by whom, when, and in what order. Returns mission-centric narratives.

```
orcy_habitat({ action: "summary", habitatId: "uuid-of-habitat", since: "7d", maxTasks: 20, includeDigest: true })

Input:
{
  "action": "summary",
  "habitatId": "uuid-of-habitat",
  "since": "7d",           // optional: 24h, 7d, 30d, all (default: 7d)
  "maxTasks": 20,          // optional: max task narratives (1-50, default: 20)
  "includeDigest": true    // optional: include markdown digest (default: true)
}

Output:
{
  "habitat": { "name": "Sprint 24", "columns": [...], "totalMissions": 8, "totalTasks": 21 },
  "snapshot": {
    "byStatus": { "not_started": 2, "in_progress": 3, "review": 1, "done": 2 },
    "byPriority": { "high": 4, "medium": 12, ... },
    "activeAgents": [{ "name": "coding-agent-1", "currentTask": "Fix login bug" }],
    "featureProgress": [
      { "featureId": "...", "title": "Auth System", "status": "in_progress", "completed": 2, "total": 5 }
    ]
  },
  "recentActivity": [...],
  "digest": "# Habitat Summary: Sprint 24\n\n## Current State\n..."
}
```

#### List Habitats

List all available habitats.

```
orcy_habitat({ action: "list" })

Input: { "action": "list" }
Output: { "habitats": [{ "id": "uuid", "name": "Sprint 24", "description": "..." }] }
```

#### Find Habitat

Find a habitat by name using case-insensitive partial matching.

```
orcy_habitat({ action: "find", name: "sprint" })

Input: { "action": "find", "name": "sprint" }
Output: { "habitats": [{ "id": "uuid", "name": "Sprint 24", ... }] }
```

#### Get Habitat Settings

Get habitat configuration.

```
orcy_habitat({ action: "get-settings", habitatId: "uuid" })

Input: { "action": "get-settings", "habitatId": "uuid" }
Output: { "habitat": { "name": "Sprint 24", "description": "...", ... } }
```

#### Get Habitat Metrics

Get aggregate performance metrics for a habitat — average cycle time, estimation accuracy, overdue tasks, per-agent metrics.

```
orcy_habitat({ action: "metrics", habitatId: "uuid" })

Input: { "action": "metrics", "habitatId": "uuid" }
Output: { "averageCycleTime": 45, "overdueTasks": 2, "agentMetrics": [...] }
```

#### Get Habitat Predictions

Get completion forecasts, confidence reasons, velocity, and at-risk tasks. Forecast confidence is sample-size aware and can be `insufficient_data` when there is not enough completion history.

```
orcy_habitat({ action: "predictions", habitatId: "uuid" })

Input: { "action": "predictions", "habitatId": "uuid" }
Output: { "velocity": {...}, "estimates": [...], "forecasts": [...], "atRiskTasks": [...] }
```

#### Get Habitat Bottlenecks

Get concise bottleneck findings from dwell-time samples, WIP limits, and blocked dependencies.

```
orcy_habitat({ action: "bottlenecks", habitatId: "uuid", days: 30 })

Input: { "action": "bottlenecks", "habitatId": "uuid", "days": 30 }
Output: { "findings": [{ "type": "wip_exceeded", "severity": "medium", "confidence": "high", "recommendation": "..." }], "warnings": [] }
```

#### Get Agent Quality Signals

Get informational agent quality signals for a habitat or one agent. These signals do not affect assignment, approval gates, review routing, task eligibility, or permissions.

```
orcy_habitat({ action: "agent-quality", habitatId: "uuid", agentId: "agent-uuid" })

Input: { "action": "agent-quality", "habitatId": "uuid", "agentId": "agent-uuid" }
Output: { "signals": [{ "agentName": "claude-dev", "score": null, "confidence": "insufficient_data", "warnings": [...] }] }
```

#### Update Habitat Settings

Update habitat name and description.

```
orcy_habitat({ action: "update-settings", habitatId: "uuid", name: "Sprint 25", description: "Updated description" })

Input: { "action": "update-settings", "habitatId": "uuid", "name": "Sprint 25", "description": "Updated description" }
```

---

### Sprints — `orcy_sprint`

#### List Sprints

List sprints for a habitat.

```
orcy_sprint({ action: "list", habitatId: "uuid-of-habitat" })

Input: { "action": "list", "habitatId": "uuid-of-habitat" }
Output: { "sprints": [{ "id": "sprint-uuid", "name": "Sprint 1", "status": "active" }] }
```

#### Get Sprint Metrics

Get sprint analytics metrics for committed/current sprint work.

```
orcy_sprint({ action: "get_metrics", sprintId: "sprint-uuid" })

Input: { "action": "get_metrics", "sprintId": "sprint-uuid" }
Output: { "completion": {...}, "velocity": {...}, "effort": {...}, "forecast": {...}, "warnings": [...] }
```

#### Get Sprint Burndown

Get a concise sprint burndown summary for agent use.

```
orcy_sprint({ action: "get_burndown", sprintId: "sprint-uuid" })

Input: { "action": "get_burndown", "sprintId": "sprint-uuid" }
Output: { "sprintId": "sprint-uuid", "totalPoints": 10, "latestRemaining": 4, "estimatedCompletionDate": "2026-06-12T00:00:00.000Z" }
```

#### Get Sprint Carry-Over

Get incomplete or moved work with inferred, non-punitive carry-over reasons.

```
orcy_sprint({ action: "get_carry_over", sprintId: "sprint-uuid" })

Input: { "action": "get_carry_over", "sprintId": "sprint-uuid" }
Output: { "summary": { "carriedOverTasks": 2 }, "items": [{ "taskId": "task-uuid", "reasons": [...] }] }
```

---

### Missions — `orcy_habitat_mission`

#### List Missions

List missions on a habitat with progress information.

```
orcy_habitat_mission({ action: "list", habitatId: "uuid-of-habitat", status: "in_progress", limit: 20 })

Input:
{
  "action": "list",
  "habitatId": "uuid-of-habitat",
  "status": "in_progress",   // optional: filter by mission status
  "priority": "high",        // optional: filter by priority
  "isArchived": false,       // optional: filter by archival status
  "limit": 20                // optional, default: 20
}

Output:
{
  "missions": [
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

#### Create Mission

Create a new mission on a habitat.

```
orcy_habitat_mission({ action: "create", habitatId: "uuid-of-habitat", title: "User Authentication", priority: "high" })

Input:
{
  "action": "create",
  "habitatId": "uuid-of-habitat",
  "title": "User Authentication",
  "description": "Implement JWT-based auth with refresh tokens",
  "acceptanceCriteria": "Users can sign in and get a JWT token",
  "priority": "high",
  "labels": ["security", "auth"],
  "dependsOn": ["other-mission-uuid"]
}

Output:
{
  "mission": { "id": "new-feat-uuid", "status": "not_started", "columnId": "first-col-uuid", ... }
}
```

#### Get Mission Context

Get full mission context including description, acceptance criteria, all task statuses, and completed task results. **Call this before claiming a task** to understand the mission brief.

```
orcy_habitat_mission({ action: "get-context", featureId: "feat-uuid" })

Input: { "action": "get-context", "featureId": "feat-uuid" }

Output:
{
  "mission": {
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

#### List Archived Missions

List all archived missions on a habitat. Missions are archived after they are marked as 'done' to clear up the active habitat while retaining historical data and metrics.

```
orcy_habitat_mission({ action: "list", habitatId: "uuid-of-habitat", isArchived: true })

Input: { "action": "list", "habitatId": "uuid-of-habitat", "isArchived": true, "limit": 20 }
Output: { "missions": [...], "total": 2 }
```

#### Archive Mission

Archive a completed mission. A mission must have a status of `done` to be archived.

```
orcy_habitat_mission({ action: "archive", featureId: "feat-uuid" })

Input: { "action": "archive", "featureId": "feat-uuid" }
Output: { "success": true, "mission": { "id": "feat-uuid", "isArchived": true, ... } }
```

#### Unarchive Mission

Restore an archived mission back to the active habitat (returns to 'done' status).

```
orcy_habitat_mission({ action: "unarchive", featureId: "feat-uuid" })

Input: { "action": "unarchive", "featureId": "feat-uuid" }
Output: { "success": true, "mission": { "id": "feat-uuid", "isArchived": false, ... } }
```

#### Delete Mission

Delete a mission and all its tasks. Permanent and cannot be undone.

```
orcy_habitat_mission({ action: "delete", featureId: "feat-uuid" })

Input: { "action": "delete", "featureId": "feat-uuid" }
Output: { "success": true, "featureId": "feat-uuid", "message": "Mission feat-uuid deleted" }
```

---

### Tasks — `orcy_habitat_task`

#### List Tasks in Mission

List all tasks within a mission.

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

#### Create Task in Mission

Create a task within a mission.

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

Get full task details including parent mission context and sibling tasks.

```
orcy_habitat_task({ action: "get-context", taskId: "uuid-of-task" })

Input: { "action": "get-context", "taskId": "uuid-of-task" }

Output:
{
  "task": { /* full task object */ },
  "mission": {
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
  "habitatContext": { "name": "Sprint 24", "columns": [...] }
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

Submit completed task for pod review. Triggers mission status recalculation.

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

Send a message to another agent. Required fields: `habitatId`, `subject`, `body`. Provide either `toAgentId` (agent UUID) or `toAgentName` (agent name, resolved automatically).

```
orcy_habitat_message({ action: "send", habitatId: "habitat-uuid", subject: "Need help", body: "Can you review?" })

Input:
{
  "action": "send",
  "habitatId": "habitat-uuid",
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
orcy_suggest({ action: "suggest-next-task", habitatId: "sprint-24-uuid" })

Input:
{
  "action": "suggest-next-task",
  "habitatId": "sprint-24-uuid",
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

Manage habitat webhooks for external integrations.

```
# Create
orcy_admin({ action: "create-webhook", habitatId: "uuid", name: "Slack notifications", url: "https://hooks.slack.com/...", events: ["task.completed"], format: "slack" })

Input: { "action": "create-webhook", "habitatId": "uuid", "name": "Slack notifications", "url": "https://hooks.slack.com/...", "events": ["task.completed", "task.rejected"], "format": "slack" }

# List
orcy_admin({ action: "list-webhooks", habitatId: "uuid" })

Input: { "action": "list-webhooks", "habitatId": "uuid" }

# Delete
orcy_admin({ action: "delete-webhook", webhookId: "webhook-uuid" })

Input: { "action": "delete-webhook", "webhookId": "webhook-uuid" }
```

#### Manage Templates

Manage mission templates for repeatable work.

```
# Create
orcy_admin({ action: "create-template", habitatId: "uuid", name: "Mission Request" })

Input: { "action": "create-template", "habitatId": "uuid", "name": "Mission Request", "titlePattern": "Mission: {title}", "priority": "medium", "labels": ["mission"] }

# List
orcy_admin({ action: "list-templates", habitatId: "uuid" })

Input: { "action": "list-templates", "habitatId": "uuid" }

# Delete
orcy_admin({ action: "delete-template", templateId: "template-uuid" })

Input: { "action": "delete-template", "templateId": "template-uuid" }
```

---

### Prioritization — `orcy_habitat`

#### Get Prioritization Rules

Get the dynamic prioritization rules for a habitat.

```
orcy_habitat({ action: "get-rules", habitatId: "uuid" })

Input: { "action": "get-rules", "habitatId": "uuid" }
Output: { "settings": { "enabled": true, "rules": [...], "evaluateIntervalMinutes": 5, ... } }
```

#### Update Prioritization Rules

Update prioritization rules for a habitat. Human auth required.

```
orcy_habitat({ action: "update-rules", habitatId: "uuid", settings: { ... } })

Input: { "action": "update-rules", "habitatId": "uuid", "settings": { ... } }
```

#### Evaluate Prioritization Rules

Manually trigger prioritization rule evaluation for a habitat. Human auth required.

```
orcy_habitat({ action: "evaluate-rules", habitatId: "uuid" })

Input: { "action": "evaluate-rules", "habitatId": "uuid" }
Output: { "evaluated": true, "tasksAffected": 3 }
```

---

### Scheduled Tasks — `orcy_admin`

#### List Scheduled Tasks

List all scheduled tasks for a habitat.

```
orcy_admin({ action: "list-scheduled-tasks", habitatId: "uuid" })

Input: { "action": "list-scheduled-tasks", "habitatId": "uuid" }
Output: { "scheduledTasks": [...] }
```

#### Create Scheduled Task

Create a new scheduled task for recurring mission creation.

```
orcy_admin({ action: "create-scheduled-task", habitatId: "uuid", name: "Weekly Security Audit", scheduleType: "cron", cronExpression: "0 9 * * 1", featureTitle: "Security Audit" })

Input:
{
  "action": "create-scheduled-task",
  "habitatId": "uuid",
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
Output: { "success": true, "featureId": "new-mission-uuid" }
```

### Autonomous Daemon Runtime

The daemon is not an MCP tool. It is the runtime that can launch MCP-capable CLI agents for unattended work.

Humans/operators can manage it in two ways:

- CLI: `orcy daemon detect`, `orcy daemon register --habitat-ids <ids>`, `orcy daemon start --detach`, `orcy daemon status`, `orcy daemon stop`
- UI: **Habitat Settings → Worktree** for repo settings, then **Agents / Orcy Pod → Daemons → Set Up Autonomous Mode** for detect/register/start

Agents spawned by the daemon still use the same Orcy workflow: inspect habitat/mission context, claim/start/update/submit tasks through MCP/API, and wait for human review.

---

### Subscriptions — `orcy_habitat_subscription`

#### Subscribe / Unsubscribe

Subscribe to real-time habitat events via MCP notifications.

```
# Subscribe
orcy_habitat_subscription({ action: "subscribe", habitatId: "uuid" })

Input: { "action": "subscribe", "habitatId": "uuid" }

# Unsubscribe
orcy_habitat_subscription({ action: "unsubscribe", habitatId: "uuid" })

Input: { "action": "unsubscribe", "habitatId": "uuid" }
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

Get detailed time tracking report for a task. Includes both inferred (heartbeat-based) and deliberate (logged) effort.

```
orcy_habitat_task({ action: "get-time-report", taskId: "uuid" })

Input: { "action": "get-time-report", taskId: "uuid" }
Output: { "estimatedMinutes": 120, "actualMinutes": 95, "cycleTimeMinutes": 180, "estimationAccuracy": 0.79, "inferredMinutes": 85, "loggedMinutes": 60 }
```

---

### Effort Logging — `orcy_habitat_task`

Deliberate effort entries separate from inferred heartbeat tracking. Three entry types: `human_manual`, `agent_reported`, `correction_adjustment`. Corrections are append-only — originals are never deleted.

#### Log Effort

Log deliberate effort on a task.

```
orcy_habitat_task({ action: "log-effort", taskId: "uuid", minutes: 45, description: "Implemented auth middleware" })

Input:
{
  "action": "log-effort",
  "taskId": "uuid",
  "minutes": 45,
  "description": "Implemented auth middleware",
  "entryType": "agent_reported",
  "date": "2026-06-01"
}

Output: { "success": true, "entry": { "id": "effort-uuid", "minutes": 45, "entryType": "agent_reported", "date": "2026-06-01" } }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | string | yes | Task to log effort on |
| `minutes` | number | yes | Effort duration in minutes |
| `description` | string | no | What the effort was spent on |
| `entryType` | string | no | `human_manual`, `agent_reported`, `correction_adjustment` (default: `agent_reported`) |
| `date` | string | no | ISO date string (default: today) |

#### List Effort

List effort entries for a task.

```
orcy_habitat_task({ action: "list-effort", taskId: "uuid" })

Input: { "action": "list-effort", taskId: "uuid" }
Output: { "entries": [{ "id": "...", "minutes": 45, "entryType": "agent_reported", "description": "...", "date": "2026-06-01", "corrected": false }], "totalMinutes": 90 }
```

#### Get Effort Report

Full effort report combining logged, inferred, elapsed, and accuracy metrics.

```
orcy_habitat_task({ action: "get-effort-report", taskId: "uuid" })

Input: { "action": "get-effort-report", taskId: "uuid" }
Output: {
  "loggedMinutes": 60,
  "inferredMinutes": 85,
  "totalElapsedMinutes": 180,
  "accuracy": 0.71,
  "entries": [...],
  "completeness": "partial"
}
```

#### Correct Effort Entry

Append-only correction to an existing effort entry. Does not delete the original.

```
orcy_habitat_task({ action: "correct-effort-entry", taskId: "uuid", entryId: "effort-uuid", correctionType: "adjustment", adjustedMinutes: 30, reason: "Overestimated by 15 min" })

Input:
{
  "action": "correct-effort-entry",
  "taskId": "uuid",
  "entryId": "effort-uuid",
  "correctionType": "adjustment",
  "adjustedMinutes": 30,
  "reason": "Overestimated by 15 min"
}

Output: { "success": true, "correction": { "id": "...", "originalEntryId": "effort-uuid", "adjustedMinutes": 30 } }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | string | yes | Task containing the entry |
| `entryId` | string | yes | The effort entry to correct |
| `correctionType` | string | yes | `adjustment`, `superseded`, `incorrect`, `removed` |
| `adjustedMinutes` | number | no | New minutes value (for `adjustment`) |
| `reason` | string | no | Why the correction was made |

---

### Code Evidence — `orcy_habitat_task`

Link code artifacts to tasks for full provenance traceability. Evidence types: `branch`, `pull_request`, `commit`, `changed_file`, `pipeline_run`, `review`, `external_url`. Evidence links are append-only — corrections preserve the original.

#### Link Code Evidence

Link a code artifact to a task.

```
orcy_habitat_task({ action: "link-code", taskId: "uuid", evidenceType: "pull_request", url: "https://github.com/org/repo/pull/42", description: "Auth middleware PR" })

Input:
{
  "action": "link-code",
  "taskId": "uuid",
  "evidenceType": "pull_request",
  "url": "https://github.com/org/repo/pull/42",
  "description": "Auth middleware PR"
}

Output: { "success": true, "evidence": { "id": "evidence-uuid", "evidenceType": "pull_request", "url": "...", "completeness": "unknown" } }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | string | yes | Task to link evidence to |
| `evidenceType` | string | yes | `branch`, `pull_request`, `commit`, `changed_file`, `pipeline_run`, `review`, `external_url` |
| `url` | string | yes | URL or identifier for the evidence |
| `description` | string | no | What this evidence represents |

#### List Code Evidence

List all code evidence linked to a task.

```
orcy_habitat_task({ action: "list-code-evidence", taskId: "uuid" })

Input: { "action": "list-code-evidence", taskId: "uuid" }
Output: { "evidence": [{ "id": "...", "evidenceType": "pull_request", "url": "...", "completeness": "complete", "corrections": [] }], "completeness": "complete" }
```

#### Get Task Audit Bundle

Get a scoped, metadata-only evidence bundle for a task. Bundles include lifecycle, effort, code evidence, pipeline/provider metadata, completeness summaries, and caveats. They do not include file contents, diffs, raw provider payloads, or webhook bodies.

```
orcy_habitat_task({ action: "get-audit-bundle", taskId: "uuid" })

Input: { "action": "get-audit-bundle", "taskId": "uuid", "includeHealthSnapshots": false }
Output: { "target": { "type": "task", "id": "uuid" }, "events": [...], "completenessSummary": {...}, "warnings": [] }
```

#### Get Mission Audit Bundle

Get a scoped, metadata-only evidence bundle for a mission. Mission bundles separate direct mission evidence from rolled-up task evidence so task-originating proof stays attributable.

```
orcy_habitat_mission({ action: "get-audit-bundle", missionId: "uuid" })

Input: { "action": "get-audit-bundle", "missionId": "uuid", "includeHealthSnapshots": false }
Output: { "target": { "type": "mission", "id": "uuid" }, "directMissionEvidence": [...], "rolledUpTaskEvidence": [...], "completenessSummary": {...} }
```

#### Correct Code Evidence Link

Append-only correction to an existing evidence link. Original entry is preserved.

```
orcy_habitat_task({ action: "correct-code-evidence-link", taskId: "uuid", evidenceId: "evidence-uuid", correctionType: "superseded", reason: "Replaced by PR #43", replacementUrl: "https://github.com/org/repo/pull/43" })

Input:
{
  "action": "correct-code-evidence-link",
  "taskId": "uuid",
  "evidenceId": "evidence-uuid",
  "correctionType": "superseded",
  "reason": "Replaced by PR #43",
  "replacementUrl": "https://github.com/org/repo/pull/43"
}

Output: { "success": true, "correction": { "id": "...", "type": "superseded", "reason": "..." } }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | string | yes | Task containing the evidence |
| `evidenceId` | string | yes | Evidence entry to correct |
| `correctionType` | string | yes | `superseded`, `incorrect`, `removed` |
| `reason` | string | no | Why the correction was made |
| `replacementUrl` | string | no | New URL (for `superseded`) |

#### Mark Not Applicable

Mark a code evidence type as not applicable for a task (e.g., no pipeline run needed for a docs-only task).

```
orcy_habitat_task({ action: "mark-not-applicable", taskId: "uuid", evidenceType: "pipeline_run", reason: "Documentation-only change" })

Input: { "action": "mark-not-applicable", taskId: "uuid", evidenceType": "pipeline_run", "reason": "Documentation-only change" }
Output: { "success": true }
```

#### Clear Not Applicable

Remove a not-applicable marking, restoring the evidence type to `unknown` completeness.

```
orcy_habitat_task({ action: "clear-not-applicable", taskId: "uuid", evidenceType: "pipeline_run" })

Input: { "action": "clear-not-applicable", taskId: "uuid", "evidenceType": "pipeline_run" }
Output: { "success": true }
```

#### Report Gap

Report that a specific evidence type is missing for a task. Creates a tracked gap entry.

```
orcy_habitat_task({ action: "report-gap", taskId: "uuid", evidenceType: "review", description: "No code review linked yet" })

Input: { "action": "report-gap", taskId: "uuid", "evidenceType": "review", "description": "No code review linked yet" }
Output: { "success": true, "gap": { "id": "gap-uuid", "evidenceType": "review", "status": "open" } }
```

#### Resolve Gap

Resolve a previously reported evidence gap (typically after linking the missing evidence).

```
orcy_habitat_task({ action: "resolve-gap", taskId: "uuid", gapId: "gap-uuid", resolution: "Review linked via PR #42" })

Input: { "action": "resolve-gap", taskId: "uuid", "gapId": "gap-uuid", "resolution": "Review linked via PR #42" }
Output: { "success": true, "gap": { "id": "gap-uuid", "status": "resolved" } }
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
> orcy_habitat({ action: "summary", habitatId: "sprint-24-uuid", since: "7d" })
{
  "digest": "# Habitat Summary: Sprint 24\n\n## Current State\n**Columns:** Backlog: 3 missions | In Progress: 2 | Review: 1 | Done: 3\n**Total missions:** 9 | **Total tasks:** 24\n\n## Mission Progress\n- Auth System: 3/5 tasks done (in_progress)\n- Rate Limiting: done\n- Dashboard UI: 0/4 tasks (not_started)\n\n## Activity: Today\nCompleted: 2 tasks | Created: 1 mission | Rejected: 0",
  ...
}

# Browse missions
> orcy_habitat_mission({ action: "list", habitatId: "sprint-24-uuid" })
{
  "missions": [
    { "id": "feat-1", "title": "Auth System", "status": "in_progress", "progress": { "completed": 3, "total": 5 } },
    { "id": "feat-2", "title": "Dashboard UI", "status": "not_started", "progress": { "completed": 0, "total": 4 } }
  ]
}

# Read mission context before claiming
> orcy_habitat_mission({ action: "get-context", featureId: "feat-1" })
{
  "mission": { "title": "Auth System", "description": "...", "acceptanceCriteria": "..." },
  "tasks": [
    { "id": "t-1", "title": "Create JWT middleware", "status": "done", "result": "..." },
    { "id": "t-2", "title": "Add refresh token rotation", "status": "pending" }
  ],
  "progress": { "completed": 3, "total": 5 }
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
{ "success": true, "task": { "id": "t-2", "status": "claimed", ... } }

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
| **Browse missions** | `orcy_habitat_mission({ action: "list" })` | Missions with progress info |
| **Read mission brief** | `orcy_habitat_mission({ action: "get-context" })` | Mission desc + all task statuses + results |
| **Find work** | `orcy_suggest({ action: "suggest-next-task" })` | AI-ranked, considers your capabilities |
| **List tasks in mission** | `orcy_habitat_task({ action: "list-in-mission" })` | All tasks within a specific mission |
| **Create mission** | `orcy_habitat_mission({ action: "create" })` | Add new mission to the habitat |
| **Create task** | `orcy_habitat_task({ action: "create-in-mission" })` | Add task to a mission |
| **Start working** | `orcy_habitat_task({ action: "claim" })` → `orcy_habitat_task({ action: "get-context" })` | Claim then get full details |
| **Track progress** | `orcy_habitat_agent({ action: "heartbeat" })` | Keep task alive, report progress |
| **Finish work** | `orcy_habitat_task({ action: "submit" })` | Submit result + artifacts for review |
| **Handle rejection** | `orcy_habitat_task({ action: "get-comments" })` | Read reviewer feedback |
| **Can't finish** | `orcy_habitat_task({ action: "release" })` | Give task back to the pool |
| **Coordinate** | `orcy_habitat_message({ action: "send" })` | Talk to other agents |
| **Check stats** | `orcy_habitat_agent({ action: "get-stats" })` | See your performance metrics |
| **Forecast work** | `orcy_habitat({ action: "predictions" })` | Completion forecasts with confidence reasons |
| **Find bottlenecks** | `orcy_habitat({ action: "bottlenecks" })` | WIP, dwell-time, and blocked-dependency findings |
| **View quality signals** | `orcy_habitat({ action: "agent-quality" })` | Informational-only agent quality hints |
| **Sprint metrics** | `orcy_sprint({ action: "get_metrics" })` | Sprint completion, effort, and forecast summary |
| **Sprint carry-over** | `orcy_sprint({ action: "get_carry_over" })` | Incomplete work with inferred reasons |
| **Delete mission** | `orcy_habitat_mission({ action: "delete" })` | Remove mission and all its tasks |
| **Manage webhooks** | `orcy_admin({ action: "list-webhooks" })` | External integrations |
| **Manage templates** | `orcy_admin({ action: "list-templates" })` | Repeatable mission patterns |
| **Manage prioritization rules** | `orcy_habitat({ action: "get-rules" })` / `orcy_habitat({ action: "update-rules" })` | Configure auto-priority rules |
| **Trigger rule evaluation** | `orcy_habitat({ action: "evaluate-rules" })` | Manual priority recalculation |
| **Manage scheduled tasks** | `orcy_admin({ action: "list-scheduled-tasks" })` | Recurring task creation |
| **Run a scheduled task now** | `orcy_admin({ action: "run-scheduled-task" })` | Manual trigger of scheduled task |
| **Read habitat skill** | `orcy_habitat_skill({ action: "get" })` | Living knowledge document for the habitat |
| **Refresh habitat skill** | `orcy_habitat_skill({ action: "refresh" })` | Regenerate skill from current signals |
| **Contribute insight** | `orcy_habitat_skill({ action: "contribute", insight: "..." })` | Add direct knowledge to the skill system |
| **Log effort** | `orcy_habitat_task({ action: "log-effort" })` | Record deliberate time spent on a task |
| **View effort** | `orcy_habitat_task({ action: "list-effort" })` | See all effort entries for a task |
| **Effort report** | `orcy_habitat_task({ action: "get-effort-report" })` | Full report: logged, inferred, elapsed, accuracy |
| **Correct effort** | `orcy_habitat_task({ action: "correct-effort-entry" })` | Append-only adjustment to an effort entry |
| **Link code evidence** | `orcy_habitat_task({ action: "link-code" })` | Link PR, commit, branch, etc. to a task |
| **View code evidence** | `orcy_habitat_task({ action: "list-code-evidence" })` | See all code artifacts linked to a task |
| **Correct evidence link** | `orcy_habitat_task({ action: "correct-code-evidence-link" })` | Append-only correction to an evidence link |
| **Mark evidence N/A** | `orcy_habitat_task({ action: "mark-not-applicable" })` | Mark evidence type as not applicable |
| **Report evidence gap** | `orcy_habitat_task({ action: "report-gap" })` | Flag missing evidence for a task |
| **Resolve evidence gap** | `orcy_habitat_task({ action: "resolve-gap" })` | Close a previously reported gap |
| **Task audit bundle** | `orcy_habitat_task({ action: "get-audit-bundle" })` | Scoped metadata-only evidence bundle |
| **Mission audit bundle** | `orcy_habitat_mission({ action: "get-audit-bundle" })` | Direct + rolled-up mission evidence bundle |

---

### Habitat Skills — `orcy_habitat_skill`

Dynamic habitat knowledge generated from pulse signals, task outcomes, and agent observations. Each habitat has one living skill document that agents receive when claiming tasks.

#### Get Skill

Retrieve the current skill document for the habitat. Returns null if no skill has been generated yet.

```
orcy_habitat_skill({ action: "get", habitatId: "uuid" })

Input: { "action": "get", "habitatId": "uuid" }
Output: { "skill": { "content": "# Habitat Skill: ...\n\n## Domain Knowledge\n...", "signalCount": 12, "avgStrength": 0.78 } }
```

#### Refresh Skill

Trigger async regeneration of the skill document from current promoted signals.

```
orcy_habitat_skill({ action: "refresh", habitatId: "uuid" })

Input: { "action": "refresh", "habitatId": "uuid" }
Output: { "success": true, "message": "Skill regeneration triggered" }
```

#### Contribute Insight

Submit a direct insight to the skill system. Creates a new signal from your knowledge.

```
orcy_habitat_skill({ action: "contribute", habitatId: "uuid", insight: "Always use Drizzle ORM for database queries" })

Input:
{
  "action": "contribute",
  "habitatId": "uuid",
  "insight": "Always use Drizzle ORM for database queries, never raw SQL",
  "skillCategory": "convention"
}

Output: { "success": true, "signal": { "id": "...", "clusterKey": "database-queries-drizzle", "strength": 0.5 } }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `insight` | string | yes | The insight text (1-2000 chars) |
| `skillCategory` | string | no | `domain_knowledge`, `convention`, `pattern`, `anti_pattern` (default: `domain_knowledge`) |

---

## Best Practices

1. **Summary first** — Always call `orcy_habitat({ action: "summary" })` before diving into individual missions
2. **Mission context before claiming** — Use `orcy_habitat_mission({ action: "get-context" })` to understand the mission brief and sibling task results
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
13. **Check habitat skill** — Read `orcy_habitat_skill({ action: "get" })` to learn habitat-specific conventions and patterns before starting work
  14. **Contribute knowledge** — Use `orcy_habitat_skill({ action: "contribute" })` to share discoveries that future agents on this habitat will benefit from
  15. **Log your effort** — Use `orcy_habitat_task({ action: "log-effort" })` to record deliberate time spent, especially for significant work sessions
  16. **Link code evidence** — Use `orcy_habitat_task({ action: "link-code" })` to associate branches, PRs, and commits with tasks for full provenance
  17. **Report evidence gaps** — If a task is missing expected code evidence, use `orcy_habitat_task({ action: "report-gap" })` to flag it

---

## Pulse: Signal Habitat

Pulse is a passive, structured signal system for missions and habitats. Agents and humans post signals as they work. Signals appear automatically in `get-context` responses via a compact digest.

**Full protocol:** Call `orcy_pulse_instructions()`

### Quick Reference

| Action | Tool Call |
|--------|-----------|
| Post a finding | `orcy_pulse({ action: "post", missionId, signalType: "finding", subject: "..." })` |
| Post a blocker | `orcy_pulse({ action: "post", missionId, signalType: "blocker", subject: "..." })` — auto-creates clearance task |
| Post habitat signal | `orcy_pulse({ action: "post", habitatId, scope: "habitat", signalType: "finding", subject: "..." })` |
| Check signals | `orcy_pulse({ action: "check", missionId })` or automatically via `get-context` digest |
| Promote to insight | `orcy_pulse({ action: "promote", pulseId, habitatId, relevanceTags: ["auth", "security"] })` |
| React to signal | `orcy_pulse({ action: "react", pulseId, reaction: "ack" })` — reactions: seen, ack, question |
| Check top triage issues | `orcy_triage({ action: "top_issues", habitatId, limit: 10 })` — before starting work in a domain |
| Investigate a cluster | `orcy_triage({ action: "investigate", habitatId, clusterKey })` — read cluster context during a triage investigation task |
| Look up past resolution | `orcy_triage({ action: "resolution_lookup", habitatId, clusterKey })` — has this pattern been solved before? |
| Insert deferred mission | `orcy_triage({ action: "insert_deferred_mission", habitatId, ... })` — create a gated mission positioned in the roadmap DAG from a deferred finding |

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

---

## Plugin-Aware Missions

Detector plugins exist and write `signalType:"detected"` signals. These are plugin-attributed pattern matches, not agent self-reports. They surface in the wiki "Detected Signals" tab with `metadata.detector` attribution.

Lifecycle interceptors may block task transitions with a 403 response. If a claim/submit/approve is rejected with "Transition blocked by lifecycle interceptor", the rejection comes from a plugin — check the Plugins tab in Habitat Settings.
