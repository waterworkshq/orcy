# Triage investigation as roadmap editor

The triage investigation agent's role expands from "investigate a finding and recommend a routing bucket" to "insert deferred work into the roadmap DAG at an informed position." When the triage agent determines `defer_to_*`, it creates a gated mission and positions it in the DAG — setting `missionDependencies` and the release-gate with awareness of the current roadmap (what's planned, what's next-in-line, what depends on what, what's gated on which release). The agent edits the plan, not just the finding.

This is the mechanism that bootstraps the otherwise-empty mission DAG (Phase 1 constraint: `missionDependencies` is rarely populated in practice). Every deferral that routes through triage creates a roadmap node positioned with full context, so the roadmap fills organically through a flow that already happens — no separate planning ceremony.

## Considered Options

- **Human-only authoring** (humans set all gates and dependencies; triage only recommends buckets) — rejected: humans create most missions today, but the triage flow is the primary deferral path and the agent already holds the finding context needed to decide placement. Forcing a human to separately place what the agent already understood doubles the work.
- **Separate "roadmap authoring" agent distinct from triage** — rejected: the triage investigation already has the finding context (cluster, severity, affected files, related missions). A separate placement agent would re-derive the same context at higher cost. The capability belongs in the investigation that already runs.
- **Triage recommends placement; human confirms** — rejected for the same reason as ADR-0031 (unconditional auto-promotion): it rebuilds a manual gate the feature exists to remove. The triage agent inserts; the human's leverage is pre-insertion (re-defer, wontfix) and post-insertion (edit the DAG), not a confirmation step between investigation and insertion.

## Consequences

- The triage investigation context (currently cluster + affected task/mission data) gains **roadmap DAG data**: the habitat's missions, their dependencies, their release-gates, and the derived "next-in-line" ordering. This is an extension of the existing `getMissionContext` orchestrator pattern.
- A **roadmap-insertion capability** is added to the triage agent's write surface: create a mission with a release-gate + dependency edges in one operation. This extends the existing `createMission` path (which already accepts `dependsOn`/`blocks`) with a release-gate parameter.
- The triage agent's analysis pulse records the placement decision (which dependencies it set, which release-gate, why) so the insertion is auditable and a human can review/edit after the fact.
- This ADR covers finding-deferral insertion (path 1). Orphan-mission auto-mapping (path 3, a separate scan that maps gateless missions into the DAG) reuses the same capability but is deferred to a patch (RM-7).
