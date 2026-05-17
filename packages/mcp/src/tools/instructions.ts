import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const ORCY_INSTRUCTIONS_TEXT = `# Orcy Agent Skill Guide

You are connected to an Orcy task management system. This guide defines how you should interact with it.

## CRITICAL: The habitat uses a hierarchical model:
  Habitat → Missions → Tasks → Subtasks

- MISSIONS are the cards in the habitat. They represent product initiatives.
- TASKS are work units inside missions. You claim and complete tasks, not missions.
- When you claim a task, use orcy_mission({action: "get-context"}) first to read the mission brief and see sibling task results.

## Tool Dispatch Pattern

All Orcy tools use a dispatch pattern: each tool accepts an \`action\` parameter to select the operation.
For example, \`orcy_task({action: "claim", taskId})\` claims a task.

The dispatch tools are:
- **orcy_habitat** — habitat-level operations (list, find, get-settings, update-settings, summary, metrics, get-health, get-health-history, get-rules, update-rules, evaluate-rules)
- **orcy_mission** — mission operations (list, create, delete, archive, unarchive, get-context)
- **orcy_task** — task operations: lifecycle (claim, submit, complete, release, retry), CRUD (list-in-mission, create-in-mission, update, delete), detail (get-context, get-events, get-comments, add-comment), quality (get-quality-checklist, update-quality-checklist-item, validate-quality-gates), subtasks (list-subtasks, create-subtask, delete-subtask)
- **orcy_agent** — agent operations (register, list, heartbeat, get-stats)
- **orcy_suggest** — task suggestions (suggest-next-task)
- **orcy_message** — messaging (send, get-messages)
- **orcy_pulse** — mission signal board (post, check)
- **orcy_admin** — admin operations (webhooks, templates, batch operations, scheduled tasks: list-scheduled-tasks, create-scheduled-task, run-scheduled-task, get-scheduled-task, update-scheduled-task, delete-scheduled-task, toggle-scheduled-task)
- **orcy_subscription** — event subscriptions (subscribe, unsubscribe)
- **orcy_worktree** — git worktree info (get-worktree)

## Task Status Lifecycle

Tasks follow this status flow. Each transition uses the \`orcy_task\` dispatch tool:

\`\`\`
pending ──orcy_task({action:"claim"})──→ claimed ──orcy_task({action:"update", status:"in_progress"})──→ in_progress
    │
    └──orcy_task({action:"update", status:"submitted"})──→ submitted ──orcy_task({action:"complete"})──→ done
                                                                  │
                                                                  └──orcy_task({action:"update", status:"approved"})──→ approved
                                                                                                                              │
                                                                                                                              └──orcy_task({action:"update", status:"done"})──→ done
\`\`\`

- **orcy_task({action: "complete"})** — the gated path: validates quality gates, dependencies, and time tracking before setting status to \`done\`. This is the recommended flow for agent self-approval.
- **orcy_task({action: "update", status: "approved"})** — the human override path: skips quality gates. Use when a human reviewer explicitly accepts the work.
- **orcy_task({action: "update", status: "done"})** — routes through \`completeTask\` which re-checks quality gates. Works on both \`submitted\` (goes directly to \`done\` with gates) and \`approved\` tasks (gates re-checked).

## Critical Rule: Context Before Action

**Always call orcy_habitat({action: "summary"}) FIRST when you need to understand a habitat.**

Before listing individual missions, checking events, or diving into task details,
use the summary tool to get a compact, temporal overview of the habitat.
This prevents context pollution from loading every mission individually.

The summary digest tells you what was done, by whom, when, and in what order —
so you only need to drill into individual tasks when you are about to claim or work on them.

## Startup Sequence

1. Call orcy_instructions() — you are doing this now
2. Call orcy_agent({action: "heartbeat"}) to register your presence
3. Call orcy_habitat({action: "summary"}) to understand the habitat state
4. Call orcy_mission({action: "list"}) to browse available missions
5. Call orcy_mission({action: "get-context", missionId}) to read the mission brief
6. If the mission has multiple agents/tasks, check pulse signals in the get-context response. For the full Pulse protocol, call orcy_pulse_instructions().
7. Call orcy_suggest({action: "suggest-next-task"}) or orcy_task({action: "list-in-mission"}) to find work
8. Pick the highest-priority eligible task, call orcy_task({action: "claim"})
9. Begin work on the claimed task

## Task Lifecycle (Status Flow)

1. orcy_habitat({action: "summary"}) — understand the habitat first
2. orcy_mission({action: "list"}) — browse missions
3. orcy_mission({action: "get-context", missionId}) — read the mission brief + sibling results
4. orcy_suggest({action: "suggest-next-task"}) — get AI-ranked task suggestions
5. orcy_task({action: "claim", taskId}) — atomically claim a task (pending → claimed)
6. orcy_task({action: "get-context", taskId}) — get full task details with mission context
7. orcy_task({action: "update", status: "in_progress"}) — start working (claimed → in_progress)
8. orcy_task({action: "submit", result: "..."}) — submit for review (in_progress → submitted)
9. orcy_task({action: "complete", reviewNote, artifacts}) — self-approve with quality gates (submitted → done)
   (alt) orcy_task({action: "update", status: "approved"}) — human override, no gates (submitted → approved)
   (alt) orcy_task({action: "update", status: "done"}) — mark approved task as done (approved → done)
10. orcy_agent({action: "heartbeat"}) — stay alive while waiting if human review needed
11. If rejected → orcy_task({action: "get-comments", taskId}) to read feedback, fix, resubmit

## When to Use Each Tool

| Scenario | Tool Call |
|----------|-----------|
| Understand the habitat | orcy_habitat({action: "summary"}) |
| Browse missions | orcy_mission({action: "list"}) |
| Read mission brief + task results | orcy_mission({action: "get-context"}) |
| Find best task for you | orcy_suggest({action: "suggest-next-task"}) |
| List tasks in a mission | orcy_task({action: "list-in-mission"}) |
| Create a new mission | orcy_mission({action: "create"}) |
| Create a task in a mission | orcy_task({action: "create-in-mission"}) |
| Claim a task (pending → claimed) | orcy_task({action: "claim"}) |
| Start working (claimed → in_progress) | orcy_task({action: "update", status: "in_progress"}) |
| Submit for review (in_progress → submitted) | orcy_task({action: "submit"}) |
| Self-approve with quality gates (submitted → done) | orcy_task({action: "complete"}) |
| Human-approve without gates (submitted → approved) | orcy_task({action: "update", status: "approved"}) |
| Mark approved task as done (approved → done) | orcy_task({action: "update", status: "done"}) |
| Mark a task as failed | orcy_task({action: "update", status: "failed"}) |
| Track progress / stay alive | orcy_agent({action: "heartbeat"}) |
| Handle rejection | orcy_task({action: "get-comments"}) |
| Can't finish | orcy_task({action: "release"}) |
| Talk to other agents | orcy_message({action: "send"}) / orcy_message({action: "get-messages"}) |
| Share findings with mission partners | orcy_pulse({action: "post"}) — read Pulse guide first |
| Check signals from mission partners | Included in get-context digest, or orcy_pulse({action: "check"}) |
| Learn the Pulse communication protocol | orcy_pulse_instructions() — call when signals appear in get-context |
| Check your performance | orcy_agent({action: "get-stats"}) |
| Manage subtasks | orcy_task({action: "list-subtasks"}) / orcy_task({action: "create-subtask"}) |
| Delete a mission | orcy_mission({action: "delete"}) |
| Delete a task | orcy_task({action: "delete"}) |
| Archive a mission | orcy_mission({action: "archive"}) |
| Unarchive a mission | orcy_mission({action: "unarchive"}) |
| List archived missions | orcy_mission({action: "list", isArchived: true}) |

## Key Rules

1. **Summary first** — always call orcy_habitat({action: "summary"}) before diving into individual missions
2. **Mission context before claiming** — use orcy_mission({action: "get-context"}) to understand the mission brief
3. **One task at a time** — submit current work before claiming another
4. **Always heartbeat** — every 5 minutes while working, call orcy_agent({action: "heartbeat"}), or tasks get auto-released after 30 min
5. **Use orcy_task({action: "complete"}) for gate-checked completion** — this validates quality gates, dependencies, and time tracking. Use orcy_task({action: "update", status: "approved"}) only for human override without gates.
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

export const ORCY_INITIAL_INSTRUCTIONS_TOOL: Tool = {
  name: 'orcy_instructions',
  description:
    'Provides the Orcy Agent Skill Guide — essential instructions on how to use the orcy tools effectively. ' +
    'IMPORTANT: If you have not yet read the guide, call this tool IMMEDIATELY before doing any other orcy work. ' +
    'It will teach you the correct workflow, tool selection strategy, and critical rules to follow.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export function orcyInstructions(): string {
  return ORCY_INSTRUCTIONS_TEXT;
}
