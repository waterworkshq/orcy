# Workflow Gates as Derived Claim Constraints (Not New Task Status)

Status: accepted · 2026-06-20

## Context

v0.20 introduces workflows — typed dependency gates between tasks in a mission. When a task has unsatisfied workflow gates, it is not yet claimable. The design question was: **should "blocked by workflow" be a new task status (e.g., `gated`), or a derived property of `pending` tasks?**

## Decision

**Workflow-gated tasks stay in `pending` status. "Not yet claimable" is a derived property — workflow gates are checked at claim time via a new `areAllWorkflowGatesSatisfied(taskId)` guard, mirroring the existing `areAllDependenciesMet(taskId)` guard.**

The task status enum (`pending | claimed | in_progress | submitted | approved | rejected | done | failed`) is unchanged.

## Rationale

The codebase already chose this pattern for dependency-blocked tasks:
- `taskDependencies` table (`task.ts:155`) stores simple `taskId → dependsOnId` edges
- `areAllDependenciesMet()` (`taskQueries.ts`) is checked inside `claimTask` at `taskStateMachine.ts:27`
- Tasks with unmet dependencies remain in `pending`; the claim returns `dependencies_unmet`
- The UI exposes this via a derived `hasUnmetDeps` flag, not a status (see `savedFilter.ts:107`: `{ name: "Blocked", config: { status: "pending", hasUnmetDeps: true } }`)

Introducing `gated` as a new status would have:
- Broken the established convention ("blocking is derived, not stored as status")
- Required widening the status enum, with cascading changes to every place that switches on status
- Created two sources of truth for "claimable?" (the status field and the gate state), which would drift
- Forced every non-workflow task to skip a new status branch

## Alternatives considered

- **Add `gated` status.** Rejected — goes against existing dependency-blocking convention.
- **Add `workflowGated: boolean` flag.** Rejected — two sources of truth for "claimable?".
- **New `OrchestrationClaimStrategy` as third `IClaimStrategy`.** Rejected — duplicates suggestion logic, requires conditional wiring per mission, means two claim paths.
- **Push workflow awareness into `getSuggestionsForAgent`.** Rejected — conflates "what's a good fit?" with "what's executable now?".

## Consequences

- Zero changes to `IClaimStrategy`, `HttpClaimStrategy`, `InProcessClaimStrategy`, `runPollTick`, `getSuggestionsForAgent`. The v0.19.1 daemon seam stays clean.
- One new line in `claimTask` and one in `claimTaskByRemoteParticipant`.
- New claim failure reason: `workflow_gates_unmet`.
- UI gets a sibling derived flag `hasUnmetWorkflowGates` alongside existing `hasUnmetDeps`. **Server-side computed** via EXISTS subquery in the task query layer: `EXISTS (SELECT 1 FROM task_workflow_gates WHERE downstream_task_id = tasks.id AND satisfied = 0)`. This sets precedent as the first server-side derived filter — the existing `hasUnmetDeps` at `savedFilter.ts:107` is UI-only today and is NOT changed by v0.20.
- "Blocked" filter expands to include both kinds of blocking.
- **Workflow service subscribes to a new `onTransition` hook** (see ADR-0005), NOT the existing `onTaskEvent`. The existing `onTaskEvent` only fires for `completed|approved|rejected|failed`; `onTransition` fires for all 8 actions, which `workflowService` needs for `on_fail` heartbeat-lost recovery (via `released`) and submission tracking.
