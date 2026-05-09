# Implementation Plan

# Orcy — Build Roadmap & Phase Breakdown

**Version:** 1.0  
**Date:** April 2, 2026  
**Status:** Draft  
**Related:** [PRD](./01-PRD.md), [SPEC](./02-SPEC.md)

---

## 1. Overview

This plan breaks the Orcy system into 5 sequential phases. Each phase delivers working software.

**Total Estimated Duration:** 8–10 weeks (part-time) or 4–5 weeks (full-time)

**Prerequisites before starting:**

- Node.js 20+ installed
- Docker Desktop installed (optional, for PostgreSQL/Redis)
- Claude Code / Codex / OpenCode available for agent testing

---

## 2. Phase 1: Core Foundation (Week 1–2)

**Goal:** A working Kanban API with boards, columns, tasks, basic lifecycle, and atomic claiming.

### 2.1 Tasks

| # | Task | Description | Hours |
|---|------|-------------|-------|
| P1.1 | Project scaffolding | Initialize monorepo workspace with 3 packages (api, ui, mcp) | 2 |
| P1.2 | Database setup | SQLite with better-sqlite3, migrations for all 5 tables | 4 |
| P1.3 | Board/Column CRUD | REST endpoints for boards and columns | 4 |
| P1.4 | Task CRUD | REST endpoints for task create, read, update, delete | 6 |
| P1.5 | Task lifecycle state machine | Implement all status transitions per SPEC Section 3 | 8 |
| P1.6 | Atomic claiming | Transaction-based claim with locking | 6 |
| P1.7 | Task events (audit log) | Every state change logged to task_events table | 3 |
| P1.8 | Basic REST validation | Input validation, error responses, HTTP status codes | 2 |
| P1.9 | Dev seed script | Script to create test board, columns, tasks | 1 |
| P1.10 | Phase 1 tests | Unit tests for state machine and claiming logic | 4 |

### 2.2 Deliverables

- REST API running on `http://localhost:3000`
- All 5 database tables created and migrated
- Task lifecycle fully functional via curl/REST
- No UI, no agents

### 2.3 Exit Criteria

- [ ] `POST /api/boards` creates a board with columns
- [ ] `POST /api/boards/:id/tasks` creates a task
- [ ] `POST /api/tasks/:id/move` moves task between columns
- [ ] `POST /api/tasks/:id/claim` atomically claims (and blocks second claim)
- [ ] Every mutation creates a corresponding task_event
- [ ] `GET /api/boards/:id` returns board with all columns and tasks
- [ ] Unit tests pass for: claim race condition, invalid state transitions

### 2.4 Dependencies

- None (starts from scratch)

---

## 3. Phase 2: Agent Infrastructure (Week 3)

**Goal:** Agent registry, MCP server with all 6 tools, agent-board interaction via MCP stdio.

### 3.1 Tasks

| # | Task | Description | Hours |
|---|------|-------------|-------|
| P2.1 | Agent CRUD | REST endpoints for agent registration, lookup, heartbeat | 4 |
| P2.2 | Agent API key auth | SHA-256 hashed keys, `X-Agent-API-Key` header middleware | 3 |
| P2.3 | Agent heartbeat system | Background job for stale detection, status updates | 4 |
| P2.4 | MCP server scaffold | @modelcontextprotocol/sdk, stdio transport, env config | 3 |
| P2.5 | `board_list_tasks` tool | Filter by domain, status, priority, dependencies met | 4 |
| P2.6 | `board_claim_task` tool | Atomic claim with domain validation | 3 |
| P2.7 | `board_update_task_status` tool | Status transitions with auth validation | 3 |
| P2.8 | `board_submit_task` tool | Submit with result and artifacts | 3 |
| P2.9 | `board_get_task_context` tool | Dependencies, board context | 3 |
| P2.10 | `board_release_task` tool | Release back to pending | 2 |
| P2.11 | `board_heartbeat` tool | Keep-alive with configurable interval | 2 |
| P2.12 | AGENTS.md template | Skill file for Claude Code / Codex / OpenCode | 2 |
| P2.13 | Phase 2 tests | Integration tests: full agent task lifecycle via MCP | 4 |

### 3.2 Deliverables

- MCP server running as stdio subprocess
- Agent can: list tasks → claim → work → submit → done
- Agent domain isolation enforced
- Stale task auto-release working

### 3.3 Exit Criteria

- [ ] `POST /api/agents` returns plain API key (shown once)
- [ ] MCP server starts and passes `initialize` handshake
- [ ] Agent can call `board_list_tasks` and see only domain-matching pending tasks
- [ ] Agent can claim a task, second concurrent claim fails
- [ ] Agent heartbeat updates `lastHeartbeat` and prevents stale detection
- [ ] Tasks with unmet dependencies are hidden from `board_list_tasks`
- [ ] Claude Code can complete a full task cycle via MCP tools

### 3.4 Dependencies

- Phase 1 complete

---

## 4. Phase 3: Web UI (Week 3–4)

**Goal:** Full React kanban board with drag-and-drop, real-time SSE updates, task detail panel, and agent management.

### 4.1 Tasks

| # | Task | Description | Hours |
|---|------|-------------|-------|
| P3.1 | Vite + React setup | React 19, TypeScript, TailwindCSS | 2 |
| P3.2 | Board view component | Column layout, task cards, drag-and-drop via dnd-kit | 8 |
| P3.3 | Task card component | Priority badge, agent avatar, labels, status indicator | 4 |
| P3.4 | Task detail panel | Slide-out with description, artifacts, activity log | 6 |
| P3.5 | Create task form | Modal with title, description, priority, domain, labels | 4 |
| P3.6 | Approve/reject workflow | Review panel with approve/reject buttons, reason input | 5 |
| P5.7 | Agent management panel | List agents, status, current task, heartbeat indicator | 4 |
| P5.8 | SSE real-time updates | Board auto-refreshes on task state changes | 6 |
| P5.9 | Column WIP indicators | Show count/limit, color-code when at limit | 3 |
| P5.10 | Board/column settings | Edit board name, column order, WIP limits | 4 |
| P5.11 | Search and filter | Filter tasks by label, priority, agent, status | 4 |
| P5.12 | Phase 5 tests | Playwright E2E tests for critical flows | 6 |

### 5.2 Deliverables

- Full kanban board UI at `http://localhost:5173`
- Real-time updates without page refresh
- Human can do everything agents can do (create, claim, submit, approve, reject)
- Agent status visible in UI

### 5.3 Exit Criteria

- [ ] Board renders with all columns and tasks
- [ ] Drag-and-drop moves task between columns
- [ ] New task appears immediately in UI (SSE)
- [ ] Clicking task opens detail panel with full history
- [ ] Human can approve/reject from UI
- [ ] Agent status changes reflected in real-time
- [ ] WIP limit shown on column header, visually warned when exceeded

### 4.4 Dependencies

- Phase 1 complete (API must be running)
- **Note:** Phase 3 UI is fully functional with Phase 1 (REST API only).

---

## 5. Phase 4: Polish & Hardening (Week 5–6)

**Goal:** Production-quality reliability, observability, documentation, and deployment automation.

### 5.1 Tasks

| # | Task | Description | Hours |
|---|------|-------------|-------|
| P4.1 | Task dependencies UI | Visualize dependency DAG, show blocked-by badges | 6 |
| P4.2 | Auto-advance UX | Confirm dialog when task will auto-advance, animation | 3 |
| P4.3 | Board statistics | Cycle time, throughput, WIP health, per-agent metrics | 6 |
| P4.4 | Full-text search | Search tasks by title/description | 4 |
| P4.5 | Error handling & logging | Structured logging (pino), error boundaries in UI | 4 |
| P4.6 | API rate limiting | Protect against runaway agents | 2 |
| P4.7 | Docker Compose production | All services wired, healthchecks, restart policies | 4 |
| P4.8 | README and setup guide | Step-by-step from zero to running | 3 |
| P4.9 | Production readiness audit | Review error cases, security, scalability | 4 |

### 5.2 Deliverables

- Complete, documentable, self-hosted Orcy system
- Docker Compose one-command deployment
- All acceptance criteria from PRD met

---

## 7. Detailed Task Breakdown

### Phase 1 — Core Foundation

```
P1.1  Project scaffolding
      ├── Initialize pnpm workspaces (package.json at root)
      ├── Create packages/api, packages/ui, packages/mcp directories
      ├── Install dev dependencies: TypeScript, ts-node, vitest
      └── Create tsconfig.json files (root + per-package)

P1.2  Database setup
      ├── Install better-sqlite3, @databases/pg
      ├── Create db/migrations/ directory
      ├── Write 001_initial.sql (boards, columns, tasks, task_events, agents, task_dependencies)
      ├── Create db/index.ts with getDb() singleton
      └── Create repositories/board.ts, task.ts, agent.ts, event.ts

P1.3  Board/Column CRUD
      ├── POST /api/boards → createBoard()
      ├── GET /api/boards → listBoards()
      ├── GET /api/boards/:id → getBoardWithColumnsAndTasks()
      ├── PATCH /api/boards/:id → updateBoard()
      ├── DELETE /api/boards/:id → deleteBoard() (cascade columns)
      ├── POST /api/boards/:boardId/columns → createColumn()
      ├── PATCH /api/columns/:id → updateColumn()
      └── DELETE /api/columns/:id → deleteColumn()

P1.4  Task CRUD
      ├── POST /api/boards/:boardId/tasks → createTask()
      ├── GET /api/boards/:boardId/tasks → listTasks(filters)
      ├── GET /api/tasks/:id → getTaskWithEvents()
      ├── PATCH /api/tasks/:id → updateTask() (optimistic locking)
      └── DELETE /api/tasks/:id → deleteTask()

P1.5  Task lifecycle state machine
      ├── ValidateTransition(from, to) → boolean
      ├── claimTask(taskId, agentId) → Task
      ├── startTask(taskId, agentId) → Task
      ├── submitTask(taskId, result, artifacts) → Task
      ├── approveTask(taskId, reviewerId) → Task
      ├── rejectTask(taskId, reviewerId, reason) → Task
      ├── releaseTask(taskId, reason) → Task
      ├── moveTask(taskId, columnId, status) → Task
      └── All functions emit task_events

P1.6  Atomic claiming
      ├── SQLite: BEGIN IMMEDIATE transaction + SELECT FOR UPDATE
      ├── Check status = 'pending' and assigned_agent_id IS NULL
      ├── Set assigned_agent_id and status = 'claimed'
      ├── COMMIT → return updated task
      └── ROLLBACK on any error → return { success: false }

P1.7  Task events (audit log)
      ├── eventRepository.create(event)
      ├── Log actor_type, actor_id, action, timestamps, metadata
      ├── GET /api/tasks/:id/events returns chronological log
      └── Enforce: every state change must call eventRepository.create()

P1.8  Basic REST validation
      ├── ajv or zod schemas for all request bodies
      ├── 400 for validation errors with field-level messages
      ├── 404 for not found, 409 for conflicts, 422 for invalid transitions
      └── Global error handler middleware

P1.9  Dev seed script
      └── scripts/seed.ts: creates board "Sprint 24" with 4 columns, 10 tasks, 2 agents

P1.10 Phase 1 tests
      ├── vitest unit tests: state machine transitions
      ├── vitest unit tests: atomic claim race simulation
      ├── vitest unit tests: invalid transition rejection
      └── Run: pnpm --filter api test
```

### Phase 2 — Agent Infrastructure

```
P2.1  Agent CRUD
      ├── POST /api/agents → createAgent() (generates UUID, stores SHA-256 hash)
      ├── GET /api/agents → listAgents()
      ├── GET /api/agents/:id → getAgentWithTask()
      ├── PATCH /api/agents/:id → updateAgent()
      ├── DELETE /api/agents/:id → deleteAgent() (release any assigned task)
      └── Response includes PLAIN apiKey only ONCE on creation

P2.2  Agent API key auth
      ├── Middleware: extract X-Agent-API-Key header
      ├── Hash with SHA-256, compare against agents.api_key
      ├── 401 if missing/invalid
      └── Apply to /api/tasks/* and /api/agents/* for MCP calls

P2.3  Agent heartbeat system
      ├── POST /api/agents/:id/heartbeat { taskId? }
      ├── Update agents.last_heartbeat = NOW()
      ├── Update agents.current_task_id if taskId provided
      ├── Background job (every 60s): find agents with lastHeartbeat > 2h ago
      └── Set status = 'offline', release any assigned tasks

P2.4  MCP server scaffold
      ├── npm install @modelcontextprotocol/sdk
      ├── Create McpServer instance with name, version
      ├── Configure stdio transport
      ├── Read ORCY_API_URL, ORCY_AGENT_ID, ORCY_API_KEY from env
      └── Handle initialize, tools/list, tools/call requests

P2.5  board_list_tasks tool
      ├── Input: { boardId, status?, priority?, limit? }
      ├── Query tasks WHERE board_id = boardId AND status = status
      ├── Filter by agent domain AND capabilities match
      ├── Filter: depends_on all resolved
      ├── Return paginated task list with metadata
      └── Schema registered in tools/list

P2.6  board_claim_task tool
      ├── Input: { taskId }
      ├── Validate agent's domain matches task.required_domain
      ├── Call claimTask(taskId, agentId) atomically
      ├── Return { success: true, task } or { success: false, reason }
      └── reason: 'already_claimed' | 'not_found' | 'domain_mismatch' | 'dependencies_unmet'

P2.7  board_update_task_status tool
      ├── Input: { taskId, status, result?, artifacts? }
      ├── Validate: agent owns this task (assignedAgentId matches)
      ├── Validate: status is a valid transition from current
      ├── Call appropriate state transition function
      └── Return updated task

P2.8  board_submit_task tool
      ├── Input: { taskId, result, artifacts? }
      ├── Validate: task is in 'in_progress' AND owned by agent
      ├── Set submittedAt, status = 'submitted'
      ├── Move to Review column (column with requiresClaim=true and name='Review')
      └── Return { success, task, message }

P2.9  board_get_task_context tool
      ├── Input: { taskId }
      ├── Return task with full details
      ├── Include: dependencies (with status), dependents (blocked-by)
      ├── Include: boardContext (all columns with counts)
      └── Include: agent's current assignment info

P2.10 board_release_task tool
      ├── Input: { taskId, reason }
      ├── Validate: agent owns this task
      ├── Call releaseTask(taskId, reason)
      └── Return { success, task }

P2.11 board_heartbeat tool
      ├── Input: { taskId?, progress? }
      ├── Call heartbeat API (updates lastHeartbeat, optionally currentTaskId)
      ├── Return { success, agentStatus, nextCheckIn: 300, taskStatus }
      └── nextCheckIn = recommended seconds until next heartbeat

P2.12  AGENTS.md template
      └── Create docs/SKILL.md (renamed from AGENTS.md) with:
          ├── Kanban rules for agents (startup sequence, task claiming, submission)
          ├── MCP tool descriptions and usage examples
          └── Acceptance criteria format for task completion

P2.13 Phase 2 tests
      ├── Start Kanban API and MCP server
      ├── Spawn Claude Code with .mcp.json configured
      ├── Script: list_tasks → claim_task → update_status(in_progress) → submit_task
      ├── Concurrent claim test: 2 agents try to claim same task, only 1 succeeds
      └── Domain isolation test: agent with domain=frontend cannot see domain=backend tasks
```

### Phase 3 — Web UI

```
P5.1  Vite + React setup
      ├── pnpm create vite@latest packages/ui --template react-ts
      ├── Install: tailwindcss, dnd-kit, @tanstack/react-query, zustand
      ├── Configure Vite proxy: /api → http://localhost:3000
      └── Install shadcn/ui components (card, button, dialog, dropdown)

P5.2  Board view component
      ├── Board.tsx: main container with column layout
      ├── Column.tsx: droppable column with dnd-kit
      ├── TaskCard.tsx: draggable card within column
      ├── BoardContext: Zustand store for board state
      ├── useBoard(): fetch board data on mount
      └── useDropTask / useDragTask: dnd-kit handlers

P5.3  Task card component
      ├── Priority badge (color: critical=red, high=orange, medium=yellow, low=gray)
      ├── Agent avatar (if assigned) or "Unassigned" badge
      ├── Labels as small pills
      ├── Status dot indicator (claimed=blue, in_progress=purple, submitted=yellow)
      └── Hover: show full title if truncated

P5.4  Task detail panel
      ├── Slide-out drawer (right side, 480px wide)
      ├── Task header: title, priority, status, agent
      ├── Description section (markdown rendered)
      ├── Acceptance criteria checklist
      ├── Artifacts section (links to PRs, commits)
      ├── Activity timeline (from task_events)
      ├── Action buttons: Approve / Reject (if submitted)
      └── Chat thread (stretch goal)

P5.5  Create task form
      ├── Modal dialog triggered by "+ Task" button
      ├── Fields: title (required), description (textarea), priority (select),
      │         labels (multi-select/create), domain (select), requiredCapabilities (tags)
      ├── Submit → POST /api/boards/:boardId/tasks
      └── Optimistic UI update: add task to board immediately

P5.6  Approve/reject workflow
      ├── ReviewPanel component (inside task detail)
      ├── Shows: task result summary, list of artifacts
      ├── Approve button: POST /api/tasks/:id/approve
      ├── Reject button: textarea for reason + POST /api/tasks/:id/reject
      └── After action: SSE updates board, task moves to next column

P5.7  Agent management panel
      ├── /agents route or sidebar panel
      ├── AgentCard: name, type, domain, status indicator
      ├── Status colors: 🟢 idle, 🟡 working, ⚫ offline
      ├── Current task shown if working
      ├── Last heartbeat timestamp (relative: "2m ago")
      └── Actions: deregister agent

P5.8  SSE real-time updates
      ├── useSSE(boardId): connects to /api/boards/:id/stream
      ├── On event: update Zustand store → React re-renders
      ├── Event types handled:
      │   ├── task.created → add to column
      │   ├── task.moved → move between columns
      │   ├── task.updated → update card
      │   ├── task.claimed → update card agent badge
      │   └── agent.status_changed → update agent card
      └── Reconnect logic: auto-reconnect on disconnect with backoff

P5.9  Column WIP indicators
      ├── Show "3/5" on column header (current/limit)
      ├── Yellow when 80% of limit, red when at limit
      ├── When dragging task into full column: show error tooltip
      └── Configurable via column settings (PATCH /api/columns/:id)

P5.10 Board/column settings
      ├── Board settings: edit name, description
      ├── Column settings: rename, set WIP limit, toggle auto-advance
      ├── Reorder columns: drag-and-drop in settings modal
      └── Save → PATCH /api/boards/:id or PATCH /api/columns/:id

P5.11 Search and filter
      ├── Search bar: debounced, searches title and description
      ├── Filter pills: Priority, Status, Label, Agent
      ├── Filters combine with AND logic
      └── URL sync: /?search=auth&priority=high&status=pending

P5.12 Phase 4 tests (Playwright)
      ├── e2e: create board → create task → claim → submit → approve → done
      ├── e2e: concurrent agent claim (2 browser tabs)
      ├── e2e: reject flow → task returns to in_progress
      └── e2e: SSE updates: tab 1 approves → tab 2 sees task move automatically
```

---

## 8. Risk Register

| Risk | Phase | Impact | Likelihood | Mitigation |
|------|-------|--------|------------|------------|
| SQLite concurrent writes | 1 | High | Medium | Use `BEGIN IMMEDIATE` transactions; switch to PostgreSQL for production |
| MCP server stdio buffering issues | 2 | Medium | Low | Use JSON-RPC 2.0 framing; flush stdout after each message |
| Agent domain routing complexity | 2 | Medium | Medium | Keep domain model simple; agents have ONE domain, tasks require ONE domain or NULL |
| dnd-kit SSR issues | 3 | Low | Low | Use dynamic import or @dnd-kit/ssr |

---

## 9. Milestones

| Milestone | Target | Phase | Criteria |
|-----------|--------|-------|----------|
| **M1: Core API** | Week 2 | P1 | Task CRUD + lifecycle + atomic claim working via curl |
| **M2: Agent MCP** | Week 3 | P2 | Claude Code can claim and submit a task via MCP tools |
| **M3: Full UI** | Week 4 | P3 | Human can do everything from browser |
| **M4: Ship** | Week 6 | P4 | All PRD acceptance criteria met; documented; deployable |

---

## 10. Definition of Done

Each phase is done when:

1. All tasks in the phase task list are complete
2. Exit criteria (marked with [ ]) are all checked
3. Code is committed to git (feature branch, PR reviewed)
4. Tests pass locally
5. No TypeScript errors (`pnpm build` succeeds)
6. README updated if user-facing changes were made

---

## 11. SKILL.md Agent Template

See [docs/SKILL.md](./SKILL.md) for the complete agent orchestration skill file.

This file defines how Claude Code, Codex, and OpenCode agents should interact with the Kanban system — including startup sequence, task claiming rules, submission format, and heartbeat protocol.
