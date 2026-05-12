# Orcy — Product Roadmap

> **Version:** v0.5.0 | **Updated:** 2026-05-12

Each minor release tells a story — a coherent set of changes with a clear "why."
Release boundaries are risk management decisions: breaking changes, fragile features, and big refactors never ship together.

---

## Delivered

| Ship | Story |
|------|-------|
| v0.1–v0.2 | Core product: kanban + MCP + Web UI + hierarchical model + Pulse V1 + rebrand |
| v0.3 | Fix foundations: shared config, ID normalization, CLI error handling |
| v0.4 | Stop type drift: shared types package, shared API client |
| v0.5 | Clean API internals: JWT extraction, schema split, scheduler, webhook dedup, rate limiter unification, board access consolidation, AppError migration |
| v0.6 | Pulse — habitat-level signals, project insights (institutional memory), signal reactions, WebUI Signal Board tab, habitat + insights panels |

---

## Upcoming

---

### v0.7.0 — "Solid Ground"

Phase 3 UI refactors. Clean the foundation before the next wave of UI features.

| Order | Refactor | Depends on |
|-------|----------|------------|
| 1 | Consolidate formatting utilities (5 copies of formatRelativeTime, etc.) | — |
| 2 | Consolidate status badge maps (10+ duplicate mappings) | — |
| 3 | Fix SSE notifications (replace fragile monkey-patch with subscription) | — |
| 4 | Extract AgentCard component (130 lines × 2) | 1 |
| 5 | Decompose habitatStore (671-line monolith → 7 domain slices) | 3 |
| 6 | Decompose useTaskDetailPanel (463-line hook → 8 composable hooks) | 5 |
| 7 | Unify data fetching to React Query (3 patterns → 1) | 5, 6 |

**Why standalone:** Zero user-facing features. If bundled, the refactors become invisible work. Standalone signals code health is a first-class concern.

---

### v0.8.0 — "See the Invisible"

Three features that give humans visibility into what the pod is doing.

| Feature | Problem it solves |
|---------|-------------------|
| Board Health Metrics | "Is my pod healthy?" → composite 0-100 score from 5 dimensions |
| Audit Log Exports | "Show me what happened last week" → streaming CSV/JSON/JSONL |
| Feature Level Comments | "Why did you do it that way?" → threaded discussion on missions |

**Why together:** Visibility theme. Share UI patterns. Zero code dependencies — can be parallelized. No breaking changes.

---

### v0.9.0 — "Work Your Way"

Flexibility in how tasks flow through the system.

| Feature | Problem it solves |
|---------|-------------------|
| Task Board View | "Kanban isn't always the answer" → table/list with sorting, filtering, bulk ops |
| Dynamic Prioritization | "This should have been urgent yesterday" → rules engine auto-recalculates priority |
| Recurring Scheduled Tasks | "We do this every sprint" → cron-based task creation from templates |

**Why together:** Workflow flexibility theme. Touch similar code paths (task queries, column logic). Prioritization rules benefit from previewing effects in the Task Board View. Recurring tasks share the template system that prioritization references.

---

### v0.10.0 — "Breaking Change"

Phase 4 refactors. The API surface has been stable since v0.2. One focused release to clean naming for good before adding more API surface.

| Refactor | Risk |
|----------|------|
| Naming consistency (featureId → mission, boardId → habitat, etc.) | Medium |
| MCP tool rename (unified `orcy_*` prefix) | HIGH |

**Why standalone:** MCP tool rename breaks ALL agent integrations. Nothing else can ship in this release — users need a single clear changelog entry. After this, naming is frozen.

---

### v0.11.0 — "Guardrails"

Structure around how work moves through the pod.

| Feature | Problem it solves |
|---------|-------------------|
| Review Assignment Rules | "I keep reviewing my own PRs" → domain routing, anti-self-review |
| Sprint / Iteration Management | "What are we doing this sprint?" → time-boxed sprints, burndown, carry-over |

**Why together:** Both add governance to team workflow. Independent but share a theme. Sprint management at 9d is the flagship.

---

### v0.12.0 — "Fit In"

Orcy integrates with the tools teams already use.

| Feature | Problem it solves |
|---------|-------------------|
| GitHub Issues Sync | Bidirectional sync between GitHub Issues and Orcy missions |
| Jira / Linear Integration | Provider-agnostic framework with Jira + Linear adapters |

**Why together:** Both are integrations. GitHub Issues sync is the foundation — the abstraction layer for the Jira/Linear framework is the same one GitHub uses. Sequential dependency, ship together.

---

### v0.13.0 — "Autonomous"

Daemon & Cron Automation. Agents run themselves — no more manual launch.

| Component | What |
|-----------|------|
| Daemon | Local background process spawns and manages agent sessions |
| Cron Scheduler | Server-side scheduler nudges agents to work on a schedule |

**Why separate:** Largest single feature since the original build. Pulse proves the signal model the daemon depends on — let it bake first.

---

### v0.14.0 — "The Habitat Remembers"

Dynamic Habitat Skills. Each habitat auto-generates a living skill document from high-strength pulse signals — findings, patterns, decisions that multiple agents confirmed.

**Why last:** Depends on Pulse project insights existing and accumulating real data. Premature without usage patterns to tune the signal strength scoring against.
