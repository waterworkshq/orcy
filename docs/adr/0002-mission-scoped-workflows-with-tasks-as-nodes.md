# Mission-Scoped Workflows with Tasks as Nodes

Status: accepted · 2026-06-20

## Context

v0.20 introduces workflows to coordinate multi-agent execution. The seed doc (`docs/plans/v3/09-agent-orchestration-platforms.md`) listed three scope candidates: **mission**, **task**, or **template**. Everything downstream — data model, claim path integration, lifecycle, UI surface — depends on this choice.

## Decision

**Workflows are an optional DAG property of a mission. Workflow nodes map 1:1 to tasks within that mission. There is no separate "step" or "node" entity. Templates are included in v0.20 as creation-time scaffolds (they spawn, they don't execute), but cross-mission and cross-habitat workflow chains are out of scope.**

## Rationale

- CONTEXT.md is unambiguous: **Mission** = "a goal inside a habitat, with acceptance criteria and child tasks." A workflow is *how* the mission's tasks get executed — it's a property of the mission, not a sibling concept.
- **Task** is the atomic claim unit (`ClaimResult.task` at `shared/types/daemon.ts:32-49`). The claim path stays atomic; orchestration decides *which* task an agent should claim next, not what a task *is*.
- The seed's "deploy chain" example can be modeled as tasks within a release-type mission (build → release → deploy tasks). Cross-mission chains stay out of scope per the seed's explicit boundary ("general-purpose workflow engine unrelated to Orcy work items").
- Nodes 1:1 with tasks means no parallel "step" entity to synchronize. The workflow is a static declaration of typed edges over existing tasks. Claim path, lifecycle, audit, and UI all operate on tasks as today.
- Templates included because without them, every multi-step mission is hand-assembled task-by-task — the exact prompt-discipline problem orchestration is supposed to solve. But templates spawn (one-shot at mission creation); they don't execute or stay linked to instantiated missions.

## Alternatives considered

- **Task-scoped workflows** — chain tasks across missions or habitats. Rejected: breaks the "workflow is a property of a mission" model; cross-mission dependencies would require distributed coordination. Cross-pod workflows explicitly deferred.
- **Template-scoped workflows** — workflow lives on a template and runtime follows the template, not the mission. Rejected: instantiated missions need to be mutable (admin adjusts gates mid-flight); tying to template forces immutable runtime.
- **Templates deferred entirely.** Rejected — bootstrap problem defeats orchestration's value proposition. Templates included as creation-time scaffold.
- **Separate "step" entity alongside tasks.** Rejected — duplicates task concept, forces synchronization between two models, breaks 1:1 mapping with `ClaimResult.task`.
- **Cross-pod / cross-mission workflows.** Rejected for v0.20 — would require distributed gate evaluation, cross-pod event subscription, opening the closed v0.19 `RemoteActionScope` union. Future release territory.

## Consequences

- New `workflows` and `taskWorkflowGates` tables, both `missionId`-scoped.
- `taskWorkflowGates.upstreamTaskId` / `downstreamTaskId` are FKs to existing `tasks` table.
- `getSuggestionsForAgent`, `claimTask`, `IClaimStrategy` all unchanged in shape — they still operate on tasks.
- Workflow CRUD routes scoped as `/api/v1/missions/:id/workflow` — mission is the ownership boundary.
- Cross-mission workflows are a non-goal for v0.20; future releases can revisit if multi-mission coordination becomes a real need (would require its own design pass).
