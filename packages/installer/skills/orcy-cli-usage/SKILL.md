---
name: orcy-cli-usage
description: Reference for the orcy CLI — serve daemon, habitat, mission, task, agent, message, admin, and troubleshooting commands
license: MIT
---

# Orcy CLI Usage

This skill covers driving Orcy from the **shell** using the `orcy` CLI. The CLI communicates with the API server via HTTP.

---

## Daemon Control

### orcy serve start

Start the API server. Blocks the terminal by default. Use `--detach` to run in background.

```bash
# Start on default port 3000
orcy serve start

# Start on custom port
orcy serve start --port 4000 --host 0.0.0.0

# Start in background
orcy serve start --detach

# Start detached and open browser
orcy serve start --detach --open
```

### orcy serve stop

Stop a detached server.

```bash
orcy serve stop
```

### orcy serve status

Check if the server is running.

```bash
orcy serve status
# API is running (pid 12345)
```

---

## Habitat Commands

### List Habitats

```bash
orcy habitat list
```

### Find Habitat

```bash
orcy habitat find "sprint"
```

### Get Habitat Settings

```bash
orcy habitat get-settings <habitatId>
```

### Update Habitat Settings

```bash
orcy habitat update-settings <habitatId> --name "Sprint 25" --description "Updated"
```

### Habitat Summary

Get a temporal digest of habitat activity.

```bash
orcy habitat summary <habitatId>
orcy habitat summary <habitatId> --since 24h
orcy habitat summary <habitatId> --since 30d --max-tasks 10
orcy habitat summary <habitatId> --no-digest
```

### Habitat Metrics

```bash
orcy habitat metrics <habitatId>
```

---

## Mission Commands

### List Missions

```bash
orcy mission list <habitatId>
orcy mission list <habitatId> --status in_progress
orcy mission list <habitatId> --priority high --limit 10
orcy mission list <habitatId> --is-archived
```

### Create Mission

```bash
orcy mission create <habitatId> "User Authentication" \
  --description "JWT-based auth" \
  --acceptance-criteria "Users can sign in" \
  --priority high \
  --labels "security,auth" \
  --depends-on "mission-uuid-1,mission-uuid-2" \
  --due-at "2025-06-01T00:00:00Z" \
  --sla-minutes 1440
```

### Get Mission Context

```bash
orcy mission get-context <missionId>
```

### Archive Mission

```bash
orcy mission archive <missionId>
```

### Unarchive Mission

```bash
orcy mission unarchive <missionId>
```

### Delete Mission

```bash
orcy mission delete <missionId>
```

---

## Task Commands

### List Tasks in Mission

```bash
orcy task list-in-mission <missionId>
```

### Create Task

```bash
orcy task create-in-mission <missionId> "Add login endpoint" \
  --description "POST /api/login" \
  --priority high \
  --domain backend \
  --capabilities "typescript,postgresql" \
  --estimated-minutes 120
```

### Claim Task

Atomically lock a task for yourself.

```bash
orcy task claim <taskId>
# Success: { "success": true, "task": { "status": "claimed", ... } }
# Failure: { "success": false, "reason": "already_claimed" }
```

### Start Working

Transition from claimed to in_progress.

```bash
orcy task start <taskId>
```

### Get Task Context

```bash
orcy task get-context <taskId>
```

### Update Task

```bash
orcy task update <taskId> --title "Updated title" --priority critical
orcy task update <taskId> --description "New description" --version 3
```

### Submit Task

Submit for review with result and optional artifact.

```bash
orcy task submit <taskId> --result "Implemented login endpoint"
orcy task submit <taskId> \
  --result "Fixed redirect bug" \
  --artifact-type pr \
  --artifact-url "https://github.com/org/repo/pull/42" \
  --artifact-desc "Fix login redirect"
```

### Complete Task (Self-Approval)

Self-approve with quality gate enforcement. Task must be in `submitted` status.

```bash
orcy task complete <taskId> --review-note "All tests pass"
orcy task complete <taskId> \
  --review-note "LGTM" \
  --artifact-type pr \
  --artifact-url "https://github.com/org/repo/pull/43"
```

### Release Task

```bash
orcy task release <taskId> --reason "blocked_by_dependency"
orcy task release <taskId> --reason "out_of_scope"
```

### Retry Task

```bash
orcy task retry <taskId>
```

### Fail Task

```bash
orcy task fail <taskId> "Could not reproduce the bug"
```

### Delete Task

```bash
orcy task delete <taskId>
```

---

## Task History & Communication

### Get Events

```bash
orcy task get-events <taskId>
orcy task get-events <taskId> --limit 50 --offset 0
```

### Get Comments

```bash
orcy task get-comments <taskId>
orcy task get-comments <taskId> --limit 100
```

### Add Comment

```bash
orcy task add-comment <taskId> "Working on edge case tests now"
orcy task add-comment <taskId> "Thanks for the feedback" --parent-id <commentUuid>
```

---

## Subtasks

### List Subtasks

```bash
orcy task list-subtasks <taskId>
```

### Create Subtask

```bash
orcy task create-subtask <taskId> "Write unit tests"
orcy task create-subtask <taskId> "API integration test" --assignee-id <agentUuid>
```

### Delete Subtask

```bash
orcy task delete-subtask <taskId> <subtaskId>
```

---

## Quality Gates & Dependencies

### Get Quality Checklist

```bash
orcy task get-quality-checklist <taskId>
```

### Update Checklist Item

```bash
orcy task update-quality-checklist-item <taskId> <checklistId> <itemId> \
  --is-completed \
  --evidence-url "https://github.com/org/repo/actions/runs/123" \
  --notes "All 15 unit tests pass"
```

### Validate Quality Gates

```bash
orcy task validate-quality-gates <taskId>
```

### Get Approval Status

```bash
orcy task get-approval-status <taskId>
```

### Get Blocked Status

```bash
orcy task get-blocked-status <taskId>
```

### Add Dependency

```bash
orcy task add-dependency <taskId> <dependsOnTaskId>
```

### Remove Dependency

```bash
orcy task remove-dependency <taskId> <dependencyTaskId>
```

### Get Time Report

```bash
orcy task get-time-report <taskId>
```

---

## Agent Commands

### Register Agent

```bash
orcy agent register "coding-agent-1" claude-code backend \
  --capabilities "typescript,postgresql,docker"
```

### List Agents

```bash
orcy agent list
orcy agent list --status working
orcy agent list --domain backend
```

### Heartbeat

Keeps your claimed task from being marked stale (auto-released after 30 min idle).

```bash
orcy agent heartbeat --task-id <taskId> --progress "Halfway through"
orcy agent heartbeat --task-id <taskId>
orcy agent heartbeat
```

### Get Stats

```bash
orcy agent get-stats
```

---

## Message Commands

### Send Message

```bash
orcy message send <habitatId> "Need help" "Can you review my PR?" \
  --to-agent-name "coding-agent-2" \
  --message-type request \
  --priority high

orcy message send <habitatId> "Bug found" "auth.ts line 42 has null ref" \
  --to-agent-id <agentUuid> \
  --task-id <taskUuid>
```

### Get Messages

```bash
orcy message get-messages
orcy message get-messages --unread-only
orcy message get-messages --task-id <taskUuid>
```

---

## Suggestions

### Suggest Next Task

Get AI-ranked task recommendations based on priority, urgency, your capabilities, and workload.

```bash
orcy suggest suggest-next-task <habitatId>
orcy suggest suggest-next-task <habitatId> --limit 3
```

---

## Subscriptions

```bash
orcy subscription subscribe <habitatId>
orcy subscription unsubscribe <habitatId>
```

---

## Worktrees

```bash
orcy worktree get-worktree <taskId>
```

---

## Admin Commands

### Webhooks

```bash
# List
orcy admin list-webhooks <habitatId>

# Create
orcy admin create-webhook <habitatId> "Slack notifications" "https://hooks.slack.com/..." \
  --events "task.created,task.completed" \
  --format slack

# Delete
orcy admin delete-webhook <webhookId>
```

### Templates

```bash
# List
orcy admin list-templates <habitatId>

# Create
orcy admin create-template <habitatId> "Bug Fix" \
  --title-pattern "Fix: {title}" \
  --priority high \
  --labels "bug" \
  --domain backend

# Delete
orcy admin delete-template <templateId>
```

### Batch Operations

```bash
# Batch assign tasks to an agent
orcy admin batch-assign-tasks <habitatId> "task-uuid-1,task-uuid-2,task-uuid-3" <agentId>

# Batch set priority
orcy admin batch-set-priority <habitatId> "task-uuid-1,task-uuid-2" critical

# Batch delete tasks
orcy admin batch-delete-tasks <habitatId> "task-uuid-1,task-uuid-2"
```

---

## Full Lifecycle Example

```bash
# 1. Start the server
orcy serve start --detach

# 2. List habitats and pick one
orcy habitat list
orcy habitat find "sprint"

# 3. Understand the habitat
orcy habitat summary <habitatId> --since 7d

# 4. Browse missions
orcy mission list <habitatId>

# 5. Read a mission brief
orcy mission get-context <missionId>

# 6. Get a suggestion
orcy suggest suggest-next-task <habitatId>

# 7. Claim a task
orcy task claim <taskId>

# 8. Get full context
orcy task get-context <taskId>

# 9. Start working
orcy task start <taskId>

# 10. Heartbeat while working
orcy agent heartbeat --task-id <taskId> --progress "Implementing..."

# 11. Submit
orcy task submit <taskId> \
  --result "Done" \
  --artifact-type pr \
  --artifact-url "https://github.com/org/repo/pull/42"

# 12. Self-approve (gated)
orcy task complete <taskId> --review-note "All checks pass"
```

---

## Troubleshooting

### orcy-install doctor

The installer includes a `doctor` command that checks your environment and reports issues:

```bash
orcy-install doctor
```

It checks:
- API server is reachable (ORCY_API_URL)
- Habitat UUID is valid
- Agent is registered (ORCY_AGENT_ID)
- API key is valid
- Required environment variables are set
- MCP configuration files are correct (if installed)

### Common Errors

```
# Server not running
> orcy habitat list
Error: connect ECONNREFUSED ::1:3000
Solution: orcy serve start --detach

# Not authenticated
Error: 401 Unauthorized
Solution: Set ORCY_API_KEY in .env

# Agent not registered
Error: 404 Agent not found
Solution: orcy agent register "my-agent" opencode frontend

# Claim failed
{ "success": false, "reason": "already_claimed" }
Solution: Find another task via orcy suggest suggest-next-task <habitatId>
```
