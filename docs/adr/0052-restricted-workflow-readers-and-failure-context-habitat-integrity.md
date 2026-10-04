# ADR-0052: Restricted ordinary Workflow readers and captured Failure Context Habitat integrity

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-04 |
| **Supersedes** | — |
| **Related** | [ADR-0002](./0002-mission-scoped-workflows-with-tasks-as-nodes.md) (Mission-scoped workflow graphs), [ADR-0003](./0003-recovery-tasks-as-normal-tasks.md) (ordinary Recovery Tasks), [ADR-0004](./0004-experience-signals-reuse-pulse.md) (Experience signals in Failure Context bundles), [ADR-0045](./0045-learning-loop-authorization-and-privacy-propagation.md) (Learning Loop privacy rules), [ADR-0049](./0049-authoritative-http-assembly-and-policy-installed-authentication.md) (production-owned auth) |

## Context

The ordinary Workflow readers and the captured Failure Context reader each resolved
authorization against the **requested** object and then serialized raw rows.

- `GET /tasks/:id/workflow-context`, `GET /api/shared/tasks/:id/workflow-context` and
  `GET /api/shared/missions/:id/workflow` returned every selected
  `task_workflow_gates` column and the whole `workflows` row. A Mission-only or
  single-Task remote grant therefore disclosed the opposite endpoint id, the owning
  Workflow/Mission/Habitat, an optional Recovery Task id, arbitrary `matchConfig`
  and `condition` JSON, and — on the Mission route — `resolvedVariables`,
  `failureHandler` and `joinSpecs`.
- `attachWorkflow` stores supplied node task ids with FK-existence only, and the
  gate table's foreign keys are independent, so a stored gate can name a Task in
  another Mission or Habitat. The raw response made that structural inconsistency
  readable from outside.
- `GET /tasks/:id/failure-context` served the full captured row to any admitted
  local actor. Admission uses the Task's **current** Mission → Habitat ancestry,
  while the row keeps the `habitatId` captured at build time, so a scope mismatch is
  representable and was returned without comment.

Three questions had to be settled by the owner rather than by implementation taste:
how much a Workflow reader may disclose, what to do with a context captured in a
different Habitat, and whether the individual-Experience diagnostic bundle should
survive on the served surface at all.

## Decision

### 1. Ordinary Workflow readers return a constructed restricted DTO

Exactly three route families project at the served route boundary:

| Reader | Result |
|---|---|
| Local `GET /tasks/:id/workflow-context` (both prefixes) | `{upstream: RestrictedGate[], downstream: RestrictedGate[]}` |
| Shared `GET /api/shared/tasks/:id/workflow-context` | same |
| Shared `GET /api/shared/missions/:id/workflow` | `{workflow: {status, version}, gates: RestrictedGate[]}` |

Every `RestrictedGate` is freshly constructed as exactly
`{gateType, satisfied, restricted: true}` from named columns. No spread, no
serialize-then-delete, no recursive JSON traversal, no raw fallback. The projection
lives in one small shared helper, `services/workflowReadProjection.ts`, consumed by
the local and shared routes; it is deliberately **not** pushed into the actor-free
service layer, because internal consumers need full rows.

Disclosed, and accepted as such: that context exists, its array direction, gate
count, gate type, persisted satisfaction, and the selected active Workflow's
`status`/`version`. Omitted: every gate/Workflow/Mission/Habitat/opposite-endpoint/
Recovery id, `matchConfig`, `condition`, timestamps, actor/provenance and recovery
depth, plus `resolvedVariables`/`failureHandler`/`joinSpecs`/author/detachment on the
Mission route. This is restriction, not anonymity or hidden-existence isolation.

Every currently selected gate is still returned, in the selected array and order,
including satisfied gates and gates belonging to a detached workflow. The reader
never converts a real context into a false empty or false-unblocked result, and the
pre-existing no-context/not-in-workflow `404` is still decided from the original
selected arrays, before projection. Map order is preserved as selected; the queries
carry no `ORDER BY`, so no cross-request ordering guarantee is claimed.

Because the DTO no longer names linked objects, it **cannot** be used to determine
Claimable, and the MCP tool description and both skill copies now say so.

### 2. A captured Habitat that differs from the current Habitat is refused

`GET /tasks/:id/failure-context` keeps its existing admission, then compares the
selected row's captured `habitatId` with the Habitat validated by
`authorizeTaskAccess`. Inequality is `409 CONFLICT` with the single bounded message
`Failure context Habitat does not match the Task Habitat` — no details, no captured
Habitat id, no failure reason, no bundle.

This is a **scope-consistency refusal, not a membership denial**. Request admission
`403`/`404` is still decided first, a missing row is still `404` before the
comparison, and being admitted to *both* Habitats does not waive it — neither for a
dual-member human nor for a broadly admitted local agent. Nothing is repaired or
rewritten, no event or audit row is added, and no captured content is silently
transferred to the current Habitat.

The comparison is request-time against the validated ancestry. It is not
transactional fencing of Task-parent movement or membership revocation, and it does
not claim that ordinary supported movement creates a mismatch or that database-wide
integrity is repaired.

### 3. Full local diagnostics are an explicit narrow exception

The full Failure Context bundle — failure reason and artifacts, individual
Experience subject/timing, single-Task category counts, opaque lifecycle metadata and
retry history — is served in full to already-admitted local humans and agents on a
consistent-Habitat context. This is a deliberate, narrow exception to the general
external Experience aggregate-only convention, and it is **not** k-anonymous or
source-complete authorization: strings, URLs and metadata can carry opaque
historical references.

The consequence is that Recovery agents keep their diagnostics. A Recovery agent
that owns Recovery Task Q can read failed Task F while F is assigned to a different
agent P, through the existing failed-ID MCP tool; being assigned to a Recovery Task
is not newly required, and no original-failed-author or Recovery-assignee authority
tier is introduced. Original and unassigned admitted local agents keep full detail
too. The backend coordinator's actor-free reader stays full regardless of this served
check, and the tests cover the served seam separately, because internal preservation
alone would not protect Recovery-agent behaviour.

### 4. Unchanged authorities

Internal Workflow services and repositories, gate advancement, capture/recovery and
the frozen handoff handler stay full and actor-free. The `adminOnly`
`GET /missions/:id/workflow` and `GET /workflows/:id/failure-contexts` keep their
separate global-administrative authority with no Habitat-membership predicate. A
global admin using the **ordinary** Task route receives the restricted DTO and still
needs requested-Habitat membership — the admin routes are a separate authority, not
an admin bypass on the ordinary ones. No new reference-authority engine, endpoint,
error-code registry entry, schema migration or repair operation is introduced.

## Consequences

- Task-only and Mission-only remote grants keep working: admission is unchanged and
  the smaller payload removes the residual hidden-reference disclosure. The cost is
  a wire-shape change for the three readers, corrected in the API/security/architecture
  docs, both skill copies, the live MCP tool descriptions and their examples.
- Stored gate ancestry is **not** validated. The restriction hides identifiers; it
  does not check them, and `attachWorkflow` still admits cross-Mission/cross-Habitat
  node ids at FK-existence level. Validating attached nodes against the selected
  Mission at attach/template/import is separate integrity work and is deliberately
  not bundled here — as is any repair of already-stored edges.
- The individual-Experience diagnostic content remains available on this surface by
  explicit decision, which narrows but does not close the tension with the
  aggregate-only external convention.
- A captured/current Habitat inequality is a **representable integrity anomaly**, not a
  supported state and not a Task-transfer feature. The owner explicitly rejected
  supported cross-Habitat Task transfer: a Habitat is one codebase and a Task belongs to one
  Mission in one Habitat, and ordinary Task/Mission update schemas do not expose parent
  transfer. Independent foreign keys nevertheless allow the row to exist, so the read
  refuses it with `409` and nothing is rewritten, repaired or transferred. No reconciliation
  operation is defined here; treating such a row is future, separately scoped work.
- A local global admin no longer sees full gate config through the ordinary Task
  route. That is the intended effect of the projection, not a regression: the admin
  Mission Workflow route still serves it.
