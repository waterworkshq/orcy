# Architecture Documentation

This document covers the system architecture, design decisions, key flows, and integration patterns.

---

## System Overview

```
┌──────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code / Codex / OpenCode)               │
│  MCP stdio transport                                     │
│  ┌──────────────────────────────────────────────────┐   │
│  │  MCP Server (11 dispatch tools)                      │   │
│  │  Features: list │ create │ get_context │ delete  │   │
│  │  Tasks: claim │ submit │ update │ heartbeat     │   │
│  └────────────────────┬─────────────────────────────┘   │
│                       │ HTTP (X-Agent-API-Key)           │
└───────────────────────┼──────────────────────────────────┘
                          ▼
                    Kanban API

┌──────────────────────────────────────────────────────────┐
│  Board → Features → Tasks → Subtasks                     │
│  Features flow through columns, tasks have state machine  │
└──────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### API (`packages/api`)

| Layer | Directory | Responsibility |
|-------|-----------|---------------|
| Routes | `src/routes/` | HTTP parsing, validation, response formatting. Includes `features.ts` for 13 feature endpoints |
| Services | `src/services/` | Business logic, SSE broadcasting, webhook dispatch, AI features. Includes `featureService.ts` for status derivation engine and column auto-advancement |
| Repositories | `src/repositories/` | Drizzle-backed data access (board, feature, task, column, agent, comment, template, webhook, event-feature) |
| Models | `src/models/` | TypeScript types, Zod schemas. Includes `Feature`, `FeatureWithProgress`, `FeatureStatus` types |
| Middleware | `src/middleware/` | Authentication (API key + JWT), RBAC, team-based access |
| SSE | `src/sse/` | Event broadcaster (pub/sub) — broadcasts both task and feature events |
| DB | `src/db/` | Database initialization, Drizzle ORM schema (25 tables including features) |
| Plugins | `src/plugins/` | Plugin system for extensibility |

### UI (`packages/ui`)

| Layer | Directory | Responsibility |
|-------|-----------|---------------|
| Pages | `src/components/board/` | BoardListPage, BoardPage |
| Components | `src/components/ui/` | Button, Badge, Card, Dialog, ErrorBoundary |
| Board | `src/components/board/` | Board, Column, TaskCard, TaskDetailPanel |
| Store | `src/store/` | Zustand state management + SSE handler |
| API | `src/api/` | Typed REST client |
| Lib | `src/lib/` | React Query hooks (`useBoardData`, `useTaskData`) + cache key factory (`queryKeys`) |
| Hooks | `src/hooks/` | SSE connection management + React Query cache invalidation |
| Types | `src/types/` | TypeScript interfaces |

### MCP (`packages/mcp`)

| File | Responsibility |
|------|---------------|
| `src/index.ts` | MCP SDK server setup, tool registry |
| `src/tools/index.ts` | All tool exports + 11 consolidated dispatch tools |
| `src/tools/board-dispatch.ts` | Board dispatch: list, find, summary, metrics, settings |
| `src/tools/feature-dispatch.ts` | Feature dispatch: list, create, delete, archive, get-context |
| `src/tools/task-dispatch.ts` | Task dispatch: claim, submit, complete, release, update, comments |
| `src/tools/agent-dispatch.ts` | Agent dispatch: register, heartbeat, stats |
| `src/tools/suggest-dispatch.ts` | Suggest dispatch: suggest-next-task |
| `src/tools/instructions.ts` | Hierarchical agent workflow instructions |
| `src/api.ts` | REST API client (OrcyApiClient) |

---

## Key Flows

### Feature Discovery & Task Claiming Flow

```
Agent                MCP Server              API
  │                     │                     │
  │  board({action:"summary"})  │                     │
  │────────────────────>│  GET /summary       │
  │                     │────────────────────>│
  │                     │  { features, ... }  │
  │                     │<────────────────────│
  │  { digest, ... }    │                     │
  │<────────────────────│                     │
  │                     │                     │
  │  board_feature({action:"list"})  │           │
  │────────────────────>│  GET /features      │
  │                     │────────────────────>│
  │                     │  { features: [...] } │
  │                     │<────────────────────│
  │  { features }       │                     │
  │<────────────────────│                     │
  │                     │                     │
  │  board_feature({action:"get-context"})│         │
  │────────────────────>│  GET /features/:id/details
  │                     │────────────────────>│
  │                     │  { feature, tasks } │
  │                     │<────────────────────│
  │  { feature+tasks }  │                     │
  │<────────────────────│                     │
  │                     │                     │
  │  board_task({action:"claim"})│              │
  │────────────────────>│  POST /tasks/:id/claim
  │                     │────────────────────>│
  │                     │                     │  Check state machine
  │                     │                     │  Atomic claim (version)
  │                     │                     │  Create event          
  │                     │                     │  Recalculate feature status
  │                     │                     │  Broadcast SSE         
  │                     │  { task }           │                        
  │                     │<────────────────────│                        
  │  { success, task }  │                     │                        
  │<────────────────────│                     │                        
```

### Task Submission & Feature Status Recalculation Flow

```
Agent              API                Feature Service        SSE Broadcast         Human
  │                 │                      │                       │                   │
  │  submit         │                      │                       │                   │
  │────────────────>│                      │                       │                   │
  │                 │  Update task status   │                       │                   │
  │                 │  Create task event    │                       │                   │
  │                 │                      │                       │                   │
  │                 │  recalculateFeatureStatus(featureId)          │                   │
  │                 │─────────────────────>│                       │                   │
  │                 │                      │  deriveFeatureStatus() │                   │
  │                 │                      │  autoAdvanceColumn()   │                   │
  │                 │                      │  createFeatureEvent()  │                   │
  │                 │  { feature }         │                       │                   │
  │                 │<─────────────────────│                       │                   │
  │                 │                      │                       │                   │
  │                 │  Broadcast task event ──────────────────────>│                   │
  │                 │  Broadcast feature event ──────────────────>│  UI updates        │
  │  { success }    │                      │                       │  shows feature     │
  │<────────────────│                      │                       │  progress change   │
  │                 │                      │                       │                   │
  │                 │                      │                       │     approve/reject │
  │                 │<─────────────────────│<──────────────────────│<──────────────────│
  │                 │  Update task status   │                       │                   │
  │                 │  Recalculate feature  │                       │                   │
  │                 │  Broadcast ─────────────────────────────────>│                   │
```

### SSE Event Flow

```
API Service                    SSE Broadcaster              UI Client
    │                              │                          │
    │  publish(boardId, event)     │                          │
    │─────────────────────────────>│                          │
    │                              │  iterate subscribers     │
    │                              │  for boardId             │
    │                              │                          │
    │                              │  data: JSON(event)       │
    │                              │─────────────────────────>│
    │                              │                          │  handleSSEEvent()
    │                              │                          │  update Zustand store
    │                              │                          │  React re-renders
```

### SSE Global Channel

Agent-related events (status changes, heartbeats) are published to the `'global'` board ID in the SSE broadcaster, not to specific board channels. This means board-level SSE subscribers will NOT receive agent events. Only board-scoped events (task CRUD, moves, etc.) are published to the specific board ID.

---

## Design Decisions

### ADR-1: SQLite with bun:sqlite

**Decision:** Use `bun:sqlite` (Bun's native SQLite binding) for production storage; `sql.js` (WASM) only for test environments.

**Rationale:**

- Bun's native binding provides superior performance to sql.js
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

### ADR-7: Drizzle ORM with bun:sqlite

**Decision:** Migrate from raw parameterized SQL to Drizzle ORM with bun:sqlite as the primary database driver.

**Rationale:**

- Type-safe schema definition with automatic TypeScript type inference
- Cross-database support via dialect helpers (SQLite/PostgreSQL)
- Drizzle Kit for schema management
- Bun's native SQLite binding (`bun:sqlite`) provides superior performance to sql.js
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
  feature, siblingTasks,
  dependencies, blockedBy, blocking, boardContext
}
```

Similarly, `GET /features/:id/details` returns feature + tasks + events + progress in one call.

**Trade-offs:**

- Two caching layers (Zustand + React Query) requires keeping both in sync on SSE events
- Cache invalidation must cover all keys; SSE hook invalidates both `tasks.detail` and `tasks.details`
- React StrictMode doubles effect execution in dev — batching absorbs this overhead

### ADR-9: Hierarchical Kanban — Features → Tasks → Subtasks

**Decision:** Replace the flat Board → Tasks model with Board → Features → Tasks → Subtasks. Features become the board-level cards; tasks become feature-internal work units.

**Rationale:**

- Aligns with how teams think about work — features as deliverables, tasks as implementation steps
- Feature status auto-derived from child tasks eliminates manual status management
- Cleaner separation of concerns: features own board position/timeline, tasks own agent assignment
- Feature-level dependencies are more meaningful than task-level cross-board deps

**Trade-offs:**

- Breaking change — no backward compatibility with flat task model
- Required restructuring the codebase
- Additional API complexity (13 new feature endpoints)
- Agents must learn feature-centric workflow (`board_feature({action:"get-context"})` before claiming)

### ADR-10: Feature Status Derivation Engine

**Decision:** Feature status is always derived from child task states. No manual status field.

**Rationale:**

- Eliminates status drift between features and their tasks
- Single source of truth — task states drive everything
- Automatic column advancement keeps the board visually accurate
- Humans retain veto power via manual column override (POST /features/:id/move)
- Completed work can be archived (`isArchived` flag) while retaining 'done' status for metrics, rather than introducing an 'archived' status in the state machine.

**Trade-offs:**

- Recalculation on every task state change (minimal performance impact)
- Edge case: empty features default to `not_started`
- Feature status changes are side effects, not directly triggered

---

## Hierarchical Model Architecture

### Entity Responsibility Matrix

| Concern | Feature | Task | Subtask |
|---------|---------|------|---------|
| Board column position | Yes | No | No |
| State machine | No (derived) | Yes | No |
| Agent assignment | No (deferred) | Yes | No |
| Result / artifacts | No | Yes | No |
| Comments | No (on tasks) | Yes | No |
| Events / audit trail | Yes (feature-level) | Yes (task-level) | No |
| Dependencies | Yes (cross-feature) | Yes (within-feature) | No |
| Priority | Yes | Yes | No |
| Labels | Yes | No | No |
| SLA / due date | Yes | No | No |
| Estimated time | No | Yes | No |
| Progress tracking | Derived from tasks | Boolean per state | Boolean |

### MCP Tool Architecture (Consolidated Dispatch Pattern)

The MCP server exposes **11 consolidated dispatch tools**. Each tool accepts an `action` parameter to route to specific operations:

| Dispatch Tool | Actions | Purpose |
|---------------|---------|---------|
| `orcy_habitat` | `list`, `find`, `summary`, `metrics`, `get-settings`, `update-settings` | Habitat-level operations |
| `orcy_habitat_mission` | `list`, `create`, `delete`, `archive`, `unarchive`, `get-context` | Mission CRUD + context |
| `orcy_habitat_task` | `list-in-mission`, `claim`, `submit`, `complete`, `release`, `get-context`, `get-comments`, ... | Task lifecycle + details |
| `orcy_habitat_agent` | `register`, `list`, `heartbeat`, `get-stats` | Agent management |
| `orcy_suggest` | `suggest-next-task` | AI-ranked task suggestions |
| `orcy_habitat_message` | `send`, `get-messages` | Agent-to-agent messaging |
| `orcy_pulse` | `post`, `check` | Mission signal board — post findings, blockers, directives; check partner signals |
| `orcy_habitat_subscription` | `subscribe`, `unsubscribe` | Real-time notifications |
| `orcy_admin` | `list-webhooks`, `create-webhook`, `list-templates`, `batch-assign-tasks`, ... | Admin operations |
| `orcy_worktree` | `get-worktree` | Git worktree info |
| `orcy_instructions` | (tool) | Returns orcy skill guide |

### Pulse Signal Architecture

Pulse adds a structured signal layer on top of the existing task state machine. Signals flow as follows:

```
Agent / Human
  │
  ├─► orcy_pulse({action: "post", missionId, signalType, subject})
  │     │
  │     ├─► POST /api/missions/:id/pulse
  │     │     ├─► INSERT INTO pulses (missionId, boardId, fromType, signalType, ...)
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

### Feature Status Derivation

Feature status is **auto-derived** from child task states. There is no manual status management.

```
Feature Status Derivation Rules:
─────────────────────────────────
not_started  ← all tasks are pending
in_progress  ← any task is claimed/in_progress/submitted/approved/rejected
review       ← all tasks are submitted/approved/done (none active)
done         ← all tasks are done/approved (at least one done)
failed       ← any task failed and none actively being worked on
```

### Column Auto-Advancement

After deriving feature status, the feature's column position is automatically updated:

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

| Task Service Method | Triggers Feature Status Derivation |
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

### Feature-Level Dependencies

Features declare dependencies on other features. Tasks inherit dependency filtering from their parent feature.

1. When creating a feature, specify `dependsOn: ["feature-uuid-1", "feature-uuid-2"]`
2. The `getAvailableTasksForAgent()` function checks feature-level dependencies via `feature_dependencies`
3. Tasks within a feature with unmet dependencies are not shown to agents
4. When a feature reaches `done` status, dependent features become available

### Task-Level Dependencies (Within Feature)

Tasks can also have within-feature dependencies on sibling tasks:

1. `task_dependencies` table tracks within-feature task dependencies
2. `getAvailableTasksForAgent()` checks both feature-level and task-level dependencies
3. Within-feature dependencies are enforced at the application level

### Dependency Rules

- Feature-level dependencies only (no cross-feature task dependencies per ADR-005)
- Within-feature task dependencies allowed
- Circular dependencies are not detected at creation time — validate client-side
- Self-dependency prevented at database level via CHECK constraint

---

## Stale Task Detection

A background interval (60 seconds) checks for stale agents and releases their tasks:

1. Find all agents whose `lastHeartbeat` was > 30 minutes ago and whose status is not `offline`
2. Mark each stale agent as `offline` (clear their `currentTaskId`)
3. If the agent had a current task → release it back to `pending` (with reason `stale_timeout`)
4. Broadcast SSE events for the agent status change (to `'global'` channel) and task release (to board channel)

Configuration is in `packages/api/src/index.ts`:

- Stale threshold: 30 minutes (hardcoded in `releaseStaleTasks(30)`)
- Check interval: 60 seconds (`setInterval(..., 60_000)`)
