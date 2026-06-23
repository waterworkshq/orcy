# Orcy — Product Roadmap

> **Version:** v0.20.0 | **Updated:** 2026-06-22

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
| v0.19.0 | "Pod Bridge" — Remote participant identity (external identity providers, pod trust model, participant standing), scoped habitat access (grants, credentials, invite flows), Shared Habitat API (`/api/shared/*` — discovery, missions, tasks, comments, pulse, evidence, notifications, trust metadata), remote MCP mode (action allowlist, `X-Orcy-Remote-Key` auth), idempotent write contracts, admin surface (readiness checks, provider config, grant management, webhook endpoints), audit provenance (remote actor labels, provenance block, export filters), UI management surface (Remote Pods page, inline attribution) |
| v0.19.1 | "Deepen: API → Daemon Interface Seam" — Shared daemon types (`SessionStatus`, `ClaimResult`, `DetectedCli`, `RegisteredAgent`, `ActiveSession`, `ISessionUpdater`, `WorkdirError`) moved to `@orcy/shared`. Six seam interfaces (`ISessionManager`, `ISessionUpdater`, `ICliDetector`, `IClaimStrategy`, `IHeartbeatStrategy`, `IPollLoop`) defined in shared. `runPollTick` consolidated pure async function replacing duplicated tick loops in daemon and API. `InProcessClaimStrategy` + `HttpClaimStrategy` strategy classes. API's `daemon-wiring.ts` DI module with dynamic import. Zod schemas derived from `AGENT_TYPES` runtime array. `@orcy/daemon` moved to devDependencies. 54 new tests (interface-compliance + seam + poll + factory + wiring) |
| v0.19.2 | "Deepen: Documentation Pass" — CONFIGURATION.md updated with 17 missing env vars, 3 stale removed, JWT_SECRET security doc bug fixed. ARCHITECTURE.md gained Daemon Runtime Seam + Audit Trail V2 sections. DATABASE.md gained 8 automation/notification table entries. 28 JSDoc blocks added to daemon seam public APIs. TESTING.md gained 5 test pattern sections + UI test count fix. TROUBLESHOOTING.md gained 8 entries across security, remote pods, notifications, daemon. README/CAPABILITIES/SKILL refreshed: MCP count 15→16, Pod Bridge features added, dispatch tools completed |
| v0.19.3 | "Deepen: Inline JSDoc Pass" — Comprehensive inline JSDoc coverage across all 6 packages. Shared types (245 symbols across 18 files), API services (~600 symbols across 130+ files including tasks/, webhooks/, integrations/, code evidence, notifications, automation, audit, and core services), MCP dispatch handlers and tools (~310 symbols), daemon runtime (~60 symbols), and CLI commands (16 symbols). Every exported symbol now has an IDE-visible description. Pod Bridge domain types restored with full design rationale and scope notes. |
| v0.20.0 | "Orchestrated" — Mission-scoped workflow DAGs with typed gates (`on_complete`, `on_approve`, `on_signal`, `on_manual`, `on_fail`), `all_of`/`any_of`/`n_of` join specs, and conditional edge predicates reusing v0.18 AutomationCondition. Workflow gates layer on the existing claim path as derived constraints — no new task status, no changes to IClaimStrategy or runPollTick. `on_fail` gates spawn recovery tasks with structured FailureContext (artifacts, lifecycle events, experience signals, retry history); successful recovery redeems the original failure and downstream gates fire as if the original had succeeded. Two recovery attempts maximum. Agent experience self-reporting via `orcy_pulse` with `signalType: "experience"` and 7 categories (`stuck\|confused\|backtrack\|surprised\|ambiguous\|sidetracked\|smooth`); signals flow through the existing pulse pipeline into habitat skills and failure contexts. Workflow templates extend `missionTemplates` with a `workflowTemplate` JSON column; two default templates shipped (Build-Test-Review-Deploy, Parallel Investigation). Form-based UI editor with JSON import/export, live SVG preview, workflow DAG visualization on mission detail page, blocked-by-workflow filter, admin metrics dashboard, and cross-pod read-only workflow context routes. |

---

## Upcoming

### v0.20.1 — "Orchestration Patch"

Strict-scope patch release bundling two deferred items from v0.20.0:

| Item | Why it waits for a patch |
|------|--------------------------|
| Wire `executeActions` into `automationEventService.ingestEvent` + `automationScanService` scan functions | Pre-existing v0.18 bug; not part of the v0.20 "Orchestrated" story; needs focused testing across all action types (notify, create_signal, create_task, change_priority, assign, release_assignment, request_review, call_webhook, mark_risk) |
| Add `on_automation` gate type + `onAutomationRunCompleted` subscriber hook | Depends on executor wiring; once rules actually execute in production, gates can subscribe to their completion |
| Workflow service subscription to automation runs | Final piece of the gate-type set (brings v0.20 to the originally-planned 6 gate types) |
| Add `anti_patterns` to `SkillCategory` enum + consolidate to `@orcy/shared` | Completes the experience-signal-to-skill-type mapping; v0.20.0 mapped `sidetracked → pitfall` as a stopgap; same duplication pattern as signalType (6+ local copies) |
| Enable `on_automation` in workflow editor UI + kill switch (UI/CLI toggleable) | Gate type is in dropdown but disabled; activating backend requires enabling it in editor + adding AutomationMatch form fields. Kill switch lets users disable action execution without env vars. |

**Why a patch, not part of v0.20.0:** Wiring `executeActions` is a behavior change for all existing v0.18 automation rule consumers — every rule that "matched but didn't fire" will now actually fire. That deserves its own release boundary and release notes, not coupling to the larger v0.20 feature set.

**Full scope reference:** `docs/plans/v20/PATCH-v0.20.1.md`

---

### v0.20.2 — "Deepen: Trim Pass-Throughs"

Remove modules that fail the deletion test — complexity would vanish, not reappear in callers.

| Architecture | What deepens |
|--------------|--------------|
| Pass-Through Elimination (#8) | Delete dead-code `task-movement.ts` (zero callers) + misleading aliases in `task-details.ts` (zero callers). Inline `watcherService` pass-throughs into routes. MCP forwarding-handler auto-generation deferred to later patch. |

**Why after v0.20.1:** Staggered per release-boundary decision — behavior-change patch (v0.20.1) ships separately from cleanup patch (v0.20.2). All major seams have been deepened through v0.17.1–v0.20.1; remaining shallow modules are pure cleanup with no feature dependency.

**Full scope reference:** `docs/plans/arch-cleanup/08-pass-through-elimination.md`

---

### v0.21.0 — "Living Library"

Add an authored, editable, searchable knowledge layer above Pulse signals, project insights, and dynamic habitat skills.

| Feature | Problem it solves |
|---------|-------------------|
| Knowledge Base / Habitat Wiki | Provides long-form pages, hierarchy, search, versioning, cross-links, mission outcome summaries, and an insights browser |
| Implicit Signal Surfacing | Surfaces two signal classes as distinct knowledge categories in the habitat wiki: agent experience signals (stuck, confused, etc.) AND engineering findings (structured codebase observations on existing `signalType: "finding"` with metadata convention). Establishes the engineering-finding metadata convention (`findingKind`, `severity`, `affectedFiles`, `blocksCurrentWork`) that v0.23 implementation-finding triage depends on |

**Why here:** Pulse already captures signals and insights; v0.15 generates habitat skills from patterns. The wiki should come after provenance and audit links exist, so knowledge can connect to missions, tasks, code artifacts, and outcomes. Self-reported experience signals from v0.20 need a surface beyond the raw pulse feed — the wiki is the natural home. Engineering findings (already informally posted by agents via `signalType: "finding"`) gain structured metadata so they can surface as queryable, clusterable knowledge rather than buried in handoff markdown.

Planning seeds: `docs/plans/v3/10-knowledge-base-habitat-wiki.md`, `docs/plans/v3/14-implicit-signal-surfacing.md`

---

### v0.22.0 — "Ecosystem"

Turn Orcy's matured internal extension seams into a safe plugin platform.

| Feature | Problem it solves |
|---------|-------------------|
| Plugin System V2 | Adds plugin manifests, configuration, safe context, lifecycle interceptors, dynamic MCP extension points, custom signals, conditions/actions, notification channels, integration adapters, and background jobs |
| Custom Signal Detector Plugins | Lets teams build automated implicit signal detectors (regex, classifiers) as plugins that write into the pulse/skill pipeline, extending detection beyond agent self-reporting |

**Why last:** Plugin surfaces should be extracted from mature internal patterns, not guessed early. By this point Orcy has integrations, automation, notifications, auth scopes, public APIs, knowledge, and audit trails worth exposing safely. Signal detectors are a natural plugin type — they extend the self-reporting convention from v0.20 with automated pattern matching.

Planning seeds: `docs/plans/v3/11-plugin-system-v2.md`, `docs/plans/v3/15-custom-signal-detectors.md`

---

### v0.23.0 — "Triage"

Automate the detection and response to systemic agent pain points. When implicit signals cluster around a pattern, the system investigates, creates corrective work, and learns from resolutions.

| Feature | Problem it solves |
|---------|-------------------|
| Reactive Triage | Automation trigger on clustered implicit signals that auto-creates investigation missions with signal context, affected tasks, and suggested investigation steps |
| Proactive Triage | When a signal pattern matches a previously resolved triage, surface the historical resolution as a suggested fix before creating new investigation work |
| Agent Quality Triggers | Wire computed agent quality metrics (approval rate, rejection rate, cycle time) as automation triggers for habitat admin notification or review mission creation |
| Implementation-Finding Triage | Parallel triage workflow for engineering findings (structured `signalType: "finding"` with metadata). Spawns investigation agent that verifies, scopes, and recommends a bucket (`fix_now / defer_to_patch / defer_to_release / document_as_known_limitation`). Workflow is deterministic (no flagged finding gets orphaned); bucket decision stays human-in-the-loop for non-trivial cases. Builds on existing pulse finding signals, evidence-gap lifecycle pattern, and blocker auto-task routing — no new infrastructure |

**Why here:** Triage needs the full signal pipeline: self-reported experiences (v0.20), surfaced patterns (v0.21), and detected signals (v0.22). It also needs the automation engine (v0.18) and knowledge base (v0.21) for historical resolution lookup. Building triage before these foundations exist would mean automating on incomplete signal data.

Planning seed: `docs/plans/v3/16-reactive-proactive-triage.md`

---

### Architecture Deepening (2026-06-04 Review)

Patch releases dedicated to deepening shallow modules into deep ones — better locality, leverage, and testability. Feature releases stay feature-focused; architecture work lands in patch releases after the feature stabilizes.

| Patch | Candidates | Stressed seam |
|-------|-----------|---------------|
| v0.17.1 | TransitionEmitter (#1), API Client Split (#2) | Task lifecycle side-effects, MCP+UI client surface area |
| v0.17.3 | SSE Event Registry (#4) | Event handling — prereq for automation + notification events |
| v0.18.1 | Data Access Discipline (#3), Fat Route Extraction (#6), Dual-Write Consolidation (#5) | Repo layer, route→service boundary, Zustand vs React Query |
| v0.19.1 | API → Daemon Interface Seam (#7) | Cross-package dependency — prereq for multi-agent orchestration |
| v0.20.2 (upcoming) | Pass-Through Elimination (#8) | Dead indirection cleanup |

Full report: `/tmp/architecture-review-20260604.html`

---

### Future Cross-Cutting Seeds

These are intentionally unscheduled until their prerequisite foundations are in place.

| Seed | Why it waits |
|------|--------------|
| Learning Loop / Data Extraction (`docs/plans/v3/12-learning-loop-data-extraction.md`) | Depends on canonical audit history, durable knowledge surfaces, automation rules, and plugin/source extension points before Orcy can safely extract insights from accumulated data and feed them back into knowledge, recommendations, rules, and agent context. |
