# Learning Loop Ledger, Citations, and Lineage

Status: accepted · 2026-08-12

Companion to the Learning Loop architecture and authorization-review plans.

## Context

Orcy needs a bounded, human-governed mechanism to convert operational history into reusable knowledge. Existing stores cannot jointly own this loop:

- **Wiki** is an authored-only destination with append-only versioning and polymorphic links. It has no review lifecycle, revision lineage, or replay-safe work identity. A wiki page is the output of promotion, not the system of record for findings.
- **Triage** owns defect routing (`open → triaged → resolved`). Its lifecycle is incompatible with a proposal/review/promotion flow, and its cluster identity is pulse-derived, not evidence-derived.
- **Automation** owns rule execution. Its attempt lifecycle is close in shape but its identity, dedup, and completion semantics are rule-scoped, not finding-scoped.
- **Audit Trail** is a projection of operational events, not a store of derived claims. It lacks immutable content revisions, citation rows, or CAS-protected decision state.

A Learning Loop needs replay-safe logical work, fenced physical attempts, immutable cited findings, append-only human review, and at-most-once promotion. None of these maps cleanly onto an existing table family.

## Decision

### New ledger as system of record

Eight new tables own the complete lifecycle:

| Table | Role |
|---|---|
| `learning_loop_policies` | Habitat-scoped enrollment and schedule per extractor |
| `extraction_work_items` | One logical, replay-safe unit of extraction |
| `extraction_attempts` | One physical attempt with lease-fenced ownership |
| `extracted_findings` | Immutable content/evidence revision with mutable CAS decision envelope |
| `extracted_finding_sources` | Polymorphic citations with read-time resolution |
| `extracted_finding_scope_refs` | Server-derived authorization/query scope |
| `extracted_finding_reviews` | Append-only human review decisions |
| `extracted_finding_promotions` | At-most-once destination promotion records |

### Logical work versus physical attempts

Logical work identity (`logical_work_key`) excludes delivery mode: a scheduled delivery and a manual ensure for the same window, extractor, policy, and boundary tokens converge on one work item. An explicit human-only fresh rerun creates a new `rerun_generation` and a new logical key linked to the prior work.

Physical attempts are separate rows with monotonic `attempt_no` per work item. Lease generation fences candidate persistence and terminalization: only the attempt holding the current `(lease_owner, lease_generation)` may write or complete. A stale fence returns a closed losing outcome and changes nothing.

Completion emission belongs only to the successful owned `running → terminal` transition. Recovery reconciles committed findings without duplicating them.

### Immutable finding revisions versus mutable CAS decision envelope

Content, cited source set, extractor identity, confidence, and completeness never mutate on an existing revision. The decision envelope (`status`, `decision_version`) is mutable only through compare-and-set: two reviewers using one expected version yield one decision and one conflict.

Same `fingerprint` plus `evidence_digest` increments recurrence only (`last_seen_at`, `last_seen_attempt_id`, `occurrence_count`). Changed evidence or content creates a new immutable revision linked through `(lineage_root_id, revision)` and `supersedes_finding_id`. There is no in-place content/evidence mutation primitive.

### Lease generation/fencing and completion ownership

Attempt acquisition, candidate persistence, and terminalization all use conditional UPDATE predicates guarded by `(status, lease_owner, lease_generation)` plus `SELECT changes()` for portable affected-row classification. The same pattern guards promotion terminalization. This mirrors the established pattern in `scheduledOccurrences.ts` and `taskCreationDispatch.ts`.

### Atomic finding/citation/scope persistence

One candidate, all its citations, and all server-derived scope refs commit in one transaction. Any citation or scope-ref insert failure rolls back the finding and every subordinate row. The unique index on `(habitat_id, extractor_key, extractor_version, fingerprint, evidence_digest)` is the race defender for concurrent recurrence checks.

### Polymorphic citation identity and read-time resolution

Each citation row stores `(source_type, source_id, source_version)` — a stable catalog-owned reference. Source version is empty for immutable sources. Resolvers batch by `source_type` and return `available | dangling | unauthorized | changed`. A changed mutable source compares its current normalized digest with the stored `source_digest`. Dangling or changed citations make the finding stale for new promotion but do not delete a previously reviewed finding or already-authored wiki page.

### Server-derived scope refs

Scope refs (`scope_type: task | mission | domain`) are derived transactionally from successfully resolved cited-source entity refs. A Task ref also derives its owning Mission ref. A domain ref is created only when a source adapter explicitly projects that domain and at least one cited Task/Mission belongs to the same Habitat. Extractor payloads, free text, labels, and subject text never grant scope.

Habitat-wide findings are represented by **no scope refs** and are human-only in v1. Unscoped findings never appear in agent results.

The `derived_from_source_id` column on each scope ref points to the citation row that established the scope. Changed citations create a new finding revision and a newly derived scope set; scope is not patched onto an old revision.

### Promotion row as permanent derivation authority

The successful `extracted_finding_promotions` row — keyed to `(finding_id, destination_type, destination_key)` and the produced target ID — is the permanent derivation record. Wiki links are reader-facing citations and remain removable; they are not the feedback-loop authority. This ensures that a promotion target is permanently excluded from future source batches even if the wiki link is removed, the page is edited, or it is published.

### Retention/FK/cascade choices

| Relationship | Action | Rationale |
|---|---|---|
| `habitats → policies` | CASCADE | No cross-Habitat ownerless policy state |
| `habitats → work_items` | CASCADE | No cross-Habitat readable work state |
| `habitats → findings` | CASCADE | No cross-Habitat readable findings |
| `policies → work_items.policy_id` | SET NULL | Work history survives policy deletion |
| `work_items → attempts` | CASCADE | Attempts belong to work items |
| `findings → sources/scope_refs/reviews/promotions` | CASCADE | Subordinate rows belong to the finding revision |
| Cross-chain provenance pointers (`first_attempt_id`, `last_seen_attempt_id`, `completed_by_attempt_id`, `parent_attempt_id`, `supersedes_*`, `lineage_root_id`, `derived_from_source_id`) | NO FK (plain TEXT) | Mirrors the 0054 task-publication design: the habitat CASCADE chain handles cleanup; provenance references are application-layer invariants |

Cross-chain provenance pointers carry no FK constraint because they would create cascade-ordering ambiguity in SQLite (a finding references both `habitats` and `extraction_attempts`; both cascade from `habitats` through different branches). The habitat CASCADE chain ensures no orphan rows survive Habitat deletion. The application layer enforces referential integrity for provenance at write time.

## Consequences

- The ledger is the system of record for derived knowledge. Destinations (Wiki, Insights, Skills) are consumers, not authorities. Adding a destination requires a new promotion adapter, not a new finding table.
- The immutable-revision contract means corrections always produce a new revision. A reviewer never sees content change underneath them after acceptance. The old revision remains queryable for audit.
- The CAS decision envelope means concurrent reviewers collide predictably (409, not last-write-wins). This is deliberate: a finding is a claim that a human stakes their review on.
- The citation degradation matrix (`available | dangling | unauthorized | changed`) means a finding can become stale without being deleted. A dangling citation does not erase prior review; it blocks new promotion.
- The cross-chain no-FK design means application-layer code must enforce provenance integrity. The repository layer validates attempt identity before persisting candidates; the runner validates work-item identity before creating attempts.

### Deferred contracts

- Source catalog, collection, resolution, privacy projection, and extractor implementations are deferred to later tickets. The ledger tables and repository primitives are dormant until wired.
- Plugin-provided extractors require a separate accepted ADR and release.
- Remote participant/MCP exposure requires a later `knowledge.read` scope, standing policy, source-redaction contract, and anti-probing error mapping.
- Notification Events and Deliveries are deferred until a sealing/versioning ADR exists.
- Direct promotion to Project Insights or Habitat Skills is deferred until each destination has its own review/revision contract.
