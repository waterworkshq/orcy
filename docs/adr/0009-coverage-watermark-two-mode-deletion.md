# Coverage Watermark; Two-Mode Deletion; No-Update-Needed Markers

Status: accepted · 2026-06-25

## Context

ADR-0008 established that the wiki cadence is scheduler-driven: a habitat-wide cadence spawns time-chunked authoring tasks (bootstrap + ongoing) that an orcy claims and authors. The scheduler never writes content.

Two problems emerge from that model once deletion and low-signal windows are considered:

1. **The deletion gap.** The cadence implicitly tracks how far through habitat history it has evaluated — a forward-moving "coverage watermark." If a wiki page is deleted and the watermark does not move backward, the cadence never re-touches the time window that page covered. The result is a permanent gap: deleted = gone forever, even when the deletion was a mistake or the page was simply wrong and worth a retry.

2. **The make-work loop.** Naively fixing the gap by reverting the watermark on every delete creates an infinite loop for duplicates: delete a duplicate page → watermark reverts → cadence re-authors the same window → recreates the duplicate → delete again. There is no way to express "this page is gone and should stay gone."

3. **Low-signal windows.** Not every time window warrants a wiki page. Without a way to adjudicate "I looked, nothing worth authoring here," the cadence spawns authoring tasks on noise — wasting orcy time and producing low-quality pages. The cadence needs a way to advance past evaluated windows without producing content.

## Decision

**The cadence tracks a per-habitat coverage watermark: the timestamp up to which habitat primitives have been evaluated. The watermark advances by two kinds of authored coverage records:**

1. **Page coverage** — a wiki page exists covering a time window `[from, to]`. The page is the authored content; its coverage window advances the watermark.
2. **No-update-needed marker** — an orcy has evaluated a time window and adjudicated that no wiki page is warranted (low signal, already covered elsewhere, duplicate of an existing page, erroneous). The marker is the authored decision *not* to write; it advances the watermark without producing a page.

The watermark per habitat = `MAX(coverage_to)` across all coverage records (pages + markers).

**Deletion is two-mode, chosen by the deleting orcy:**

| Author's intent | Action | Watermark effect |
|---|---|---|
| "This page was wrong, try again" | Plain delete (DELETE the page) | The page's coverage markers are removed → watermark may revert → cadence re-authors the window on its next run |
| "This page shouldn't exist, don't recreate" | Delete + post `no_update_needed` marker for the page's coverage window | The page's coverage markers are replaced with a `no_update_needed` marker → watermark holds → cadence skips the window |

**`no_update_needed` is a first-class coverage primitive** usable independently of deletion: during normal cadence authoring, an orcy evaluating a time chunk may post a `no_update_needed` marker to advance the watermark without producing a page. Both authoring a page and posting a no-update marker are authored judgments by an orcy — even the decision not to write is authored.

## Schema

One new table tracks coverage. Existing wiki tables (pages, versions, links) are unchanged beyond cascade rules.

```sql
CREATE TABLE wiki_coverage_markers (
  id             TEXT PRIMARY KEY,
  habitat_id     TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  coverage_from  TEXT NOT NULL,                -- ISO timestamp; start of the evaluated window
  coverage_to    TEXT NOT NULL,                -- ISO timestamp; end of the evaluated window
  marker_type    TEXT NOT NULL,                -- 'page' | 'no_update_needed'
  page_id        TEXT REFERENCES wiki_pages(id) ON DELETE CASCADE,  -- set when marker_type='page'; nullable for no_update_needed
  reason         TEXT,                         -- free text: "duplicate of page X", "low signal", "erroneous", etc.
  created_by     TEXT NOT NULL,                -- orcy id (human or agent)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_wiki_coverage_habitat ON wiki_coverage_markers(habitat_id);
CREATE INDEX idx_wiki_coverage_page    ON wiki_coverage_markers(page_id);
CREATE INDEX idx_wiki_coverage_type    ON wiki_coverage_markers(habitat_id, marker_type);
```

The per-habitat watermark query: `SELECT MAX(coverage_to) FROM wiki_coverage_markers WHERE habitat_id = ?`.

On page create (first version saved with `status='published'`, or on publish transition): a `marker_type='page'` row is inserted with the page's coverage window. The coverage window is derived from the primitives the page cites (min/max `updated_at` of linked primitives) or, failing that, from the authoring-context chunk bounds that produced it.

On plain delete: the page row cascade-deletes its `page_id`-keyed coverage markers (via the `ON DELETE CASCADE` on `page_id`). The watermark may revert if those markers were the high-water mark. The cadence's next run re-evaluates the now-uncovered window.

On delete + no-update: before deleting the page, insert a `marker_type='no_update_needed'` row covering the same window (optionally with the deleting orcy's reason). Then delete the page (its page-type markers cascade away). The no-update marker holds the watermark.

## Rationale

- **Heals deletion gaps.** A mistaken or erroneous page deletion is not permanent — the cadence re-authors the window on its next run. This resolves the irreversibility concern that would otherwise have required delete-gating or soft-delete.
- **Breaks the duplicate loop.** Delete + no-update-needed is the explicit "stay gone" signal. The cadence respects it and does not recreate the page. An orcy deleting a duplicate posts the marker; the loop ends.
- **Avoids make-work authoring.** During normal cadence runs, an orcy evaluating a low-signal window posts a no-update marker instead of forcing a low-quality page. The cadence advances past noise instead of amplifying it.
- **No-update-needed is an authored decision, not auto-extraction.** The marker is posted by an orcy (human or agent) making a judgment call, not by a deterministic system. This is consistent with ADR-0006's authored-only boundary: the decision *not* to write is just as authored as the decision to write. Auto-detecting "this window is low-signal" would be seed-12 extraction territory.
- **Granularity is time-window-only for v0.21.** Markers cover a `[from, to]` range. Scope-by-domain granularity (e.g. "no update needed for the `api` domain for Jan–Mar") is a future refinement if make-work tasks cluster in specific areas. Time-only matches the cadence's chunk model and keeps the schema small.
- **Markers do not auto-expire.** A no-update judgment is a point-in-time decision that stays until a human or agent explicitly revises it. Future high-signal emerging within a previously-adjudicated window is a seed-12 extraction concern ("detect changed signal density in a previously-adjudicated window"), not a v0.21 cadence behavior. Keeps the cadence deterministic.

## Alternatives considered

- **No watermark tracking; pure delta-on-edit for everything.** Rejected: does not solve the bootstrap information-overload problem (ADR-0008). The chunk model needs a forward-moving cursor; the cursor needs gap-healing on delete; gap-healing needs the two-mode delete; the two-mode delete needs the no-update marker. The four concepts co-vary.

- **Soft-delete via `status='archived'`.** Rejected: hides pages from lists/search but does not solve the cadence interaction. An archived page still holds its coverage window (cadence skips it) or loses it (cadence recreates it) — the same two-mode question exists, just with an extra status value and filter complexity on every query. Hard-delete + coverage markers is cleaner.

- **Delete-gating (admin-only delete).** Rejected (Q5a → pure democracy): with deletion now healable via the cadence, the irreversibility concern is largely gone. A mistaken delete is re-authored. Gate-delete would block legitimate agent cleanup work without meaningfully reducing risk.

- **Auto-expiring markers.** Rejected: introduces a re-evaluation scheduler and non-determinism. A marker that silently stops holding the watermark after N days would surprise authors who posted it. Explicit revision by an orcy is the honest model.

- **Scope/domain-keyed markers (time + tag).** Deferred: would let "no update needed for the `api` domain Jan–Mar" coexist with "page authored for the `frontend` domain Jan–Mar." Valuable but more schema and more cadence targeting logic. v0.21 ships time-only; scope-keyed markers are a backward-compatible addition if real usage demands it.

## Consequences

- One new table `wiki_coverage_markers` ships in `0035_wiki.sql` alongside the three wiki tables and the FTS5 virtual table.
- `wikiSchedulerService` (Q1c) owns the watermark query and the targeting rule for what window each cadence run evaluates (everything after `MAX(coverage_to)` for the habitat, up to `now`, chunked).
- Page publish transition inserts a page-type coverage marker with a window derived from cited primitives or authoring-context chunk bounds. Implementation detail for ARCHITECTURE.md.
- Delete route accepts an optional body field (e.g. `stayGone: boolean` or `reason: string` indicating no-update intent) that controls whether a no-update marker is posted before the page row is deleted.
- A new MCP action `mark_no_update_needed` joins the `orcy_wiki` tool's action list (Q3a), letting agents post markers during authoring or deletion. The 11 actions become 12.
- Q5a resolves to (i) pure democracy: any authenticated orcy can delete, because deletion is healable. The destructive-irreversibility concern that motivated considering delete-gating is addressed by the cadence re-authoring plain-deleted windows. **This democracy model extends to all wiki operations** — read, author, publish, delete, manage links, post coverage markers, trigger refresh. No wiki-specific roles or admin gates. The rationale: if the most destructive operation (delete) is safe under democracy because it's healable, then less-destructive operations (edit, publish) are safe a fortiori. Adding roles later would be a breaking change for agents that depend on open permissions, but that's a future release's decision — not forced by v0.21.
- `wikiAugmentationService` (Q1a) reads the coverage watermark to compute the next chunk bounds for authoring-context requests (Q2c `POST /wiki/authoring-context`).
- The coverage model is local to the cadence feature — it does not affect read paths, search, links, or versioning. A wiki with cadence disabled has no coverage markers and no watermark; pages still work normally.
- Seed 12 may later introduce auto-posted no-update markers as an extraction output ("the extractor evaluated this window and judged no page warranted, posting on behalf of the system"). The authored-only boundary (ADR-0006) would need revisiting at that point — but the marker schema and watermark mechanic are ready for it without migration.
