# Orcy — Product Roadmap

> **Version:** v0.13.0 | **Updated:** 2026-05-26

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

---

## Upcoming

---

### v0.14.0 — "Autonomous"

Daemon & Cron Automation. Agents run themselves — no more manual launch.

| Component | What |
|-----------|------|
| Daemon | Local background process spawns and manages agent sessions |
| Cron Scheduler | Server-side scheduler nudges agents to work on a schedule |

**Why separate:** Largest single feature since the original build. Pulse proves the signal model the daemon depends on — let it bake first.

---

### v0.15.0 — "The Habitat Remembers"

Dynamic Habitat Skills. Each habitat auto-generates a living skill document from high-strength pulse signals — findings, patterns, decisions that multiple agents confirmed.

**Why last:** Depends on Pulse project insights existing and accumulating real data. Premature without usage patterns to tune the signal strength scoring against.

---

### v0.16.0 — "Provenance"

Connect Orcy work to the evidence it produces: code artifacts, branches, pull requests, changed files, and actual effort.

| Feature | Problem it solves |
|---------|-------------------|
| Code ↔ Task Linking | Shows which commits, PRs, files, CI/build results, and external code artifacts belong to each mission/task |
| Time Tracking & Effort Logging | Separates elapsed time from actual effort so analytics, forecasting, and cost signals have real input data |

**Why together:** Both create the operational evidence layer. Once Orcy knows what changed and how much effort it took, later audit, analytics, automation, and knowledge features can reason from facts instead of approximations.

Planning seeds: `docs/plans/v3/01-code-task-linking.md`, `docs/plans/v3/02-time-tracking-effort-logging.md`

---

### v0.17.0 — "Evidence"

Turn provenance into stronger history and forward-looking insight.

| Feature | Problem it solves |
|---------|-------------------|
| Audit Trail V2 | Evolves audit exports into richer, provenance-aware, potentially tamper-evident history |
| Advanced Analytics | Adds forecasting, trend analysis, quality/trust signals, bottleneck detection, and estimate accuracy |

**Why together:** Analytics should consume reliable history, not partial lifecycle timestamps. Audit Trail V2 establishes the normalized evidence model that advanced analytics can safely build on.

Planning seeds: `docs/plans/v3/03-audit-trail-v2.md`, `docs/plans/v3/04-advanced-analytics.md`

---

### v0.18.0 — "Rules That Act"

Move from rules that score work to rules that take action.

| Feature | Problem it solves |
|---------|-------------------|
| Workflow Automation Engine | Lets Orcy react to events with configured actions: escalate, notify, create tasks/signals, change priority, call webhooks, request reviews |
| Notification System V2 | Adds subscriptions, digests, channel routing, acknowledgments, mute/snooze, and escalation delivery |

**Why together:** Automation needs actions, and many high-value actions are notifications or escalations. The daemon/cron foundation gives these rules a runtime; Notification V2 makes them visible and controllable.

Planning seeds: `docs/plans/v3/05-workflow-automation-engine.md`, `docs/plans/v3/06-notification-system-v2.md`

---

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
