# Recovery Tasks as Normal Tasks (Not a New Entity Type)

Status: accepted · 2026-06-20

## Context

v0.20 introduces an error-handling subsystem for workflows. When a task fails (`failed`/`rejected`/heartbeat-lost), the workflow can spawn a recovery task to diagnose and redeem the failure. The design question was: **is a recovery task a new entity type with its own table, lifecycle, and claim semantics, or is it just a regular task gated by `on_fail`?**

## Decision

**Recovery tasks are normal tasks. They live in the existing `tasks` table, follow the existing lifecycle (`pending → claimed → in_progress → submitted → approved/rejected → done/failed`), and are claimed through the existing pipeline. A recovery task is distinguished from a regular task only by: (a) the upstream `on_fail` gate that spawned it, (b) the `failureContexts.recoveryTaskId` linkage, and (c) the `recoveryDepth` counter on the gate.**

No new table for recovery tasks. No new task type. No new lifecycle. No new claim path.

## Rationale

- **The agent doesn't know it's a recovery task.** From the agent's perspective, it claims a task, reads the description (which includes failure context via the `orcy_get_failure_context` MCP tool), does the work, and submits. The claim path is identical. Forcing a parallel "recovery claim" path would duplicate `IClaimStrategy`, `runPollTick`, `getSuggestionsForAgent`, and every per-status branch.
- **Recovery needs all of task's existing machinery:** assignee selectors (`requiredDomain`, `requiredCapabilities`), audit trail, evidence linking, effort logging, reviewer assignment, retry policy. Building a parallel entity would mean duplicating or re-using all of this — reusing is simpler.
- **Recovery is itself fallible.** A recovery task can fail, triggering deeper recovery. This recursion is clean if recovery tasks ARE tasks — the depth-2 limit just checks `taskWorkflowGates.recoveryDepth`. If recovery were a separate entity, we'd need a parallel recovery-of-recovery concept.
- **No new spawning machinery.** Existing `SessionManager.startSession` and the existing task-creation path handle everything. The workflow service just calls `createTask()` with the recovery task template, then creates an `on_fail` gate.
- **Aligns with the broader v0.20 principle:** layered constraints on the existing model, not mode switches or parallel entities.

## Alternatives considered

- **New `recoveryTasks` table with its own lifecycle.** Rejected — duplicates task machinery, breaks recursion, forces parallel claim path.
- **New `recovery` task status within the existing tasks table.** Rejected — `recovery` isn't a lifecycle state, it's a role. A recovery task goes through the normal `pending → claimed → ... → done` flow.
- **Recovery as an agent capability, not a task.** Rejected — doesn't capture the work being done; doesn't produce audit/lifecycle history.
- **Recovery via existing `retryPolicy` mechanism only.** Rejected — `retryPolicy` is blind re-execution of the same task. Recovery is diagnostic work with failure context. Different primitives, complementary not replacement.

## Consequences

- `tasks` table unchanged. Recovery tasks are inserted via existing `createTask`.
- `taskWorkflowGates.recoveryTaskId` and `taskWorkflowGates.recoveryDepth` (authoritative) track recovery chain linkage.
- `failureContexts.recoveryTaskId` links failure to its recovery task. `failureContexts.recoveryDepth` is denormalized for query convenience (with documented comment that the gate is authoritative).
- Recovery agents are configured (by humans) as normal agents with capabilities like `debugging`, `recovery`. Workflow authors target them via `failureHandler.agentSelector.requiredCapabilities` or `failureHandler.agentSelector.assignedAgentId`.
- **`excludeFailedAgent` dropped from v0.20** — no implementation path without adding a column to `tasks` (violates ADR-0001's "no new task columns" principle). Recovery handlers use `assignedAgentId` for specific targeting or `requiredCapabilities`/`requiredDomain` for capability-based selection. May revisit in a future release if exclusion becomes a real need.
- Redemption semantics: when recovery task transitions to `approved` or `completed`, `workflowService` scans the original failed task's downstream `on_complete`/`on_approve` gates and sets `satisfied = true`. The failed task stays failed in history; redemption is forward-flowing.
- **Two recovery attempts maximum.** `recoveryDepth` starts at 0 for original gates, 1 for recovery-task gates, 2 for recovery-of-recovery. Attempts to spawn at depth >2 are rejected and emit `workflow_recovery_unrecoverable` audit event + notification. (Reworded from earlier "depth-2 limit" framing to remove ambiguity.)
