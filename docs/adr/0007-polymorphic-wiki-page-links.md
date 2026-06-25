# Polymorphic Wiki Page Links with Read-Time Dangling Detection

Status: accepted · 2026-06-25

## Context

Wiki pages (ADR-0006) cite source primitives — missions, tasks, pulses, project insights, habitat skill signals, code commits, pull requests, code evidence links, external issues, and (in future releases) plugin-provided primitives. That surface is heterogeneous (today ~8 linkable tables; v0.22 plugins will add more) and will keep growing.

The design question: **how are citations from a wiki page to a heterogeneous and growing set of target entities stored?**

## Decision

**A single polymorphic `wiki_page_links` table. Each row carries `(page_id, target_type, target_id, link_note?, created_by, created_at)` with a uniqueness constraint on `(page_id, target_type, target_id)`. No database-level foreign key on `(target_type, target_id)`. Dangling links (target row deleted) are detected at read time and surfaced in the UI rather than enforced by cascade-delete or a background reconciliation job.**

```sql
CREATE TABLE wiki_page_links (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  link_note   TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (page_id, target_type, target_id)
);
CREATE INDEX idx_wiki_page_links_page ON wiki_page_links (page_id);
CREATE INDEX idx_wiki_page_links_target ON wiki_page_links (target_type, target_id);
```

`target_type` is a controlled string (`'mission' | 'task' | 'pulse' | 'insight' | 'skill_signal' | 'commit' | 'pull_request' | 'evidence_link' | 'external_issue' | …`). New types are added as a new string value with no migration.

## Rationale

- **The link surface is heterogeneous and will keep growing.** Every new linkable entity (v0.22 plugin signals, future audit-bundle references, future external-issue providers) would require a new join table under the per-type approach. Polymorphic absorbs new types with one new `target_type` value and zero schema migration.
- **Polymorphic references are already the house pattern for cross-domain citation.** Code evidence links (v0.16) and audit provenance references already use `(type, id)` pairs across tables rather than hard foreign keys. The failure-context bundle (v0.20) similarly references across entity types by identifier. `wiki_page_links` is the same shape, reused for a new citation surface.
- **Links are citations, not dependencies.** A wiki page is authored prose; its links point at sources the author drew on. Deleting a cited pulse should not delete or block the wiki page — it should mark the citation as dangling so the reader sees "this linked pulse was deleted." Hard referential integrity (cascade-delete links, or block target deletion until links are cleared) would treat citations as dependencies and would force delete-blocks across the entire habitat.
- **One table = one query = one UI.** "All links from this page" is a single `WHERE page_id = ?`. The authoring link-picker, the render-time enrichment, and the MCP surfacing all hit one table. The reverse query ("all pages citing mission X") is a single indexed lookup on `(target_type, target_id)`.
- **Read-time dangling detection is cheap and correct.** When a page is read, the service resolves each link's target in batch (one query per `target_type` present). Missing targets are flagged `dangling: true` in the response. No background job, no drift, no reconciliation lag. The render affordance is a simple inline "linked [X] was deleted" marker.
- **Unique per (page, target).** An author cannot accidentally cite the same primitive twice from one page. Re-citing the same primitive from a different page is allowed (many-pages-cite-one-primitive).
- **`link_note` captures author intent.** Free-text one-liner ("why I linked this") preserves the author's reasoning without forcing a typed relation.

## Alternatives considered

- **Per-type join tables (`wiki_page_task_links`, `wiki_page_pulse_links`, …).** Rejected:
  - N tables today, more every time a new linkable type appears. Schema churn, migration churn.
  - N mutations every time a page is edited (one insert/delete per type the page cites).
  - Cleanest hard FK integrity, but at the cost of treating citations as dependencies — wrong semantics for an authored prose layer.
  - "Find all links from this page" becomes a union of N queries.

- **Polymorphic + background reconciliation job.** Rejected:
  - Adds a scheduler pass and a `dangling` column to maintain. Drift between job runs.
  - Read-time detection is strictly simpler and has zero drift (the check runs at the moment of read).
  - A background job would only be justified if dangling links caused performance problems at read time — they do not, given batched per-type resolution and modest page-link cardinality.

- **Store links as a JSON array on `wiki_pages`.** Rejected:
  - No uniqueness enforcement, no per-link metadata (created_by, link_note) without awkward JSON wrangling.
  - No reverse query ("who cites this pulse?") without scanning every page.
  - Breaks the pattern used by every other link table in the codebase.

## Consequences

- New migration creates `wiki_page_links` with the two indexes and the unique constraint.
- `wikiService` (or `wikiPageLinksRepo`) resolves links at read time: batch-fetch targets grouped by `target_type`, mark missing ones as dangling. UI renders a dangling affordance.
- The link-picker UI lists valid `target_type` values; adding a new type is a code change (a new enum value + resolver entry), not a migration.
- Target entities' delete paths are unchanged — no cascade wiring, no delete-blocks. A deleted pulse simply leaves dangling links behind, surfaced at read.
- v0.22 plugin authors can register new `target_type` values without touching the link schema.
- Future hardening (if dangling links ever become a real UX problem) can add an optional background sweep that archives long-dangling links — but that is not needed for v0.21 and is not pre-built.
- The `target_type` vocabulary should be documented in the ARCHITECTURE.md and enforced by a Zod (or equivalent) union at the API layer to prevent typos.
