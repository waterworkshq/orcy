# Implementation-finding triage lifecycle in a parallel finding_triage table

Engineering findings that enter triage are tracked in a new `finding_triage` table mirroring the `code_evidence_gaps` lifecycle pattern (status / reason / resolution) but finding-specific. `code_evidence_gaps` is not reused because it is domain-specific to code-evidence-for-tasks; general engineering findings target a pulse (not a task's evidence), carry more lifecycle states (`open → triaged → in_progress → resolved | wontfix`), and carry a routing bucket decision (`fix_now | defer_to_patch | defer_to_release | document_as_known_limitation | needs_investigation`) with no gaps analog. Per the codebase's "don't reinvent the lifecycle, mirror the pattern" discipline, the table reuses the gaps *shape* in a parallel structure.

The finding lifecycle deliberately **outlives the triage mission**: a triage mission resolves when the investigation completes, but a finding routed `defer_to_patch` stays `triaged`/waiting until its target release ships. The triage mission is the bounded investigation unit; `finding_triage` is the finding's routing lifecycle, which extends beyond it.

## Bidirectional linkage (no status denormalization onto the pulse)

- `finding_triage.pulse_id` references the source finding pulse (the table tracks the pulse).
- The pulse metadata gains a `findingTriageId` pointer written **once**, at triage-record creation. The live status is **not** denormalized onto the pulse — pulse-readers join via the pointer for current status. This avoids mutating the pulse on every lifecycle transition and the status drift that would follow.

## Dedup and reoccurrence prevention

When a new structured finding pulse arrives, the ingestion path checks existing `finding_triage` records by normalized subject (`clusterKey`) + `findingKind` + affected files:

- A matching record in a **non-terminal** state (`open`/`triaged`/`in_progress`) → the new pulse is linked as **corroborating evidence** to the existing record; no duplicate triage mission is created.
- A matching record in a **terminal** state (`resolved`/`wontfix`) → the recurrence is noted as a re-open candidate for human review; no automatic re-triage.

This prevents duplicate triage missions for the same finding while accumulating corroborating signal strength.

## Considered Options

- **Reuse `code_evidence_gaps`** — rejected: conflates code-evidence-for-tasks with general engineering findings against the codebase's "don't conflate" discipline; different target, fewer lifecycle states, no bucket field.
- **Derive from pulse metadata + triage mission (no table)** — rejected: mutates pulse metadata on every lifecycle transition (audit concern); bucket-routing queries would require JSON extraction at scale; the "lifecycle outlives the mission" state has no home.
