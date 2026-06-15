# Architecture Documentation

This document covers the system architecture, design decisions, key flows, and integration patterns.

> **Prerelease:** Orcy is in active `0.x` prerelease. Architecture, schema, and APIs may change between releases. Do not use prerelease Orcy for production workloads. See the [README](../README.md#️-prerelease--not-production-ready).

---

## System Overview

```
┌──────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code / Codex / OpenCode / Cursor / Gemini) │
│  MCP stdio transport                                     │
│  ┌──────────────────────────────────────────────────┐   │
│  │  MCP Server (16 dispatch tools)                      │   │
│  │  Features: list │ create │ get_context │ delete  │   │
│  │  Tasks: claim │ submit │ update │ heartbeat     │   │
│  │  Rules: get │ update │ evaluate                │   │
│  │  Scheduled: list │ create │ run                 │   │
│  │  Skill: get │ refresh │ contribute             │   │
│  │  Code Evidence: link │ list │ gaps │ resolve    │   │
│  └────────────────────┬─────────────────────────────┘   │
│                       │ HTTP (X-Agent-API-Key)           │
└───────────────────────┼──────────────────────────────────┘
                          ▼
                    Kanban API

┌──────────────────────────────────────────────────────────┐
│  Habitat → Missions → Tasks → Subtasks                     │
│  Missions flow through columns, tasks have state machine   │
│  Background intervals: stale detection, health snapshots, │
│    prioritization evaluation (5min), scheduled tasks (1m), │
│    daemon nudges/digests, in-process daemon engine       │
└──────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### API (`packages/api`)

| Layer | Directory | Responsibility |
|-------|-----------|---------------|
| Routes | `src/routes/` | HTTP parsing, validation, response formatting. Includes daemon machine routes (`/daemon/*`), human/UI daemon controls (`/daemons/*`), and habitat skill routes (`/habitats/:id/skill/*`) |
| Services | `src/services/` | Business logic, SSE broadcasting, webhook dispatch, AI features. Includes `featureService.ts`, `prioritizationService.ts`, `scheduledTaskService.ts`, `habitatSkillService.ts`, daemon nudges/digests, and `daemonEngine.ts` for the API in-process daemon runtime; `daemon-wiring.ts` provides lazy dynamic-import DI for the in-process daemon; `inProcessClaimStrategy.ts` implements the in-process claim path |
| Repositories | `src/repositories/` | Drizzle-backed data access (habitat, mission, task, column, agent, daemon, comment, template, webhook, event-mission, habitatSkill) |
| Models | `src/models/` | TypeScript types, Zod schemas. Includes `Mission`, `MissionWithProgress`, `MissionStatus` types |
| Middleware | `src/middleware/` | Authentication (API key + JWT), RBAC, team-based access |
| SSE | `src/sse/` | Event broadcaster (pub/sub) — broadcasts both task and mission events |
| DB | `src/db/` | Database initialization, Drizzle ORM schema (62+ tables including habitat_skills, habitat_skill_signals, code evidence tables) |
| Plugins | `src/plugins/` | Plugin system for extensibility |

### UI (`packages/ui`)

| Layer | Directory | Responsibility |
|-------|-----------|---------------|
| Pages | `src/pages/` | HabitatListPage, HabitatPage, MissionDetailPage |
| Components | `src/components/ui/` | Button, Badge, Card, Dialog, ErrorBoundary |
| Habitat | `src/components/habitat/` | Habitat, Column, TaskCard, TaskDetailPanel, DaemonSection, DaemonCard, DaemonSetupDialog, SkillPanel |
| Store | `src/store/` | Zustand state management + SSE handler |
| API | `src/api/` | Typed REST client |
| Lib | `src/lib/` | React Query hooks (`useHabitatData`, `useTaskData`) + cache key factory (`queryKeys`) |
| Hooks | `src/hooks/` | SSE connection management + React Query cache invalidation |
| Types | `src/types/` | TypeScript interfaces |

### MCP (`packages/mcp`)

| File | Responsibility |
|------|---------------|
| `src/index.ts` | MCP SDK server setup, tool registry |
| `src/tools/index.ts` | All tool exports + 13 dispatch tool files (15 MCP tools total, including instructions tools) |
| `src/tools/habitat-dispatch.ts` | Habitat dispatch: list, find, summary, metrics, settings, health, analytics, prioritization rules |
| `src/tools/mission-dispatch.ts` | Mission dispatch: lifecycle, context, comments, code evidence, scoped audit bundle |
| `src/tools/task-dispatch.ts` | Task dispatch: lifecycle, CRUD, details, quality, subtasks, dependencies, effort, code evidence, scoped audit bundle |
| `src/tools/agent-dispatch.ts` | Agent dispatch: register, heartbeat, stats |
| `src/tools/sprint-dispatch.ts` | Sprint dispatch: lifecycle, mission membership, metrics, burndown, carry-over |
| `src/tools/review-dispatch.ts` | Review dispatch: review assignment rules and task reviewers |
| `src/tools/suggest-dispatch.ts` | Suggest dispatch: suggest-next-task |
| `src/tools/code-evidence.ts` | Code evidence handlers: link-code, list-code-evidence, correct-code-evidence-link, mark-not-applicable, clear-not-applicable, report-gap, resolve-gap, backfill (10 handler functions) |
| `src/tools/instructions.ts` | Hierarchical agent workflow instructions |
| `src/api.ts` | REST API client (OrcyApiClient) |

---

## Habitat Skill Architecture

Each habitat auto-generates a living skill document from high-strength pulse signals, task outcomes, and agent observations. The system clusters signals by topic, scores them for strength, and promotes high-confidence signals into the skill document.

### Signal Ingestion

Signals are ingested from three sources:

1. **Pulse signals** — findings, blockers, warnings, directives posted by agents and humans
2. **Task events** — completed, approved, rejected, failed task outcomes
3. **Task comments** — review feedback, discussion threads

Each signal is normalized into a `cluster_key` (e.g., "auth-jwt-signing") and merged with existing signals on `(habitat_id, cluster_key)`.

### Signal Scoring

Strength is a composite 0-1 score from four dimensions:

| Dimension | Weight | Input |
|-----------|--------|-------|
| Frequency | 30% | How often this cluster has been seen |
| Corroboration | 30% | Number of distinct agents confirming |
| Cross-mission | 20% | Number of distinct missions this signal spans |
| Outcome | 20% | Ratio of successful to failed associated tasks |

### Skill Categories

Signals are classified into one of four categories:

| Category | Criteria | Description |
|----------|----------|-------------|
| `domain_knowledge` | frequency ≥ 3 and corroboration ≥ 2 | Confirmed technical knowledge |
| `convention` | frequency ≥ 3 and corroboration ≥ 2 | Established team practices |
| `pattern` | frequency ≥ 3 and cross-mission ≥ 2 | Cross-cutting patterns |
| `anti_pattern` | failed tasks > successful tasks | Things that consistently fail |

### Promotion & Demotion

- Signals with strength ≥ 0.6 are promoted (`promotedToSkill = 1`) and included in the generated document
- Signals with strength < 0.2 are demoted and excluded
- The skill document is regenerated on refresh or after significant signal changes

### Hook Registry Pattern

Domain functions expose lifecycle hooks (`onHabitatCreated`, `onTaskCompleted`, etc.) that the skill service registers consumers for. Domain code remains unchanged — consumers write to their own tables only, preventing circular signal creation.

### MCP Integration

The `orcy_habitat_skill` dispatch tool exposes three actions:

| Action | Description |
|--------|-------------|
| `get` | Retrieve the current skill document for the habitat |
| `refresh` | Trigger async regeneration of the skill document |
| `contribute` | Submit a direct insight to the skill system |

Skill context is automatically injected into `getMissionContext()` responses, so agents receive habitat knowledge when claiming tasks.

### Component Layout

```
packages/api/
  src/db/schema/habitat-skill.ts              — Drizzle schema (2 tables)
  src/repositories/habitatSkill.ts             — CRUD + signal queries
  src/services/habitatSkillService.ts          — Ingestion, scoring, category classification, document generation
  src/routes/habitatSkill.ts                   — 5 API endpoints
packages/mcp/
  src/tools/habitat-skill.ts                   — 3 MCP handler functions
  src/tools/habitat-skill-dispatch.ts          — Dispatch tool + handler map
packages/cli/
  src/commands/skill.ts                        — 4 CLI commands (get, refresh, contribute, signals)
packages/ui/
  src/components/habitat/SkillPanel.tsx         — Collapsible panel with Document/Signals tabs
```

---

## Code Evidence Provenance

Promotes existing PR/MR, pipeline, worktree branch, and artifact foundations into an explicit, queryable code evidence layer. Instead of treating pull requests and CI runs as opaque attachments, the code evidence system decomposes them into structured, linkable entities that can be queried for completeness and gap analysis.

### Architecture

The code evidence layer uses a **hybrid model**: concrete evidence tables store normalized data from Git providers (branches, commits, changed files, reviews), while a central `code_evidence_links` table provides polymorphic metadata linking evidence to any Orcy entity (mission, task, or subtask).

```
┌─────────────────────┐       ┌─────────────────────┐
│ habitat_code_        │       │ code_evidence_       │
│ repositories         │       │ completeness         │
│ (1:1 per habitat)    │       │ (not-applicable      │
│                      │       │  overrides +         │
│ provider, repoSlug,  │       │  derived status)     │
│ verificationState    │       └─────────────────────┘
└──────────┬──────────┘
           │ (repositoryId)
           ▼
┌─────────────────────┐       ┌─────────────────────┐
│ code_branches        │──────<│ code_commits         │
│                      │       │                      │
│ name, headSha,       │       │ sha, message,        │
│ baseBranch,          │       │ authorName/Email,    │
│ createdFromTaskId    │       │ verificationState    │
└──────────┬──────────┘       └──────────┬──────────┘
           │                              │
           │ (branchId)                   │ (commitId)
           ▼                              ▼
┌─────────────────────┐       ┌─────────────────────┐
│ code_changed_files   │       │ code_reviews         │
│                      │       │                      │
│ path, previousPath,  │       │ reviewStatus,        │
│ changeType,          │       │ reviewerName         │
│ additions, deletions │       └─────────────────────┘
└─────────────────────┘

           ┌─────────────────────┐
           │ code_evidence_links │  ← Core link table
           │                     │    (polymorphic: mission/task/subtask → evidence)
           │ targetType,         │
           │ targetId,           │
           │ evidenceType,       │
           │ evidenceId,         │
           │ status, confidence, │
           │ linkSource          │
           └─────────────────────┘

           ┌─────────────────────┐
           │ code_evidence_gaps   │  ← Gap lifecycle
           │                     │
           │ reasonCode,         │
           │ status              │    (active/resolved)
           │ resolutionReason    │
           └─────────────────────┘
```

### Key Tables

| Table | Purpose |
|-------|---------|
| `habitat_code_repositories` | One row per habitat — canonical repository identity (provider, repoSlug, verificationState) |
| `code_branches` | Branch evidence (name, headSha, baseBranch, createdFromTaskId) |
| `code_commits` | Commit evidence (sha, message, authorName/Email, verificationState) |
| `code_changed_files` | Changed file snapshots per commit (path, previousPath, changeType, additions, deletions) |
| `code_reviews` | Review evidence (reviewStatus, reviewerName) |
| `code_evidence_links` | Core polymorphic link table — connects missions/tasks/subtasks to evidence entities |
| `code_evidence_completeness` | Not-applicable overrides + derived completeness status per target |
| `code_evidence_gaps` | Gap lifecycle tracking (reasonCode, status active/resolved, resolutionReason) |

### URL Parsing

Code evidence is extracted from provider URLs without API calls:

| Provider | URL Pattern | Evidence Extracted |
|----------|------------|-------------------|
| GitHub | `github.com/owner/repo/pull/123` | PR → branch, commit, changed files, review |
| GitHub | `github.com/owner/repo/commit/abc123` | Commit → changed files |
| GitHub | `github.com/owner/repo/actions/runs/456` | CI run → commit, branch |
| GitLab | `gitlab.com/owner/repo/-/merge_requests/123` | MR → branch, commit, changed files, review |
| GitLab | `gitlab.com/owner/repo/-/commit/abc123` | Commit → changed files |
| GitLab | `gitlab.com/owner/repo/-/pipelines/456` | Pipeline → commit, branch |

### Evidence Linking Sources

Every evidence link records its provenance via `linkSource`:

| Source | Description |
|--------|-------------|
| `webhook` | Automatically linked via GitHub/GitLab webhook handler |
| `branch_pattern` | Matched by worktree branch naming convention |
| `commit_trailer` | Detected from commit message metadata (e.g., `Task-Id:` trailer) |
| `agent_reported` | Submitted by an AI agent via MCP dispatch action |
| `human_manual` | Manually linked by a human through the UI or API |
| `migration` | Created during data migration from attachment-based provenance |
| `api` | Created via direct API call |
| `artifact_mirror` | Backfilled from existing `pull_requests` / `pipeline_events` tables |

### Completeness Derivation

Completeness status is derived per target (mission/task/subtask) by evaluating active evidence links against expected evidence types:

| Status | Condition |
|--------|-----------|
| `complete` | All expected evidence types have active links |
| `partial` | Some but not all expected evidence types have active links |
| `missing` | No active evidence links for any expected type |
| `not_applicable` | Explicit override via `code_evidence_completeness` table (with reasonCode) |
| `unknown` | Target has no defined evidence expectations |

### Append-Only Corrections

Evidence links use an append-only correction model rather than mutations:

| Correction | Effect |
|------------|--------|
| `superseded` | Link replaced by a newer, more accurate link |
| `incorrect` | Link was wrong (with reason and actor who corrected it) |
| `removed` | Link no longer relevant (with reason and actor) |

Original links are never deleted — corrections create new link records with `status` set to the correction type, preserving the full audit trail.

### Non-Blocking Webhook Integration

Evidence linking in webhook handlers (GitHub Issues, GitLab MR, CI/CD pipelines) is wrapped in `try/catch` blocks. A failure to create evidence records does not block the primary webhook operation (mission sync, pipeline status update). Evidence linking failures are logged but never cause webhook handler errors.

### Lazy Backfill

Existing PRs and pipeline events created before the code evidence layer receive evidence links via `backfillExistingCodeEvidence()`. This function:

1. Queries existing `pull_requests` and `pipeline_events` rows
2. Parses stored URLs to extract provider, repository, branch, and commit metadata
3. Creates evidence records (branches, commits, changed files, reviews) and links them to the corresponding tasks/missions
4. Runs idempotently — re-running does not create duplicate evidence

### Component Layout

```
packages/api/
  src/db/schema/code-evidence.ts            — Drizzle schema (8 tables)
  src/repositories/codeEvidence.ts           — CRUD + evidence queries + completeness derivation
  src/services/codeEvidenceService.ts        — URL parsing, linking, backfill, gap management
  src/routes/codeEvidence.ts                 — API endpoints for evidence operations
packages/mcp/
  src/tools/code-evidence.ts                 — 10 MCP handler functions
  src/tools/task-dispatch.ts                 — code evidence + scoped audit bundle actions
  src/tools/mission-dispatch.ts              — code evidence + scoped audit bundle actions
```

**Decision:** Use `better-sqlite3` for production storage; `sql.js` (WASM) only for test environments.

**Rationale:**

- Native SQLite bindings provide better production behavior than sql.js
- Zero external database dependency — file-based with WAL mode
- Easy to reset (delete `orcy.db`)
- Drizzle ORM provides cross-database support (SQLite/PostgreSQL via dialect)

**Trade-offs:**

- No concurrent write support under heavy load
- No replication or clustering
- SQLite-specific SQL (not portable to PostgreSQL without dialect changes)

### ADR-3: SSE over WebSocket

**Decision:** Use Server-Sent Events for real-time updates.

**Rationale:**

- Unidirectional (server → client) is all we need
- Native browser support via `EventSource`
- Simpler than WebSocket for this use case
- Works through most proxies with proper headers

**Trade-offs:**

- No bidirectional communication
- Some proxy configurations may buffer events

### ADR-4: Zustand over Redux

**Decision:** Use Zustand for UI state management.

**Rationale:**

- Minimal boilerplate
- Built-in selector optimization
- Easy SSE integration — `handleSSEEvent` updates store directly
- No middleware complexity

### ADR-5: Parameterized SQL over ORM — [OBSOLETE]

**Decision:** Use raw parameterized SQL queries instead of an ORM.

**Rationale:**

- Full control over query performance
- No ORM abstraction leaks
- Direct mapping to SQLite capabilities
- Easier to reason about for simple queries

**Trade-offs:**

- More verbose than ORM equivalents
- Schema changes require manual SQL updates

### ADR-6: Append-Only Event Log

**Decision:** Task events are immutable and append-only.

**Rationale:**

- Complete audit trail for debugging and compliance
- Event sourcing foundation for future features
- No data loss from updates

**Trade-offs:**

- Event table grows unboundedly
- No "delete event" capability (intentional)

### ADR-7: Drizzle ORM with better-sqlite3

**Decision:** Migrate from raw parameterized SQL to Drizzle ORM with better-sqlite3 as the primary database driver.

**Rationale:**

- Type-safe schema definition with automatic TypeScript type inference
- Cross-database support via dialect helpers (SQLite/PostgreSQL)
- Drizzle Kit for schema management
- Native SQLite bindings provide superior production behavior to sql.js
- Still allows raw SQL for complex queries when needed

**Trade-offs:**

- Additional abstraction layer
- Learning Drizzle API required
- PostgreSQL support requires driver switching via `setDriver('postgres')`

### ADR-8: React Query for Server State Caching

**Decision:** Use React Query (`@tanstack/react-query`) for server state caching, layered alongside Zustand for real-time UI state.

**Rationale:**

- React Query eliminates redundant API requests via intelligent deduplication and caching
- Stale-while-revalidate pattern keeps UI responsive without over-fetching
- Built-in cache invalidation hooks integrate cleanly with SSE events
- `retry: false` on 429 errors prevents retry storms that amplify rate limiting

**Batched Endpoints Pattern:**

To avoid a cascade of parallel requests when opening a task detail panel, endpoints are consolidated. The `GET /tasks/:id/details` endpoint returns everything needed in one call:

```ts
{
  task, subtasks, pullRequests, pipelineEvents, events,
  comments, totalComments,
  attachments, watchers, isWatching,
  mission, siblingTasks,
  dependencies, blockedBy, blocking, habitatContext
}

Similarly, `GET /missions/:id/details` returns mission + tasks + events + progress in one call.

**Trade-offs:**

- Two caching layers (Zustand + React Query) requires keeping both in sync on SSE events
- Cache invalidation must cover all keys; SSE hook invalidates both `tasks.detail` and `tasks.details`
- React StrictMode doubles effect execution in dev — batching absorbs this overhead

### ADR-9: Hierarchical Kanban — Missions → Tasks → Subtasks

**Decision:** Replace the flat Habitat → Tasks model with Habitat → Missions → Tasks → Subtasks. Missions become the habitat-level cards; tasks become mission-internal work units.

**Rationale:**

- Aligns with how teams think about work — missions as deliverables, tasks as implementation steps
- Mission status auto-derived from child tasks eliminates manual status management
- Cleaner separation of concerns: missions own habitat position/timeline, tasks own agent assignment
- Mission-level dependencies are more meaningful than task-level cross-habitat deps

**Trade-offs:**

- Breaking change — no backward compatibility with flat task model
- Required restructuring the codebase
- Additional API complexity (13 new mission endpoints)
- Agents must learn mission-centric workflow (`orcy_habitat_mission({action:"get-context"})` before claiming)

### ADR-10: Mission Status Derivation Engine

**Decision:** Mission status is always derived from child task states. No manual status field.

**Rationale:**

- Eliminates status drift between missions and their tasks
- Single source of truth — task states drive everything
- Automatic column advancement keeps the habitat visually accurate
- Humans retain veto power via manual column override (POST /missions/:id/move)
- Completed work can be archived (`isArchived` flag) while retaining 'done' status for metrics, rather than introducing an 'archived' status in the state machine.

**Trade-offs:**

- Recalculation on every task state change (minimal performance impact)
- Edge case: empty missions default to `not_started`
- Mission status changes are side effects, not directly triggered

---

## Hierarchical Model Architecture

### Entity Responsibility Matrix

| Concern | Mission | Task | Subtask |
|---------|---------|------|---------|
| Habitat column position | Yes | No | No |
| State machine | No (derived) | Yes | No |
| Agent assignment | No (deferred) | Yes | No |
| Result / artifacts | No | Yes | No |
| Comments | No (on tasks) | Yes | No |
| Events / audit trail | Yes (mission-level) | Yes (task-level) | No |
| Dependencies | Yes (cross-mission) | Yes (within-mission) | No |
| Priority | Yes | Yes | No |
| Labels | Yes | No | No |
| SLA / due date | Yes | No | No |
| Estimated time | No | Yes | No |
| Progress tracking | Derived from tasks | Boolean per state | Boolean |

### MCP Tool Architecture (Consolidated Dispatch Pattern)

The MCP server exposes **13 dispatch tools** with dozens of action-routed operations (plus `orcy_instructions` and `orcy_pulse_instructions` standalone tools). Each dispatch tool accepts an `action` parameter to route to specific operations:

| Dispatch Tool | Actions | Purpose |
|---------------|---------|---------|
| `orcy_habitat` | `list`, `find`, `summary`, `metrics`, `get-settings`, `update-settings`, `get-health`, `get-health-history`, `predictions`, `bottlenecks`, `agent-quality`, `get-rules`, `update-rules`, `evaluate-rules` | Habitat-level operations, health, analytics, and prioritization rules |
| `orcy_habitat_mission` | `list`, `create`, `delete`, `archive`, `unarchive`, `get-context`, comments, code evidence, `get-audit-bundle` | Mission lifecycle, context, code evidence, and scoped audit bundles |
| `orcy_habitat_task` | lifecycle, CRUD, detail, quality, subtasks, dependency, effort, code evidence, `get-audit-bundle` | Task lifecycle, evidence, effort, quality, and scoped audit tools |
| `orcy_habitat_agent` | `register`, `list`, `heartbeat`, `get-stats` | Agent management |
| `orcy_suggest` | `suggest-next-task` | AI-ranked task suggestions |
| `orcy_habitat_message` | `send`, `get-messages` | Agent-to-agent messaging |
| `orcy_pulse` | `post`, `check` | Mission signal board — post findings, blockers, directives; check partner signals |
| `orcy_habitat_subscription` | `subscribe`, `unsubscribe` | Real-time notifications |
| `orcy_admin` | `list-webhooks`, `create-webhook`, `list-templates`, `batch-assign-tasks`, `export-audit-log`, `get-audit-summary`, `list-scheduled-tasks`, `create-scheduled-task`, `run-scheduled-task` | Admin operations + scheduled tasks |
| `orcy_worktree` | `get-worktree` | Git worktree info |
| `orcy_habitat_skill` | `get`, `refresh`, `contribute` | Dynamic habitat skills — get skill document, trigger regeneration, submit direct insights |
| `orcy_sprint` | `list`, `get`, `get_active`, `get_metrics`, `get_burndown`, `get_carry_over`, lifecycle and mission membership actions | Sprint planning, lifecycle, and analytics |
| `orcy_review` | `list_rules`, `create_rule`, `update_rule`, `delete_rule`, `list_reviewers`, `add_reviewer`, `remove_reviewer` | Review rules and task reviewer assignment |
| `orcy_instructions` | (tool) | Returns orcy skill guide |

### Pulse Signal Architecture

Pulse adds a structured signal layer on top of the existing task state machine. Signals flow as follows:

```
Agent / Human
  │
  ├─► orcy_pulse({action: "post", missionId, signalType, subject})
  │     │
  │     ├─► POST /api/missions/:id/pulse
  │     │     ├─► INSERT INTO pulses (missionId, habitatId, fromType, signalType, ...)
  │     │     ├─► IF signalType = 'blocker' → taskService.createTask("Clear Blocker: ...")
  │     │     └─► SSE broadcast: pulse.signal_posted
  │     │
  │     └─► Other agents discover via:
  │           ├─► mission_get_context() — pulse digest (counts + highlights)
  │           └─► orcy_pulse({action: "check", missionId}) — full signal list
  │
  └─► System auto-generates signals on task lifecycle events:
        ├─► claim → CONTEXT: "{agent} claimed '{title}'"
        ├─► submit → OFFER: "Results for '{title}' available"
        ├─► complete → CONTEXT: "{agent} completed '{title}'"
        ├─► fail → WARNING: "Task '{title}' failed: {reason}"
        ├─► release → CONTEXT: "Task '{title}' released"
        └─► blocker clearance done → CONTEXT: "Blocker cleared: {subject}"
```

**Key tables:** `pulses` (signal storage with deep-linking to missions, tasks, and other pulses) and `pulse_cursors` (per-reader per-mission last-checked timestamp). See [DATABASE.md](DATABASE.md) for the full schema.

---

## State Machines

### Task State Machine

Tasks use the following state machine. Two paths lead to `done`: the **gated path** (via `POST /tasks/:id/complete`) which validates quality gates and dependencies, and the **pod member override path** (via `POST /tasks/:id/approve`) which skips gates.

                    ┌──────────────────────────────────────────────┐
                    │                                              │
                    ▼                                              │
 ┌─────────┐  claim  ┌─────────┐  start  ┌────────────┐          │
 │ PENDING │────────>│ CLAIMED │────────>│ IN_PROGRESS │          │
 └────┬────┘         └────┬────┘         └──────┬─────┘          │
      │                   │                     │                 │
      │                   │  release            │ submit          │
      │                   └────────┐            │                 │
      │                            │            ▼                 │
      │                            │    ┌──────────┐              │
      │                            │    │ SUBMITTED│              │
      │                            │    └────┬─────┘              │
      │                            │         │                    │
      │                            │    ┌────┴──────┐             │
      │                            │    │           │             │
      │                            │  approve   complete          │
      │                            │ (no gates)  (gates ✅)      │
      │                            │    │           │             │
      │                            │    ▼           ▼             │
      │                            │  ┌──────────┐                │
      │                            │  │ APPROVED │──────┐         │
      │                            │  └────┬─────┘      │         │
      │                            │       │            │         │
      │                            │  complete    complete        │
      │                            │  (gates ✅)  (gates ✅)     │
      │                            │       │            │         │
      │                            │       ▼            ▼         │
      │                            │  ┌────────────────────┐      │
      │                            │  │       DONE         │      │
      │                            │  │    (terminal)      │      │
      │                            │  └────────────────────┘      │
      │                            │                              │
      │                            │         reject               │
      │                            │            │                 │
      │                            │            ▼                 │
      │                            │    ┌──────────┐              │
      │                            │    │ REJECTED │──start──> IN_PROGRESS
      │                            │    └──────────┘              │
      │                            │                              │
      │                   release  │            fail              │
      │<──────────────────────────┘            │                  │
      │                                        ▼                  │
      │                                  ┌────────┐               │
      │<───── retry ─────────────────────│ FAILED │               │
      │                                  └────────┘               │
      │                                                           │
      ▼                                                           │
 (re-claimable)                                                   │
                                                                  │
 Note: complete = POST /tasks/:id/complete (quality gates ✅)     │
       approve = POST /tasks/:id/approve (quality gates ❌)       │
 ────────────────────────────────────────────────────────────────┘

### Valid Transitions

| From | To | Trigger | Actor | Quality Gates |
|------|----|---------|-------|---------------|
| `pending` | `claimed` | `POST /tasks/:id/claim` | Agent | n/a |
| `claimed` | `in_progress` | `POST /tasks/:id/start` | Agent | n/a |
| `claimed` | `pending` | `POST /tasks/:id/release` | Agent/System | n/a |
| `in_progress` | `submitted` | `POST /tasks/:id/submit` | Agent | n/a |
| `in_progress` | `pending` | `POST /tasks/:id/release` | Agent | n/a |
| `in_progress` | `failed` | `POST /tasks/:id/fail` | Agent | n/a |
| `submitted` | `done` | `POST /tasks/:id/complete` | Agent | ✅ enforced |
| `submitted` | `approved` | `POST /tasks/:id/approve` | Human/System | ❌ skipped |
| `submitted` | `rejected` | `POST /tasks/:id/reject` | Human/System | n/a |
| `approved` | `done` | `POST /tasks/:id/complete` | Agent | ✅ re-checks |
| `rejected` | `in_progress` | `POST /tasks/:id/start` | Agent | n/a |
| `failed` | `pending` | Retry/System | System | n/a |
| `done` | — | Terminal state | — | — |

---

### Mission Status Derivation

Mission status is **auto-derived** from child task states. There is no manual status management.

```
Mission Status Derivation Rules:
─────────────────────────────────
not_started  ← all tasks are pending
in_progress  ← any task is claimed/in_progress/submitted/approved/rejected
review       ← all tasks are submitted/approved/done (none active)
done         ← all tasks are done/approved (at least one done)
failed       ← any task failed and none actively being worked on
```

### Column Auto-Advancement

After deriving mission status, the mission's column position is automatically updated:

```
Status → Column Mapping:
─────────────────────────
not_started  → first column (Backlog)
in_progress  → second column (In Progress)
review       → second-to-last non-terminal column (Review)
done         → terminal column (Done)
failed       → stays in current column (no auto-advance)
```

### Trigger Points

The derivation engine runs after every task state change:

| Task Service Method | Triggers Mission Status Derivation |
|---------------------|-------------------------------------|
| `claimTask()` | Yes |
| `startTask()` | Yes |
| `submitTask()` | Yes |
| `approveTask()` | Yes |
| `rejectTask()` | Yes |
| `completeTask()` | Yes |
| `failTask()` | Yes |
| `releaseTask()` | Yes |
| `createTask()` | Yes (may not change status) |
| `deleteTask()` | Yes (may change status) |

---

## Dependency Resolution

### Mission-Level Dependencies

Missions declare dependencies on other missions. Tasks inherit dependency filtering from their parent mission.

1. When creating a mission, specify `dependsOn: ["mission-uuid-1", "mission-uuid-2"]`
2. The `getAvailableTasksForAgent()` function checks mission-level dependencies via `mission_dependencies`
3. Tasks within a mission with unmet dependencies are not shown to agents
4. When a mission reaches `done` status, dependent missions become available

### Task-Level Dependencies (Within Mission)

Tasks can also have within-mission dependencies on sibling tasks:

1. `task_dependencies` table tracks within-mission task dependencies
2. `getAvailableTasksForAgent()` checks both mission-level and task-level dependencies
3. Within-mission dependencies are enforced at the application level

### Dependency Rules

- Mission-level dependencies only (no cross-mission task dependencies per ADR-005)
- Within-mission task dependencies allowed
- Circular dependencies are not detected at creation time — validate client-side
- Self-dependency prevented at database level via CHECK constraint

---

## Stale Task Detection

A background interval (60 seconds) checks for stale agents and releases their tasks:

1. Find all agents whose `lastHeartbeat` was > 30 minutes ago and whose status is not `offline`
2. Mark each stale agent as `offline` (clear their `currentTaskId`)
3. If the agent had a current task → release it back to `pending` (with reason `stale_timeout`)
4. Broadcast SSE events for the agent status change (to `'global'` channel) and task release (to habitat channel)

Configuration is in `packages/api/src/index.ts`:

- Stale threshold: 30 minutes (hardcoded in `releaseStaleTasks(30)`)
- Check interval: 60 seconds (`setInterval(..., 60_000)`)

---

## Prioritization Service

Dynamic prioritization rules engine that auto-recalculates task priority based on configurable conditions. Follows the `anomalyService` pattern: per-type evaluator functions + aggregator + SSE broadcast.

### Architecture

```
prioritizationService.ts
├── evaluateCondition(task, rule, context) — recursive, handles all 10 condition types + And/Or
├── evaluateRules(habitatId) — aggregates all rule evaluations for a habitat
├── applyPrioritization(habitatId) — orchestrator: fetch tasks, evaluate, apply actions, broadcast SSE
└── applyAllBoards() — batch iterator for background interval
```

### Condition Types

| Type | Evaluates |
|------|-----------|
| `overdue` | Task's mission past `dueAt` |
| `sla_approaching` | Mission `slaDeadlineAt` within threshold |
| `due_soon` | Mission `dueAt` within threshold |
| `pending_duration` | Task pending longer than threshold |
| `dependency_count` | Task blocked by N tasks |
| `rejection_count` | Task rejected N times |
| `feature_status` | Parent mission has specific status |
| `agent_idle` | No agent activity for N minutes |
| `label_match` | Mission has matching labels |
| `priority_is` | Task has specific priority |
| `and` / `or` | Compound conditions |

### Rule Actions

| Action | Effect |
|--------|--------|
| `set_priority` | Set task priority to specific level |
| `bump_priority` | Increase priority by N levels |
| `add_label` | Add label to mission |
| `set_score_bonus` | Boost sorting score |

### Background Interval

Prioritization rules evaluate every 5 minutes via `scheduler.ts`:

- Interval: 300,000ms (5 minutes)
- Only evaluates boards with `prioritizationSettings.enabled: true`
- Skips tasks in terminal states (`done`, `failed`)
- Broadcasts `task.priority_changed` SSE event when priority changes

### SSE Events

| Event | Trigger | Payload |
|-------|---------|---------|
| `task.priority_changed` | Rule engine adjusts priority | `{ taskId, ruleName, score }` |

---

## Scheduled Task Service

Recurring scheduled creation of missions and tasks from templates. Follows the `retryService` pattern with background polling.

### Architecture

```
scheduledTaskService.ts
├── processDueScheduledTasks() — polls for due tasks and executes them
├── executeScheduledTask(scheduledTask) — creates mission + tasks from template
├── calculateNextRun(scheduledTask) — computes nextRunAt using cron-parser
└── CRUD operations — create, update, delete, enable, disable
```

### Background Interval

Scheduled tasks are polled every 60 seconds via `scheduler.ts`:

- Interval: 60,000ms (1 minute)
- Polls `scheduled_tasks` where `nextRunAt <= now` AND `enabled = true`
- Each execution: creates mission from template → creates child tasks → updates `lastRunAt`/`nextRunAt`/`runCount`
- Catches up on missed executions after restart (polls all due, not just current tick)
- Wired to also process audit export schedules in the same polling loop

### SSE Events

| Event | Trigger | Payload |
|-------|---------|---------|
| `scheduled_task.executed` | Scheduled task creates mission | `{ scheduleId, missionId, missionTitle }` |
| `scheduled_task.failed` | Execution fails | `{ scheduleId, error }` |
| `scheduled_task.created` | New schedule configured | `{ scheduleId, name }` |

## External Integrations (v0.12)

### Intake Architecture

External issue trackers (GitHub Issues, eventually Jira/Linear) act as **intake surfaces**, not mirrored task boards. Orcy remains the execution system — external issues flow through an authority gradient:

```
external issue → intake candidate → refined mission → Orcy tasks
```

This is pull-first and downstream: `external issue → Orcy mission`. No default writeback to external trackers.

### Provider Posture by Default

| Provider | Default authority | Rationale |
|----------|-------------------|-----------|
| GitHub Issues | Direct mission import (toggle-controlled) | Usually close to technical execution work |
| Jira | Intake candidate | Highly variable ticket quality and stakeholder language |
| Linear | Intake candidate | Product/roadmap context, not always execution-ready |

GitHub can be configured for direct import (`autoImport: true`) during connection setup. Jira and Linear default to intake candidates that a human/orcy reviews before promoting to missions. The `external_intake_candidates` table holds reviewable source evidence — titles, descriptions, priority, labels, assignees, and raw provider payloads — without automatically creating missions.

### Source Evidence vs. Orcy Execution Authority

An external issue link (`external_issue_links`) is durable provenance, not canonical execution state. The Orcy mission owns its own lifecycle: status, priority, labels, task decomposition. External issue edits update linked missions (title, body, labels) but never overwrite Orcy-only state. The guarded close rule protects active work: an upstream issue closure only marks a mission `done` if all its tasks are terminal; otherwise it adds an `external-closed` label and sync warning.

### Sync Service

Located at `packages/api/src/services/integrations/syncService.ts`. Core responsibilities:

- **`syncConnection(id, trigger, adapter)`** — Full sync of all open issues from a provider. Creates a `integration_sync_run` record, iterates external issues, and delegates per-issue logic to `syncExternalIssue`. Updates connection last-sync state on completion.
- **`syncExternalIssue(connectionId, issue, trigger)`** — Per-issue import logic. Implements link-first idempotency: checks `external_issue_links` by connection/external-id before creating a mission. Creates new missions in the habitat's `Todo` column (or next available non-terminal column as fallback). Applies label provenance and guarded close behavior.

The sync service is provider-neutral — it accepts an `IssueProviderAdapter` interface. GitHub, Jira, and Linear adapters implement this interface. Tests use a fake adapter that returns synthetic issues.

### Adapter Interface

```typescript
interface IssueProviderAdapter {
  provider: string;
  listIssues(params: { owner: string; repo: string; state: string; }) → ExternalIssue[];
  getIssue(params: { owner: string; repo: string; issueNumber: number; }) → ExternalIssue | null;
}
```

The GitHub adapter (`githubAdapter.ts`) implements this with REST API calls, pagination handling, and pull request filtering.

### Webhook Flow

```
GitHub Issue Event → POST /webhooks/github/issues → webhookService.handleGitHubIssueWebhook()
  → Verify HMAC signature (constant-time)
  → Match repository owner/name to enabled connection(s)
  → Route event to syncExternalIssue (opened/reopened/edited) or guarded close (closed)
```

Supported events: `opened`, `reopened`, `edited`, `labeled`, `unlabeled`, `closed`. Unlinked issues with auto-import enabled are imported; without auto-import, unlinked events are no-ops. Pull requests in the issue payload are filtered out.

### Component Layout

```
packages/api/
  src/services/integrations/
    types.ts              — Adapter interface + result types
    syncService.ts        — Core sync logic (provider-neutral)
    githubAdapter.ts      — GitHub REST adapter + webhook creation
    githubOAuth.ts        — Device flow start/poll + viewer lookup
    webhookService.ts     — Webhook handler (HMAC verify → route)
    columnResolver.ts     — Find Todo/fallback column for imports
  src/repositories/
    integrationConnection.ts   — Connection CRUD + toView() mask
    externalIssueLink.ts       — Issue link CRUD
    integrationSyncRun.ts      — Sync run tracking
  src/routes/
    integrations.ts           — 9 API endpoints (CRUD, sync, OAuth, links)
    githubIssueWebhooks.ts    — Webhook route (raw body → verify → handle)
  src/db/schema/integration.ts — Drizzle schema for 4 tables
```

---

## Notification System V2 (v0.18)

Notification V2 replaces the legacy email-only `notification_preferences` with a durable attention system:

| Component | Responsibility |
|-----------|---------------|
| `notificationCommandService.ts` | Command seam — enqueues notifications through subscription resolution |
| `notificationSubscriptionResolver.ts` | Resolves habitat defaults + recipient overrides (required bypass, mute, cadence) |
| `notificationDeliveryService.ts` | Dispatches deliveries to channel adapters (in-app, webhook, Slack, Discord) |
| `notificationDigestService.ts` | Groups non-immediate deliveries into digest.ready events |
| `notificationClearanceService.ts` | Clears acknowledged/failed deliveries past retention windows |
| `notification-channels/` | Per-channel delivery adapters with attempt recording + redaction |

### Data Model

6 tables: `notification_events`, `notification_deliveries`, `notification_delivery_attempts`, `notification_subscriptions`, `notification_digest_items`, `notification_retention_policies`

### Subscription Resolution

1. Load habitat defaults matching event type
2. Apply recipient overrides
3. Required defaults bypass mute
4. Non-required mute suppresses future delivery
5. Cadence determines immediate vs. digest queueing

---

## Workflow Automation Engine (v0.18)

Server-side rules that react to events with bounded actions:

| Component | Responsibility |
|-----------|---------------|
| `automationContextBuilder.ts` | Loads task/mission/agent/sprint/habitat context from repositories |
| `automationEvaluator.ts` | Evaluates 12 condition types with AND/OR/NOT nesting (depth ≤ 5) |
| `automationExecutor.ts` | Executes 9 action types with per-action results + composite status |
| `automationSimulationService.ts` | Preview — condition tree, action previews, no side effects |
| `automationEventService.ts` | Ingests server events → finds matching rules → applies guards |
| `automationScanService.ts` | Scheduled scans (mission_blocked, sprint_ending, agent_silent, evidence_gap_open) |
| `automationTemplateRenderer.ts` | `{{task.title}}` token substitution with ~30 allowed tokens |

### Safety Guards

| Guard | Skip Reason |
|-------|-------------|
| Cooldown | `cooldown` |
| Hourly cap | `rate_limited` |
| Self-loop prevention | `loop_guard` |
| Disabled rule | `disabled` |

### Execution Flow

```
server event or scan → matching enabled rules → guards → start run →
  evaluator → executor (notify/create_signal/create_task/etc.) →
  finish run with per-action results → audit projection
```

Notification V2 is the only notification path — Automation never calls legacy preferences, email service, or channel adapters directly.

---

## Audit Trail V2 (v0.17)

Audit Trail V2 provides a canonical, provenance-aware audit projection over all lifecycle, effort, code-evidence, pipeline, integration, webhook, and health-snapshot sources. It uses virtual projection-on-read rather than a materialized audit table — every source row is transformed into the canonical `AuditEvent` shape at query time.

### Architecture

```
Source tables (~16)                    Projection (query time)
┌──────────────────────┐              ┌─────────────────────────┐
│ taskEvents           │──┐           │                         │
│ missionEvents        │  │           │  auditQueryService      │
│ effortEntries        │  ├──► project*Row() ──►  AuditEvent    │
│ codeEvidenceLinks    │  │    per-source         (canonical)   │
│ codeCommits          │  │    functions          ├── id: prefix:PK
│ pullRequests         │  │                       ├── completeness
│ pipelineEvents       │  │                       ├── provenance
│ integrationSyncRuns  │  │                       └── summary
│ webhookDeliveries    │──┘              │         └─────────────┘
│ habitatHealthSnapshots│                │
└──────────────────────┘                ├──► auditExportService (CSV/JSON/JSONL)
                                        └──► auditBundleService (task/mission bundles)
```

### Projection-on-Read

The ~16 source tables are read on-demand, each projected via a dedicated `project*Row` function into the canonical `AuditEvent` shape. No materialized `audit_events` table exists. This trades read cost for write simplicity — every domain keeps a single source of truth, and audit never drifts from the systems it observes.

### Provenance Flow

Fastify hooks seed an `AsyncLocalStorage` context with source/request/route/MCP metadata. The `withAuditProvenanceMetadata` helper stamps this into `metadata.audit` on every event write. On read, `normalizeAuditActorAndSource` unpacks it into the structured `AuditEvent.provenance` field, so the query layer reconstructs *who* acted, *through which* surface (REST route, MCP tool, webhook, internal interval), and from *what* origin — without callers threading provenance explicitly.

### Source-Prefix ID Scheme

Every projected `AuditEvent.id` is `"prefix:<source-PK>"` (e.g. `task_event:<uuid>`, `commit:<sha>`). The prefix makes IDs deterministic, acts as a tagged-union discriminator and stable sort key, and lets archival reverse-lookup and delete the correct source row without a join table.

### Key Files

| File | Role |
|------|------|
| `packages/api/src/services/auditQueryService.ts` | Canonical projection query layer — reads source tables, projects to AuditEvent |
| `packages/api/src/services/auditExportService.ts` | CSV/JSON/JSONL streaming exports with filters, presets, and metadata sanitization |
| `packages/api/src/services/auditBundleService.ts` | Scoped evidence bundles for individual tasks or missions |
| `packages/api/src/services/auditProvenanceContext.ts` | AsyncLocalStorage-based provenance injection via Fastify hooks |
| `packages/api/src/services/auditArchivalService.ts` | Retention-driven archival (task/mission events only, default 90 days) |
| `packages/shared/src/types/audit.ts` | AuditEvent, AuditCompleteness, AuditProvenance, AuditWarning types |

### Design Decisions

- **Projection-on-read, no audit store** — all source tables projected at query time for a single source of truth per domain
- **Deterministic prefixed IDs** — `prefix:<source-PK>` enables tagging, stable sorting, and reversible archival
- **Completeness as first-class** — per-event status (complete/legacy_partial/source_unavailable) + caveats + query-level warnings
- **Metadata sanitization** — raw provider payloads, diffs, and patches are scrubbed before projection (security boundary)

### Deferred

- **Hash-chain / tamper-evidence** — the `AuditIntegrity` type is declared but never populated; schema reserved for future work
- **Physical `audit_events` table** — not implemented; projection-on-read is the current model

---

## Daemon Runtime Seam (v0.19.1)

The daemon runtime (session management, task claiming, heartbeats) is decoupled from both the standalone CLI daemon and the API's in-process daemon through six interfaces in `@orcy/shared`. Both consumers program against the interfaces; concrete implementations are constructed by factory functions and injected at runtime.

### Architecture

```
@orcy/shared (contracts)
  ├── types/daemon.ts — 6 interfaces + DTOs
  ├── daemon-poll.ts — runPollTick (the claim loop)
  └── workdir-error.ts — sentinelerror class
        │
        ▼
packages/daemon (concrete impls + factory)
  ├── factory.ts — createSessionManager, createCliDetector, etc.
  ├── session/manager.ts — SessionManager implements ISessionManager
  ├── httpClaimStrategy.ts — HTTP claim path
  └── httpHeartbeatStrategy.ts — HTTP heartbeat path
        │
        ▼
packages/api (consumer via DI)
  ├── daemon-wiring.ts — dynamic import("@orcy/daemon"), per-daemonId caching
  ├── services/daemonEngine.ts — tick() → runPollTick, start() → getSessionManager
  └── services/inProcessClaimStrategy.ts — direct-service claim path
```

### Flow

The standalone daemon (`packages/daemon`) constructs its own `HttpClaimStrategy` and `HttpHeartbeatStrategy` and drives the loop through `PollLoop.tick()`, which delegates to the shared `runPollTick` in `@orcy/shared`. The HTTP strategies call the API's REST endpoints, so each claim and heartbeat traverses the network boundary exactly as an external agent would.

The API's in-process daemon (`daemonEngine.tick()`) reuses the same `runPollTick` algorithm but injects an `InProcessClaimStrategy` that calls services directly instead of over HTTP. This eliminates the self-call round-trip while preserving identical claim semantics, ordering, and error handling.

The dependency injection itself lives in `daemon-wiring.ts`, which lazy-imports `@orcy/daemon` via dynamic `import()` and caches the constructed `ISessionManager` per `daemonId`. `initDaemonWiring()` runs at API startup to populate the wiring once, keeping `@orcy/api` free of any static dependency on `@orcy/daemon`.

### Key Files

| File | Role |
|------|------|
| `shared/src/types/daemon.ts` | Six seam interfaces (ISessionManager, IClaimStrategy, etc.) + DTOs |
| `shared/src/daemon-poll.ts` | runPollTick — the single claim-loop algorithm shared by both consumers |
| `daemon/src/factory.ts` | Factory functions — the only attachment point for concrete implementations |
| `api/src/daemon-wiring.ts` | DI module with dynamic import; caches ISessionManager per daemonId |
| `api/src/services/inProcessClaimStrategy.ts` | In-process claim path using direct service calls instead of HTTP |

### Design Decisions

- **Interface-seam pattern** — both consumers program against shared interfaces, never concrete classes
- **Tick consolidation** — `runPollTick` replaces two 40+ line duplicated `tick()` implementations
- **Dynamic import** — API loads `@orcy/daemon` lazily via `initDaemonWiring()` to avoid static coupling
- **Strategy injection** — `IClaimStrategy` has two implementations (HTTP vs in-process) chosen by deployment mode
