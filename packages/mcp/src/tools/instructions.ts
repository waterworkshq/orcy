import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Multi-line Markdown skill guide embedded as an MCP tool response. */
export const ORCY_INSTRUCTIONS_TEXT = `# Orcy Agent Skill Guide

You are connected to an Orcy task management system. This guide defines how you should interact with it.

## CRITICAL: The habitat uses a hierarchical model:
  Habitat → Missions → Tasks → Subtasks

- MISSIONS are the cards in the habitat. They represent product initiatives.
- TASKS are work units inside missions. You claim and complete tasks, not missions.
- When you claim a task, use orcy_habitat_mission({action: "get-context"}) first to read the mission brief and see sibling task results.

## Tool Dispatch Pattern

All Orcy tools use a dispatch pattern: each tool accepts an \`action\` parameter to select the operation.
For example, \`orcy_habitat_task({action: "claim", taskId})\` claims a task.

The dispatch tools are:
- **orcy_habitat** — habitat-level operations (list, find, get-settings, summary, metrics, get-health, get-health-history, predictions, bottlenecks, agent-quality, get-rules, update-rules, evaluate-rules)
- **orcy_habitat_mission** — mission operations (list, create, delete, archive, unarchive, get-context)
- **orcy_habitat_task** — task operations: lifecycle (claim, start, submit, complete, approve, reject, release, retry, fail), batch operations (batch-assign, batch-set-priority, batch-delete), CRUD (list-in-mission, create-in-mission, update, delete), detail (get-context, get-events, get-comments, add-comment), quality (get-quality-checklist, update-quality-checklist-item, validate-quality-gates), subtasks (list-subtasks, create-subtask, delete-subtask)
- **orcy_habitat_agent** — agent operations (register, list, heartbeat, get-stats)
- **orcy_suggest** — task suggestions (suggest-next-task)
- **orcy_habitat_message** — messaging (send, get-messages)
- **orcy_pulse** — mission signal board (post, check)
- **orcy_habitat_subscription** — event subscriptions (subscribe, unsubscribe)
- **orcy_worktree** — git worktree info (get-worktree)
- **orcy_habitat_skill** — habitat knowledge (get, refresh, contribute) — read accumulated conventions, patterns, pitfalls before starting work
- **orcy_learning** — read-only contextual knowledge from accepted Learning Loop findings (list_accepted, get) — requires your active taskId; returns bounded summaries scoped to your task context only

## Task Status Lifecycle

Tasks follow this status flow. Each transition uses the \`orcy_habitat_task\` dispatch tool:

\`\`\`
pending ──────────────── orcy_habitat_task({action:"claim", taskId}) ──→ claimed
claimed ──────────────── orcy_habitat_task({action:"start", taskId, executionToken}) ──→ in_progress
in_progress ──────────── orcy_habitat_task({action:"submit", taskId, result, executionToken}) ──→ submitted
in_progress ─────────── orcy_habitat_task({action:"fail", taskId, failureReason, executionToken}) ──→ failed
in_progress / claimed ── orcy_habitat_task({action:"release", taskId, reason, executionToken}) ──→ pending
submitted ────────────── orcy_habitat_task({action:"complete", taskId}) ──→ done        (quality gates checked)
submitted ────────────── orcy_habitat_task({action:"approve", taskId}) ──→ submitted or approved  (approval finalizes only when review requirements are satisfied; no token)
submitted ────────────── orcy_habitat_task({action:"reject", taskId, reason}) ──→ rejected (assigned reviewer, no token)
failed ───────────────── orcy_habitat_task({action:"retry", taskId}) ──→ pending         (then claim again)
\`\`\`

- **Execution token (epoch fence):** the claim response supplies \`task.executionToken\`. Capture it and present it on \`start\`, \`submit\`, \`release\`, and \`fail\` (and on \`update\` status transitions to in_progress/submitted/failed) — a wrong or missing token on tokened tasks returns 409 \`EPOCH_MISMATCH\`. Never fetch a fresh token with a task GET: after a rejected rework, \`start\` returns the newer token in its own response — capture it there. Legacy pre-token tasks accept mutations without one.
- **orcy_habitat_task({action: "complete", taskId})** — the gated path: validates quality gates, dependencies, and time tracking before setting status to \`done\`. This is the recommended flow for agent self-approval.
- **orcy_habitat_task approve / reject actions** — the review-decision path: an admitted human or pending agent-typed reviewer row approves or rejects a submitted task (identity from the authenticated caller; no executionToken required; normal authentication and reviewer authorization still apply). Approve skips quality gates; a \`reason\` is required to reject. With several required reviewers, an approval can leave the task \`submitted\` until the last one decides.
- **orcy_habitat_task({action: "update", taskId, status: "approved"})** — an alias for the same review-approval endpoint under the same reviewer authorization — never an unrestricted human override.
- **orcy_habitat_task({action: "update", taskId, status: "done"})** — routes through \`completeTask\` which re-checks quality gates. Works on both \`submitted\` (goes directly to \`done\` with gates) and \`approved\` tasks (gates re-checked).
- **orcy_habitat_task({action: "fail", taskId, failureReason, executionToken})** — mark owned work failed; the required field is \`failureReason\` (not \`reason\`).
- **orcy_habitat_task({action: "retry", taskId})** — a separate failed → pending reset so the task can be claimed again; it is not an approval and not a substitute for \`complete\`.

## Critical Rule: Context Before Action

**Always call orcy_habitat({action: "summary"}) FIRST when you need to understand a habitat.**

Before listing individual missions, checking events, or diving into task details,
use the summary tool to get a compact, temporal overview of the habitat.
This prevents context pollution from loading every mission individually.

The summary digest tells you what was done, by whom, when, and in what order —
so you only need to drill into individual tasks when you are about to claim or work on them.

## Startup Sequence

1. Call orcy_instructions() — you are doing this now
2. Call orcy_habitat_agent({action: "heartbeat"}) to register your presence
3. Call orcy_habitat({action: "summary"}) to understand the habitat state
4. Call orcy_habitat_mission({action: "list"}) to browse available missions
5. Call orcy_habitat_mission({action: "get-context", missionId}) to read the mission brief
5.5. Call orcy_habitat_skill({action: "get"}) to read accumulated habitat knowledge (conventions, patterns, pitfalls) before starting work
6. If the mission has multiple agents/tasks, check pulse signals in the get-context response. For the full Pulse protocol, call orcy_pulse_instructions().
7. Call orcy_suggest({action: "suggest-next-task"}) or orcy_habitat_task({action: "list-in-mission"}) to find work
8. Pick the highest-priority eligible task, call orcy_habitat_task({action: "claim", taskId})
9. Begin work on the claimed task

## Task Lifecycle (Status Flow)

1. orcy_habitat({action: "summary"}) — understand the habitat first
2. orcy_habitat_mission({action: "list"}) — browse missions
3. orcy_habitat_mission({action: "get-context", missionId}) — read the mission brief + sibling results
4. orcy_suggest({action: "suggest-next-task"}) — get AI-ranked task suggestions
5. orcy_habitat_task({action: "claim", taskId}) — atomically claim a task (pending → claimed); capture task.executionToken from the claim response
6. orcy_habitat_task({action: "get-context", taskId}) — get full task details with mission context
7. orcy_habitat_task({action: "start", taskId, executionToken}) — begin work (claimed → in_progress); a rejected task restarts the same way, and that start response returns the fresh rework token — capture it
8. orcy_habitat_task({action: "submit", taskId, result, executionToken}) — submit for review (in_progress → submitted)
9. orcy_habitat_task({action: "complete", taskId, reviewNote, artifacts}) — self-approve with quality gates (submitted → done)
   (alt) orcy_habitat_task({action: "approve", taskId}) / orcy_habitat_task({action: "reject", taskId, reason}) — assigned-reviewer decision on submitted work (no token); orcy_habitat_task({action: "update", taskId, status: "approved"}) is an alias under the same reviewer authorization
   (alt) orcy_habitat_task({action: "update", taskId, status: "done"}) — gate-checked completion alias (submitted/approved → done)
10. orcy_habitat_agent({action: "heartbeat"}) — stay alive while waiting if review is needed
11. If rejected → orcy_habitat_task({action: "get-comments", taskId}) to read feedback, then restart with orcy_habitat_task({action: "start", taskId, executionToken: X}) — the rework start mints a fresh token Y in its response — fix and resubmit with Y

## When to Use Each Tool

| Scenario | Tool Call |
|----------|-----------|
| Understand the habitat | orcy_habitat({action: "summary"}) |
| Browse missions | orcy_habitat_mission({action: "list"}) |
| Read mission brief + task results | orcy_habitat_mission({action: "get-context"}) |
| Find best task for you | orcy_suggest({action: "suggest-next-task"}) |
| List tasks in a mission | orcy_habitat_task({action: "list-in-mission"}) |
| Create a new mission | orcy_habitat_mission({action: "create"}) |
| Create a task in a mission | orcy_habitat_task({action: "create-in-mission"}) |
| Claim a task (pending → claimed) | orcy_habitat_task({action: "claim", taskId}) |
| Start working (claimed → in_progress; token required) | orcy_habitat_task({action: "start", taskId, executionToken}) |
| Submit for review (in_progress → submitted; token + result required) | orcy_habitat_task({action: "submit", taskId, result, executionToken}) |
| Self-approve with quality gates (submitted → done) | orcy_habitat_task({action: "complete", taskId}) |
| Reviewer approves submitted work (no token) | orcy_habitat_task({action: "approve", taskId}) |
| Reviewer rejects submitted work (reason required, no token) | orcy_habitat_task({action: "reject", taskId, reason}) |
| Gate-checked completion alias (submitted/approved → done) | orcy_habitat_task({action: "update", taskId, status: "done"}) |
| Mark a task as failed (failureReason + token required) | orcy_habitat_task({action: "fail", taskId, failureReason, executionToken}) |
| Reset a failed task to pending (failed → pending) | orcy_habitat_task({action: "retry", taskId}) |
| Track progress / stay alive | orcy_habitat_agent({action: "heartbeat"}) |
| Handle rejection | orcy_habitat_task({action: "get-comments", taskId}) then start with your preserved token (capture the fresh one from the start response) |
| Can't finish | orcy_habitat_task({action: "release", taskId, reason, executionToken}) |
| Talk to other agents | orcy_habitat_message({action: "send"}) / orcy_habitat_message({action: "get-messages"}) |
| Share findings with mission partners | orcy_pulse({action: "post"}) — read Pulse guide first |
| Check signals from mission partners | Included in get-context digest, or orcy_pulse({action: "check"}) |
| Learn the Pulse communication protocol | orcy_pulse_instructions() — call when signals appear in get-context |
| Check your performance | orcy_habitat_agent({action: "get-stats"}) |
| Manage subtasks | orcy_habitat_task({action: "list-subtasks", taskId}) / orcy_habitat_task({action: "create-subtask", taskId, title}) |
| Delete a mission | orcy_habitat_mission({action: "delete"}) |
| Delete a task | orcy_habitat_task({action: "delete", taskId}) |
| Archive a mission | orcy_habitat_mission({action: "archive"}) |
| Unarchive a mission | orcy_habitat_mission({action: "unarchive"}) |
| List archived missions | orcy_habitat_mission({action: "list", isArchived: true}) |

## Key Rules

1. **Summary first** — always call orcy_habitat({action: "summary"}) before diving into individual missions
2. **Mission context before claiming** — use orcy_habitat_mission({action: "get-context"}) to understand the mission brief
3. **One task at a time** — submit current work before claiming another
4. **Always heartbeat** — every 5 minutes while working, call orcy_habitat_agent({action: "heartbeat"}), or tasks get auto-released after 30 min
5. **Use dedicated lifecycle actions** — orcy_habitat_task({action: "start", taskId, executionToken}) to begin work, {action: "submit", taskId, result, executionToken} to submit, {action: "complete", taskId} for gate-checked completion, {action: "fail", taskId, failureReason, executionToken} to fail, {action: "release", taskId, reason, executionToken} to release. \`update\` status values are aliases for the same endpoints under the same authorization ({action: "update", taskId, status: "approved"} routes to the canonical approve endpoint — it is not an unrestricted human override); keep status and metadata edits in separate \`update\` calls.
6. **Submit artifacts** — always link a PR, commit, or file with your submission
7. **Write clear results** — the human reviewer needs to understand what you did
8. **Respect domain** — only claim tasks matching your registered domain
9. **Handle rejection gracefully** — read comments, fix, resubmit
10. **Check dependencies** — missions with unmet deps won't appear in listings
11. **Check pulse signals** — when working on a mission with partners, read the pulse digest in get-context and post signals about discoveries and blockers

## Claiming Rules

- Only one agent can hold a task at a time (atomic claim)
- Tasks are priority-ordered: critical > high > medium > low
- Domain and capability mismatches will cause claim rejection
- Stale tasks (no heartbeat for 30 min) are auto-released

## Artifact Types for Submissions

| Type | When to Use |
|------|-------------|
| pr | Pull request URL |
| commit | Direct commit link |
| file | Modified file link |
| screenshot | Visual evidence |
| log | Build output, test results |

You have hereby read the Orcy Agent Skill Guide and do not need to call orcy_instructions again.`;

/** MCP tool descriptor for the `orcy_instructions` startup tool. */
export const ORCY_INITIAL_INSTRUCTIONS_TOOL: Tool = {
  name: "orcy_instructions",
  description:
    "Provides the Orcy Agent Skill Guide — essential instructions on how to use the orcy tools effectively. " +
    "IMPORTANT: If you have not yet read the guide, call this tool IMMEDIATELY before doing any other orcy work. " +
    "It will teach you the correct workflow, tool selection strategy, and critical rules to follow.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/** Tool handler that returns the rendered {@link ORCY_INSTRUCTIONS_TEXT}. */
export function orcyInstructions(): string {
  return ORCY_INSTRUCTIONS_TEXT;
}
