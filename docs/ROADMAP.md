# Orcy — Product Roadmap

> **Version:** v0.18.3 | **Updated:** 2026-06-12

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
| v0.11.0 | "Guardrails" — review assignment rules (domain routing, anti-self-review, multi-reviewer approval gates), sprint/iteration management (time-boxed sprints, burndown, carry-over policies), visual rule builder (data-driven config tables with sortable cards), mobile table view (card-based responsive fallback), notification preferences (review assigned + priority changed toggles), SSE cache invalidation for all new event types |
| v0.12.0 | "Fit In" — GitHub Issues sync (OAuth device flow primary, PAT fallback), external issue intake with guarded close protection, webhook-driven updates (HMAC-verified), provider-neutral adapter framework with GitHub adapter, intake candidate system for Jira/Linear, integration settings tab with connection management, external issue badges on missions |
| v0.13.0 | "Fit In More" — Jira Cloud adapter (JQL search, ADF text extraction, API-token/Basic-Auth + OAuth 3LO), Linear adapter (GraphQL queries, cursor pagination, OAuth PKCE public-client), Intake Review UI (promote/ignore/clarify intake candidates), CLI OAuth connect + integration guide commands, shared OAuth callback infrastructure (fixed port 17530, server-side PKCE verifier store), 20 API route handlers |
| v0.14.0 | "Autonomous" — daemon & cron automation: standalone CLI daemon, in-process UI-controlled daemon engine, daemon-owned agents for Claude/Codex/OpenCode/Cursor/Gemini, worktree-backed session spawning, scheduler pulse nudges/digests, daemon status/setup UI |
| v0.15.0 | "The Habitat Remembers" — dynamic habitat skills: auto-generated living skill documents from pulse signals, task outcomes, and agent observations. Signal clustering, strength scoring, category classification (domain knowledge, conventions, patterns, anti-patterns). Hook registry for ingestion. MCP/CLI/UI integration. Skill context injected into agent mission context. |
| v0.16.0 | "Provenance" — code ↔ task linking (8 provenance tables, 7 evidence types, append-only corrections, completeness & gap tracking, repository settings, backfill) and time tracking & effort logging (deliberate effort entries separate from inferred time, correction audit trail, quality gate split, habitat effort metrics) |
| v0.17.0 | "Evidence" — Audit Trail V2 (canonical, provenance-aware audit projection across lifecycle, effort, code evidence, pipeline, integration, webhook, and opt-in health snapshot sources; scoped task/mission evidence bundles; integrity-ready archival) and Advanced Analytics (confidence-aware forecasting, trend analysis, cumulative-flow snapshots, bottleneck detection, sprint analytics, and informational-only agent quality signals) |
| v0.17.1 | "Deepen: Transition Core" — TransitionEmitter deep module consolidating the 5-layer task transition side-effect chain (DB write → event → SSE → watcher → mission recalc) into one `emitTransition` seam across 5 caller files (16 actions, opt-in mission recalc debounce); and API Client Domain Split defining 23 per-domain interfaces with `KanbanApiClient` as the typed facade, per-domain mock factories (33% → 100% method coverage), and `getMissionContext` extracted to a standalone orchestrator service |
| v0.17.2 | "Tighten: Effort and Notification Plumbing" — effort metrics recompute on complete/approve (FU-001 correctness fix), `NOTIFY_TASK_EVENT_ACTIONS` consumer audit constant, 13 MCP handler files narrowed to per-domain interfaces, `ORCY_TRANSITION_RECALC_DEBOUNCE` env documentation, 194 `@requires` JSDoc tags across 25 MCP tool files |
| v0.17.3 | "Prep: Event Spine" — SSE Event Registry: centralized event handler pattern replacing the triple-switch (Zustand mutation, React Query invalidation, toast/dropdown notification) across all SSE event types. New events registered once and covered by completeness tests. Foundation that v0.18 automation and Notification V2 event types build on. |
| v0.18.0 | "Rules That Act" — Workflow Automation Engine (12 trigger types, 9 action types, condition evaluation with AND/OR/NOT nesting, simulation, cooldown/fingerprint/rate-limit guards, scheduled scans), Notification System V2 (subscriptions, channel routing, in-app/webhook/Slack/Discord delivery, acknowledgment/snooze/mute, digests with hourly/daily/weekly cadence, retention-based clearance), MCP self-service surfaces (read-only automation, self-service notifications), UI automation settings tab, REST routes, audit projection |
| v0.18.1 | "Deepen: Data Access" — 64 direct `getDb()` calls eliminated across 11 target services, 6 new repository files, `dependencyService`/`anomalyService`/`auditExportService`/`predictionService`/`notificationService`/`syncService`/`webhook-subscriptions`/`webhook-delivery`/`webhook-dispatch`/`auditArchivalService`/`sprintService`/`boardHealthService` all at zero `getDb()`, `task.ts` and `daemon.ts` repository splits, 4 v0.18 review fixes |
| v0.18.2 | "Deepen: Route Extraction" — Pulse posting handlers (2×110 lines → 17 each), intake candidate promotion (55 lines → 14), daemon register + claim-next (2×65 lines → 12 each), Jira/Linear OAuth completion flows, auth register/me/setup extraction, mission progress deduplication |
| v0.18.3 | "Deepen: Single Cache" — Zustand → React Query for all server data (agents, comments, missions, board/columns, tasks). 5 mutation hooks de-dual-written. 14 SSE zustand blocks removed. Zustand now holds only ephemeral UI state (modals, theme, presence, pagination) |

---

## Upcoming

### v0.19.0 — "Public Surface"

Make Orcy safer to integrate with from outside its own UI and MCP server.

| Feature | Problem it solves |
|---------|-------------------|
| SSO / Auth Providers | Adds external login, account linking, scope groundwork, and cleaner separation of human/agent/integration identities |
| API Public Surface | Defines stable public API boundaries, versioning, scoped API keys, pagination, idempotency, webhooks, and SDK direction |

**Why together:** External consumers need scoped identity before the API becomes a durable platform contract. Public API work without auth/scope foundations would bake in weak boundaries.

Planning seeds: `docs/plans/v3/07-sso-auth-providers.md`, `docs/plans/v3/08-api-public-surface.md`

---

### v0.20.0 — "Orchestrated"

First-class multi-agent workflow patterns: handoffs, fan-out/fan-in, review chains, deploy chains, and conditional branches.

| Feature | Problem it solves |
|---------|-------------------|
| Agent Orchestration Platforms | Lets Orcy define and visualize multi-agent execution flows instead of relying on manual sequencing or prompt discipline |

**Why here:** Orchestration depends on daemon runtime, workflow automation, notifications, identity/scopes, and public API stability. It should be built after those foundations exist.

Planning seed: `docs/plans/v3/09-agent-orchestration-platforms.md`

**Architecture prereq folded in:**

| Architecture | Why here, not a patch |
|--------------|----------------------|
| API → Daemon Interface Seam (#7) | Break the circular dependency (API imports daemon runtime classes directly). Consolidate shared types (`CliType`→`AgentType`, `SessionStatus`, `ClaimResult`) into `@orcy/shared`. Define `ISessionManager` interface so the daemon becomes a swappable adapter. Orchestration builds on a clean daemon seam — fixing this after would mean reworking orchestration's foundation. |

---

### v0.20.1 — "Deepen: Trim Pass-Throughs"

Remove modules that fail the deletion test — complexity would vanish, not reappear in callers.

| Architecture | What deepens |
|--------------|--------------|
| Pass-Through Elimination (#8) | Inline `watcherService` pass-throughs, remove `task-movement.ts` (unused params, read-named-as-write), delete misleading aliases in `task-details.ts`. Auto-generate the ~70% of MCP tool handlers that are pure forwarding wrappers from a declarative config. |

**Why after v0.20:** All major seams have been deepened through v0.17.1–v0.20.1. The remaining shallow modules are pure cleanup with no feature dependency — good timing for a final sweep before the ecosystem and knowledge base layers.

---

### v0.21.0 — "Living Library"

Add an authored, editable, searchable knowledge layer above Pulse signals, project insights, and dynamic habitat skills.

| Feature | Problem it solves |
|---------|-------------------|
| Knowledge Base / Habitat Wiki | Provides long-form pages, hierarchy, search, versioning, cross-links, mission outcome summaries, and an insights browser |

**Why here:** Pulse already captures signals and insights; v0.15 generates habitat skills from patterns. The wiki should come after provenance and audit links exist, so knowledge can connect to missions, tasks, code artifacts, and outcomes.

Planning seed: `docs/plans/v3/10-knowledge-base-habitat-wiki.md`

---

### v0.22.0 — "Ecosystem"

Turn Orcy's matured internal extension seams into a safe plugin platform.

| Feature | Problem it solves |
|---------|-------------------|
| Plugin System V2 | Adds plugin manifests, configuration, safe context, lifecycle interceptors, dynamic MCP extension points, custom signals, conditions/actions, notification channels, integration adapters, and background jobs |

**Why last:** Plugin surfaces should be extracted from mature internal patterns, not guessed early. By this point Orcy has integrations, automation, notifications, auth scopes, public APIs, knowledge, and audit trails worth exposing safely.

Planning seed: `docs/plans/v3/11-plugin-system-v2.md`

---

### Architecture Deepening (2026-06-04 Review)

Patch releases dedicated to deepening shallow modules into deep ones — better locality, leverage, and testability. Feature releases stay feature-focused; architecture work lands in patch releases after the feature stabilizes.

| Patch | Candidates | Stressed seam |
|-------|-----------|---------------|
| v0.17.1 | TransitionEmitter (#1), API Client Split (#2) | Task lifecycle side-effects, MCP+UI client surface area |
| v0.17.3 | SSE Event Registry (#4) | Event handling — prereq for automation + notification events |
| v0.18.1 | Data Access Discipline (#3), Fat Route Extraction (#6), Dual-Write Consolidation (#5) | Repo layer, route→service boundary, Zustand vs React Query |
| v0.20.0 (folded) | API → Daemon Interface Seam (#7) | Cross-package dependency — prereq for multi-agent orchestration |
| v0.20.1 | Pass-Through Elimination (#8) | Dead indirection cleanup |

Full report: `/tmp/architecture-review-20260604.html`

---

### Future Cross-Cutting Seeds

These are intentionally unscheduled until their prerequisite foundations are in place.

| Seed | Why it waits |
|------|--------------|
| Learning Loop / Data Extraction (`docs/plans/v3/12-learning-loop-data-extraction.md`) | Depends on canonical audit history, durable knowledge surfaces, automation rules, and plugin/source extension points before Orcy can safely extract insights from accumulated data and feed them back into knowledge, recommendations, rules, and agent context. |
