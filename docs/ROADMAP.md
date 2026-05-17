# Orcy — Product Roadmap

> **Version:** v0.10.0 | **Updated:** 2026-05-17

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
| v0.7 | Solid Ground: Phase 3 UI refactors — consolidated formatting/badge utilities, fixed SSE notifications, extracted AgentCard, decomposed habitatStore (7 slices) and useTaskDetailPanel (8 hooks), fixed FilterBar auth bypass (6 of 7 planned refactors; R16 React Query unification deferred) |
| v0.8 | See the Invisible — board health metrics (0-100 composite score, A-F grade, 5 dimensions), audit log exports (streaming CSV/JSON/JSONL), feature-level comments (threaded discussion on missions) |
| v0.9 | Work Your Way — task board view (table/list with sorting, filtering, bulk ops), dynamic prioritization rules engine (10 condition types, auto-recalculates priority), recurring scheduled tasks (cron/interval/one-time, template-based feature creation) |
| v0.9.1–v0.9.4 | Patch fixes — post-release audit (20 issues), API docs restoration, R16 React Query unification (17 components), release tooling fixes, scheduled task title templating (`{{date}}`/`{{counter}}` tokens) |
| v0.10.0 | "Breaking Change" — naming consistency (`board→habitat`, `feature→mission` across 5 packages, 9 DB tables, 200 routes, 12 MCP tools, 12 SSE event types), unified `orcy_*` MCP tool prefix |

---

## Upcoming

---

### v0.11.0 — "Guardrails"

Structure around how work moves through the pod.

| Feature | Problem it solves |
|---------|-------------------|
| Review Assignment Rules | "I keep reviewing my own PRs" → domain routing, anti-self-review |
| Sprint / Iteration Management | "What are we doing this sprint?" → time-boxed sprints, burndown, carry-over |
| Dynamic Prioritization polish | Visual rule builder (replace JSON editor), email notifications for priority changes |
| Mobile table view | "I need to check tasks from my phone" → card-based responsive table fallback for the Task Board View |

**Why together:** Governance theme. Review rules and sprint management add structure to work flow. Prioritization polish and mobile table view build on v0.9.0's foundation — completing the priority lifecycle (configure rules visually, get notified) and extending the table view to all devices.

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
