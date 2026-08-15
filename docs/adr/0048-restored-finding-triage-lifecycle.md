# Restored Finding Triage lifecycle: command authority, investigation/corrective Mission identity, terminal immutability, and existing-Mission activation

## Status

Accepted.

Supersedes conflicting portions of ADR-0026 (triage mission holds both investigation and corrective work), ADR-0027 (parallel-table lifecycle — the table design remains, but recurrence and dedup semantics evolve), ADR-0029 (release-type targeted deferrals — the column stays, but activation semantics change), and ADR-0033 (triage investigation as roadmap editor — the agent role narrows to routing only, not direct roadmap insertion).

ADR-0032 (Mission DAG as roadmap with release-gate elevation) remains authoritative for the Mission/dependency/gate model this ADR depends on.

## Context

The documented per-Engineering-Finding lifecycle had drifted from its design. Findings entered triage through multiple paths, corrective work was conflated with investigation, terminal rows could be resurrected, and the `triage_mission_id` column ambiguously served as both investigation and corrective identity. The restored lifecycle re-establishes:

- **Distinct provenance**: the bounded Triage Mission owns investigation; the linked corrective Mission owns planned work.
- **Command authority**: one lifecycle command module (`findingTriageLifecycle.ts`) owns all production writes. HTTP, MCP, UI, scan, and Release Activation express intent to it.
- **Repeated-cluster suppression**: a second Triage Mission is suppressed when every structured identity is already non-terminal.
- **Terminal immutability**: `resolved` and `wontfix` never return to a non-terminal state. Recurrence creates a new row with persisted `recurrenceOf` lineage.
- **Existing-Mission activation**: the preferred manual path activates the Finding's existing corrective Mission; it never creates a replacement, clears dependencies, or forces Mission/Task status.

## Decision

### Investigation/corrective Mission identity

The physical `triage_mission_id` column remains unchanged but the domain mapper exposes it as canonical `correctiveMissionId`. New domain code never consumes the deprecated `triageMissionId` alias. A separate nullable `admitted_by_triage_mission_id` stores the bounded investigation Mission identity, and `admitted_by_investigation_task_id` stores the exact Task whose live claim authorizes agent routing.

This supersedes ADR-0026's conflation of investigation and corrective work under one triage mission. The triage mission is now bounded investigation only; corrective work lives under a separate linked Mission.

### Terminal history

Terminal records are immutable. The shared transition map's legacy `resolved → open` and `wontfix → open` edges are retained for type-signature compatibility but the restored lifecycle command module and later enforcement reject them. A recurrence after terminalization creates a new `open` row with persisted `recurrenceOf` lineage. No command, generic PATCH, repository transition, or compatibility adapter may move a terminal row back to non-terminal.

This supersedes ADR-0027's recurrence model where terminal states could reopen.

### Existing-Mission activation

Manual activation activates the Finding's existing corrective Mission by compare-and-swapping the Mission version, clearing only `releaseGateType`/`releaseGateVersion`, and retaining every other field and dependency. Release activation uses the same kernel but retains the gate and attributes to the Release.

This supersedes ADR-0033's model where the triage agent directly inserts roadmap DAG entries. The agent now routes only; roadmap insertion happens through the command module's corrective Mission creation.

### Command authority

All production lifecycle writes go through `findingTriageLifecycle.ts`. Existing repository setters (`setBucket`, `setTriageMissionId`, `transitionStatus`, `promote`) are not removed in the additive phase but the behavior cutover (ticket 2) closes them to new production callers.

### Recurrence

A recurrence requires at least one structured Pulse id absent from the entire terminal lineage and any reset baseline. Old-only evidence returns `evidence_already_accounted` — it does not create or replay an investigation. Legacy `metadata.recurrenceOf` receives a versioned lineage preflight that backfills only proved linear chains; ambiguous lineage is human-repair-only.

### Legacy repair

Legacy lineage repair is an offline maintenance operation. It is unavailable through HTTP/MCP, requires exclusive database access, a verified backup, and explicit operator identity plus reason. Two modes are supported: predecessor mapping (validated linear chain) and evidence-baselined root (persisted cutoff + complete provable Pulse set). Both record an append-only audit ledger in one `BEGIN IMMEDIATE` transaction.

## Consequences

- Eight subsequent tickets deliver the behavior cutover, cluster admission, HTTP/MCP routes, guards, Release activation, staged enforcement, docs, and the final enforcement patch.
- The additive schema (migration 0064) adds nullable columns and new tables with no enforcement — existing production behavior continues to boot against clean and dirty legacy data.
- `legacy_observed` evidence never supplies agent authority, and neither investigation id is fabricated from legacy summaries.
- The preflight reports stable machine-readable diagnostics for operators to assess readiness before the enforcement migration.

## Considered options

- **Edit accepted ADRs in place** — rejected: accepted ADR history is immutable. This ADR supersedes only the conflicting portions identified above.
- **Rename the physical `triage_mission_id` column** — rejected: high-risk migration with no benefit; the domain mapper exposes the canonical name.
- **Automatic legacy lineage flattening** — rejected: ambiguous lineage must be human-repair-only; automatic flattening silently chooses a branch.
- **Manufacture admitting Mission/Task provenance from legacy summaries** — rejected: legacy summaries, counts, and time windows cannot prove historical membership.
