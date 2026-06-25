# Scheduler Spawns Authoring Tasks; Never Writes Content

Status: accepted · 2026-06-25

## Context

The v0.21 Habitat Wiki (ADR-0006) faces an information-overload problem: when a habitat first enables the wiki, the volume of historical primitives (pulses, signals, insights, evidence from v0.6 onward) is too large for a single authoring session. The same problem recurs for living pages: knowledge keeps accumulating after the initial authoring, and pages go stale without a refresh path.

The design question: **how does the wiki stay current without becoming an auto-write system?**

During grilling, the boundary was stated forcefully in caps: the resolution is scheduler-driven chunked authoring where **the scheduler spawns authoring tasks and an orcy (human or agent) claims and authors each chunk. The scheduler never writes content.** This ADR exists to protect that boundary against future drift toward auto-generation.

## Decision

**Wiki content refresh is modeled as scheduled authoring work, not as scheduled writing. A habitat may configure a wiki cadence (reusing v0.9 `scheduled_tasks` + v0.20 `mission_templates`). The scheduler spawns authoring tasks bounded by a time chunk (earliest signal → date cap A; then A → B; then B → C; …). Each spawned task is a normal task that a human or agent orcy claims and authors through the standard authoring path. The scheduler produces task rows; it never produces `wiki_pages` or `wiki_page_versions` rows directly.**

Two operating modes:

- **Bootstrap** — when a habitat first enables wiki cadence, the scheduler queues chunked authoring tasks from the earliest captured signal forward, in chronological order, until the wiki is current.
- **Ongoing cadence** — after bootstrap, the scheduler continues at the configured interval (e.g. daily, weekly), each run spawning "author the recent-changes chunk" tasks at habitat scope. Cadence is habitat-wide; there is no per-page opt-in (see "Cadence scope is habitat-wide" below).

Both modes share the same invariant: **the scheduler writes task rows only.** Content is always produced by an orcy claiming and authoring the task.

**Cadence scope is habitat-wide.** There is one cadence config per habitat; there is no per-page opt-in or per-page refresh toggle. Each cadence run targets pages/chunks at the habitat level via a deterministic rule (e.g. all pages whose last version is older than the interval, or the next chronological chunk) — the exact targeting rule is an implementation detail for ARCHITECTURE.md, not a per-page author decision.

## Rationale

- **Protects ADR-0006 from scheduler drift.** A scheduler that "writes wiki content on a schedule" is auto-write by another name. Modeling the scheduler as a task-spawner keeps the authored-only invariant (ADR-0006) intact regardless of how the cadence is configured.
- **Reuses proven machinery.** `scheduled_tasks` (v0.9) already supports cron/interval/one-time scheduling with template-based feature creation. `mission_templates` (v0.20) already instantiate work from templates. The wiki scheduler is a new template type for wiki-authoring tasks, not new infrastructure. This is the same pattern used for recurring scheduled tasks and template-based mission creation.
- **Time-chunking makes authoring tractable.** Bounding each task to a date range ("author wiki for the API domain, signals from 2026-01 to 2026-03") gives the author a manageable context window. The chunk size is a template parameter; the scheduler iterates chunks forward in time. This addresses the information-overload caveat raised during grilling without resorting to auto-summarization.
- **Delta-on-edit is the per-page complement.** When an author opens an existing page for editing, the Authoring Augmentation surface (CONTEXT.md) shows only primitives changed since the page's last version — a deterministic timestamp filter. The scheduler's chunked tasks and the per-edit delta are two views of the same "bound the authoring context" principle: one for initial/ongoing generation, one for in-place revision.
- **Ongoing cadence keeps the wiki living without autogen.** A wiki that can only be bootstrapped once goes stale. Ongoing scheduled authoring tasks let a habitat keep its knowledge current through deliberate orcy work, on a habitat-wide cadence the habitat chooses, without ever crossing into auto-write.
- **Matches how Orcy already thinks about work.** Tasks are the unit of work; orcys claim and do them. Wiki authoring is work. Modeling it as tasks is consistent with the entire task/mission/claim model rather than inventing a parallel "generation" concept.

## Alternatives considered

- **Auto-summarize chunk content and write draft pages.** Rejected:
  - This is auto-write, deferred to seed 12 by ADR-0006.
  - Requires extraction logic (what to summarize, how to phrase, how to cite) that seed 12 is scoped to design.

- **One-shot bootstrap only (no ongoing cadence).** Rejected:
  - Leaves the wiki to go stale. Authors must remember to manually refresh pages, which in practice means pages rot.
  - The cadence fix is cheap (a scheduled-task config) and does not violate the authored-only boundary, so there is no reason to defer it.

- **Manual authoring only, no scheduler.** Rejected:
  - Leaves no answer to the information-overload caveat for initial generation. "Author everything from scratch" is the unbounded task that motivated this design.

- **Background job that watches primitives and queues tasks dynamically.** Rejected for v0.21:
  - Effectively a seed-12 extraction heuristic ("detect when enough has changed to warrant a refresh"). Out of scope.
  - The v0.21 scheduler is time-based (cron/interval), not change-detection-based.

## Consequences

- A new mission template type `wiki-authoring` (or equivalent) is added; its variables include the habitat, target page or page-area, and the time-chunk bounds.
- `scheduledTaskService` (v0.9) gains a new use case; no changes to its core. The scheduler produces task rows from the template on the configured cadence.
- Spawned authoring tasks are indistinguishable from manually-created authoring tasks — same claim path, same lifecycle, same `created_by` attribution to the claiming orcy.
- A habitat-level config controls whether wiki cadence is enabled and at what interval. Default: disabled (no scheduler runs until a habitat opts in). Cadence is habitat-wide; there is no per-page refresh config.
- Bootstrap is a one-time state transition (no cadence → cadence enabled → catch-up chunks queued → ongoing cadence). Implementation detail for ARCHITECTURE.md.
- This ADR and ADR-0006 together form the boundary that seed 12 will later relax: when seed 12 ships auto-write, it does so as a new *feed* into this authored layer (e.g. spawning pre-filled draft tasks), not by replacing the scheduler or the authored-only authorship path.
- No `wiki_pages` or `wiki_page_versions` row is ever written by the scheduler, the cron runner, or any non-orcy path. Auditing this invariant is a candidate test in `TASKS.md`.
