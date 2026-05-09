# Technical Specification Document

# Orcy — System Architecture & API Specification

**Version:** 1.0  
**Date:** April 2, 2026  
**Status:** Draft  
**Related:** [PRD](./01-PRD.md)

---

## 1. System Architecture

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Human User Layer                             │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  React 19 Web UI (Vite)                                     │    │
│  │  - Kanban Board (drag-and-drop)                             │    │
│  │  - Task Detail Panel                                        │    │
│  │  - Agent Management Panel                                   │    │
│  │  - SSE Client for real-time updates                         │    │
│  └────────────────────────┬────────────────────────────────────┘    │
└───────────────────────────┼─────────────────────────────────────────┘
                            │ HTTP/REST + SSE
┌───────────────────────────▼─────────────────────────────────────────┐
│                        Kanban API Server                             │
│  Fastify (Node.js 20+) + TypeScript                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Board      │  │ Task       │  │ Agent      │  │ MCP Server   │  │
│  │ Service    │  │ Service    │  │ Service    │  │ (stdio)      │  │
│  └────────────┘  └────────────┘  └────────────┘  └──────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ SSE Broadcaster (real-time event distribution)               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            │                               │
┌───────────▼───────────┐     ┌─────────────▼─────────────┐
│  Local SQLite /       │     │  PostgreSQL + Redis        │
│  PostgreSQL           │     │  (Docker)                │
│  (board metadata,     │     │  Task persistence + queue  │
│   agent registry,     │     │                          │
│   task events)        │     │                          │
└───────────────────────┘     └───────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    AI Agent Layer                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Claude Code  │  │ Codex CLI    │  │ OpenCode     │              │
│  │ + MCP Client │  │ + MCP Client │  │ + MCP Client │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                            │ MCP stdio transport                     │
│                   ┌────────▼────────┐                                │
│                   │ Kanban MCP      │                                │
│                   │ Server (stdio)  │                                │
│                   └────────┬────────┘                                │
│                            │ HTTP (internal)                         │
│                   ┌────────▼────────┐                                │
│                   │ Kanban API     │                                │
│                   │ (authenticated) │                                │
│                   └─────────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Component Responsibilities

| Component | Responsibility | Tech |
|-----------|---------------|------|
| **Web UI** | Board visualization, task CRUD, review workflow, agent management | React 19, TypeScript, Vite, dnd-kit |
| **Kanban API** | REST endpoints, business logic, task state machine, agent routing | Fastify, TypeScript |
| **MCP Server** | Agent-facing tool interface, stdio transport, API key auth | @modelcontextprotocol/sdk |
| **SSE Broadcaster** | Real-time event push to connected UI clients | Fastify plugin, EventTarget |
| **SQLite/PostgreSQL** | Persistent storage for boards, tasks, agents, events | better-sqlite3 or pg |

### 1.3 Communication Patterns

| Path | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| UI → API | HTTP REST | Request/Response | CRUD operations, task moves, approvals |
| API → UI | SSE | Server Push | Real-time board updates |
| Agent → MCP | MCP stdio | Request/Response | Task discovery, claiming, submission |
| MCP → API | HTTP REST | Request/Response | Authenticated API calls on behalf of agent |

---

## 2. Data Models

### 2.1 Entity Relationship Diagram

```
Board (1) ────< (N) Column
Board (1) ────< (N) Task
Board (1) ────< (N) Agent
Agent (1) ────< (N) Task (via assignedAgentId)
Task (1) ────< (N) TaskEvent
Task (N) ────> (N) Task (self-referential: dependsOn, blocks)
Task (1) ────< (N) Artifact
```

### 2.2 Table Schemas

#### boards

```sql
CREATE TABLE boards (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_boards_name ON boards(name);
```

#### columns

```sql
CREATE TABLE columns (
    id              TEXT PRIMARY KEY,
    board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    "order"         INTEGER NOT NULL,
    wip_limit       INTEGER DEFAULT NULL,
    auto_advance    INTEGER NOT NULL DEFAULT 0,
    requires_claim  INTEGER NOT NULL DEFAULT 1,
    next_column_id  TEXT DEFAULT NULL REFERENCES columns(id),
    is_terminal     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(board_id, "order")
);
CREATE INDEX idx_columns_board_id ON columns(board_id);
CREATE INDEX idx_columns_next ON columns(next_column_id);
```

#### agents

```sql
CREATE TABLE agents (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    type            TEXT NOT NULL CHECK (type IN ('claude-code', 'codex', 'opencode')),
    domain          TEXT NOT NULL,
    capabilities    TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'offline')),
    current_task_id TEXT DEFAULT NULL REFERENCES tasks(id),
    api_key         TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_heartbeat  TEXT NOT NULL DEFAULT (datetime('now')),
    metadata        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_agents_domain ON agents(domain);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_current_task ON agents(current_task_id);
```

#### tasks

```sql
CREATE TABLE tasks (
    id                      TEXT PRIMARY KEY,
    board_id                TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    column_id               TEXT NOT NULL REFERENCES columns(id),
    title                   TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    priority                TEXT NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    labels                  TEXT NOT NULL DEFAULT '[]',

    assigned_agent_id       TEXT DEFAULT NULL REFERENCES agents(id),
    required_domain         TEXT DEFAULT NULL,
    required_capabilities   TEXT NOT NULL DEFAULT '[]',

    status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                                'pending', 'claimed', 'in_progress',
                                'submitted', 'approved', 'rejected',
                                'done', 'failed'
                            )),
    claimed_at              TEXT DEFAULT NULL,
    started_at              TEXT DEFAULT NULL,
    submitted_at            TEXT DEFAULT NULL,
    completed_at            TEXT DEFAULT NULL,
    rejected_count          INTEGER NOT NULL DEFAULT 0,
    rejection_reason        TEXT DEFAULT NULL,

    depends_on              TEXT NOT NULL DEFAULT '[]',
    blocks                  TEXT NOT NULL DEFAULT '[]',

    result                  TEXT DEFAULT NULL,
    artifacts               TEXT NOT NULL DEFAULT '[]',

    created_by              TEXT NOT NULL,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    version                 INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_tasks_board_column ON tasks(board_id, column_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned_agent ON tasks(assigned_agent_id);
CREATE INDEX idx_tasks_required_domain ON tasks(required_domain);
CREATE INDEX idx_tasks_priority ON tasks(priority);
```

#### task_events

```sql
CREATE TABLE task_events (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor_type      TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
    actor_id        TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN (
        'created', 'claimed', 'started', 'submitted',
        'approved', 'rejected', 'completed', 'failed',
        'moved', 'released', 'dependency_resolved'
    )),
    from_column_id  TEXT DEFAULT NULL,
    to_column_id    TEXT DEFAULT NULL,
    from_status     TEXT DEFAULT NULL,
    to_status       TEXT DEFAULT NULL,
    metadata        TEXT NOT NULL DEFAULT '{}',
    timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_events_task_id ON task_events(task_id);
CREATE INDEX idx_task_events_timestamp ON task_events(timestamp DESC);
CREATE INDEX idx_task_events_actor ON task_events(actor_type, actor_id);
```

#### task_dependencies

```sql
CREATE TABLE task_dependencies (
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_id),
    CHECK (task_id != depends_on_id)
);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_id);
```

### 2.3 TypeScript Type Definitions

```typescript
type AgentType = 'claude-code' | 'codex' | 'opencode';
type AgentDomain = 'frontend' | 'backend' | 'devops' | 'testing' | string;
type AgentStatus = 'idle' | 'working' | 'offline';
type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
type TaskStatus =
  | 'pending' | 'claimed' | 'in_progress'
  | 'submitted' | 'approved' | 'rejected'
  | 'done' | 'failed';
type ActorType = 'human' | 'agent' | 'system';
type EventAction =
  | 'created' | 'claimed' | 'started' | 'submitted'
  | 'approved' | 'rejected' | 'completed' | 'failed'
  | 'moved' | 'released' | 'dependency_resolved';

interface Board {
  id: string; name: string; description: string;
  columns: Column[]; createdAt: Date; updatedAt: Date;
}

interface Column {
  id: string; boardId: string; name: string; order: number;
  wipLimit: number | null; autoAdvance: boolean; requiresClaim: boolean;
  nextColumnId: string | null; isTerminal: boolean;
}

interface Agent {
  id: string; name: string; type: AgentType; domain: AgentDomain;
  capabilities: string[]; status: AgentStatus; currentTaskId: string | null;
  apiKeyHash: string; createdAt: Date; lastHeartbeat: Date;
  metadata: Record<string, unknown>;
}

interface Task {
  id: string; boardId: string; columnId: string; title: string;
  description: string; priority: TaskPriority; labels: string[];
  assignedAgentId: string | null; requiredDomain: AgentDomain | null;
  requiredCapabilities: string[];
  status: TaskStatus; claimedAt: Date | null; startedAt: Date | null;
  submittedAt: Date | null; completedAt: Date | null;
  rejectedCount: number; rejectionReason: string | null;
  dependsOn: string[]; blocks: string[];
  result: string | null; artifacts: Artifact[];
  createdBy: string; createdAt: Date; updatedAt: Date; version: number;
}

interface Artifact {
  type: 'file' | 'pr' | 'commit' | 'log' | 'screenshot';
  url: string; description: string; createdAt: Date;
}

interface TaskEvent {
  id: string; taskId: string; actorType: ActorType; actorId: string;
  action: EventAction; fromColumnId: string | null; toColumnId: string | null;
  fromStatus: TaskStatus | null; toStatus: TaskStatus | null;
  metadata: Record<string, unknown>; timestamp: Date;
}
```

---

## 3. Task State Machine

### 3.1 State Transition Table

| From State | Event | To State | Conditions | Side Effects |
|------------|-------|----------|------------|--------------|
| `pending` | `claim` | `claimed` | Task status=pending, no agent assigned | Set assignedAgentId, claimedAt; lock task |
| `claimed` | `start` | `in_progress` | Task claimed by calling agent | Set startedAt; update agent status to 'working' |
| `in_progress` | `submit` | `submitted` | Agent provides result + artifacts | Set submittedAt; move to Review column |
| `in_progress` | `release` | `pending` | Agent voluntarily releases | Clear assignedAgentId, claimedAt, startedAt |
| `in_progress` | `fail` | `failed` | Agent reports failure | Set completedAt |
| `submitted` | `approve` | `approved` | Human approves | Set completedAt; trigger auto-advance |
| `submitted` | `reject` | `rejected` | Human rejects with reason | Increment rejectedCount; set rejectionReason |
| `rejected` | `start` | `in_progress` | Agent acknowledges rejection | Clear rejectionReason; set startedAt |
| `approved` | `advance` | `done` | Auto-advance to terminal column | Set completedAt; unblock dependent tasks |
| `failed` | `retry` | `pending` | System or human retries | Clear assignedAgentId; reset timestamps |

### 3.2 State Transition Diagram

```
                    ┌─────────┐    claim     ┌─────────┐
   Human creates     │ PENDING │─────────────>│ CLAIMED │
   task              └─────────┘              └────┬────┘
                    ┌─────────┐<─── release ────┤
                    │ PENDING │<────────────────┤
                    └─────────┘                 │
                                                 │ start
                    ┌─────────┐<─── start ──────┤
                    │IN_PROGRESS│              │
                    └────┬────┘                │
                         │                     │
              ┌──────────┴──────────┐           │
              │ release             │ submit   │
              │                     │           │
         ┌────▼────┐          ┌─────▼─────┐    │
         │ PENDING │          │ SUBMITTED │    │
         └─────────┘          └─────┬─────┘    │
                                    │           │
                         ┌──────────┴──────────┐
                         │ approve             │ reject
                         │                     │
                   ┌─────▼─────┐          ┌───▼───┐
                   │ APPROVED  │          │REJECTED│
                   └─────┬─────┘          └───┬───┘
                         │ advance            │ start
                         │                    │
                   ┌─────▼─────┐              │
                   │   DONE    │              │
                   └───────────┘              │
                                                │
                   ┌─────────┐                  │
                   │ FAILED  │──────────────────┘
                   └────┬────┘    retry
                        │ retry
                   ┌────▼────┐
                   │ PENDING │
                   └─────────┘
```

### 3.3 Auto-Advance Logic

```typescript
async function autoAdvanceTask(taskId: string): Promise<void> {
  const task = await taskRepository.findById(taskId);
  const column = await columnRepository.findById(task.columnId);

  if (!column.autoAdvance) return;
  if (column.isTerminal) {
    await taskRepository.update(taskId, { status: 'done' });
    await unblockDependentTasks(taskId);
    return;
  }

  const nextColumn = await columnRepository.findById(column.nextColumnId);
  if (!nextColumn) return;

  if (nextColumn.wipLimit !== null) {
    const currentCount = await taskRepository.countByColumn(nextColumn.id);
    if (currentCount >= nextColumn.wipLimit) {
      await eventRepository.create({
        taskId, actorType: 'system', actorId: 'system',
        action: 'moved', metadata: { reason: 'wip_limit_reached', targetColumn: nextColumn.id }
      });
      return;
    }
  }

  await taskRepository.update(taskId, {
    columnId: nextColumn.id,
    status: nextColumn.isTerminal ? 'done' : 'pending',
  });

  await eventRepository.create({
    taskId, actorType: 'system', actorId: 'system', action: 'moved',
    fromColumnId: column.id, toColumnId: nextColumn.id,
    fromStatus: task.status, toStatus: nextColumn.isTerminal ? 'done' : 'pending',
  });

  await unblockDependentTasks(taskId);
}
```

### 3.4 Dependency Resolution

```typescript
async function unblockDependentTasks(completedTaskId: string): Promise<void> {
  const dependents = await taskRepository.findByDependency(completedTaskId);

  for (const dependent of dependents) {
    const allDepsResolved = await taskRepository.areAllDependenciesMet(dependent.id);
    if (allDepsResolved && dependent.status === 'pending') {
      await eventRepository.create({
        taskId: dependent.id, actorType: 'system', actorId: 'system',
        action: 'dependency_resolved', metadata: { unblockedBy: completedTaskId },
      });
    }
  }
}
```

---

## 4. API Specification

### 4.1 Authentication

**Human API (v1):** JWT Bearer token. Issued via simple login endpoint (`POST /api/auth/login`). Token expires after 24h. Passed as `Authorization: Bearer <token>` header.

**Agent API:** API key via header `X-Agent-API-Key: <key>`. Key stored as SHA-256 hash in `agents.api_key`. Each agent has one API key generated at registration; the plain key is returned once and never stored.

### 4.2 REST Endpoints

#### Boards

```
GET    /api/boards                          → { boards: Board[] }
POST   /api/boards                          → 201 { board: Board }
GET    /api/boards/:id                      → 200 { board, tasks, agents }
PATCH  /api/boards/:id                      → 200 { board }
DELETE /api/boards/:id                      → 204
```

#### Columns

```
POST   /api/boards/:boardId/columns         → 201 { column }
PATCH  /api/columns/:id                     → 200 { column }
DELETE /api/columns/:id                     → 204
```

#### Tasks

```
GET    /api/boards/:boardId/tasks            → 200 { tasks, total }
POST   /api/boards/:boardId/tasks            → 201 { task }
GET    /api/tasks/:id                        → 200 { task, events, dependencies, dependents }
PATCH  /api/tasks/:id                        → 200 { task }  (If-Match: version)
DELETE /api/tasks/:id                        → 204
```

#### Task Lifecycle

```
POST   /api/tasks/:id/claim      { agentId }              → 200 { task }  (human or API)
POST   /api/tasks/:id/move       { columnId, status? }    → 200 { task }
POST   /api/tasks/:id/approve    { reviewerId }           → 200 { task }
POST   /api/tasks/:id/reject     { reviewerId, reason }   → 200 { task }
POST   /api/tasks/:id/release    { reason }               → 200 { task }
POST   /api/tasks/:id/fail       { reason }               → 200 { task }

#### Agents

```

GET    /api/agents                              → { agents }
POST   /api/agents                               → 201 { agent, apiKey }
GET    /api/agents/:id                          → { agent, currentTask?, taskHistory }
PATCH  /api/agents/:id                          → { agent }
DELETE /api/agents/:id                          → 204
POST   /api/agents/:id/heartbeat { taskId? }    → { status, nextCheckIn }

```

#### Events & Streaming

```

GET    /api/tasks/:id/events  ?limit&offset     → { events, total }
GET    /api/boards/:id/stream                      → SSE stream

```

### 4.3 SSE Event Types

```typescript
type BoardEvent =
  | { type: 'task.created'; data: Task }
  | { type: 'task.updated'; data: Task }
  | { type: 'task.moved'; data: { taskId: string; fromColumn: string; toColumn: string } }
  | { type: 'task.claimed'; data: { taskId: string; agentId: string } }
  | { type: 'task.submitted'; data: { taskId: string; agentId: string } }
  | { type: 'task.approved'; data: { taskId: string; reviewerId: string } }
  | { type: 'task.rejected'; data: { taskId: string; reason: string } }
  | { type: 'task.completed'; data: { taskId: string } }
  | { type: 'task.failed'; data: { taskId: string; reason: string } }
  | { type: 'task.released'; data: { taskId: string; reason: string } }
  | { type: 'agent.status_changed'; data: { agentId: string; status: AgentStatus } }
  | { type: 'agent.heartbeat'; data: { agentId: string; taskId: string | null } }
  | { type: 'column.wip_limit_reached'; data: { columnId: string; limit: number } };
```

---

## 5. MCP Server Specification

### 5.1 Transport & Authentication

- **Transport:** stdio (spawned per agent session)
- **Authentication:** API key via environment variable `ORCY_API_KEY`
- **API URL:** via environment variable `ORCY_API_URL`
- **Agent ID:** via environment variable `ORCY_AGENT_ID`

The MCP server acts as a proxy — receives tool calls from the agent, authenticates, forwards to Kanban REST API.

### 5.2 Tool Definitions

#### `board_list_tasks`

List available tasks filtered by domain, status, and priority.

**Input:** `{ boardId: string, status?: "pending"|"claimed"|"in_progress", priority?: "low"|"medium"|"high"|"critical", limit?: number }`

**Output:** `{ tasks: Task[], total: number }`

#### `board_claim_task`

Atomically claim a task. Only one agent can claim at a time.

**Input:** `{ taskId: string }`

**Output (success):** `{ success: true, task: Task }`
**Output (failure):** `{ success: false, reason: "already_claimed"|"not_found"|"domain_mismatch", message: string }`

#### `board_update_task_status`

Update status of a claimed task.

**Input:** `{ taskId: string, status: "in_progress"|"failed", result?: string, artifacts?: Artifact[] }`

**Note:** Agents use `board_submit_task` to move to `submitted`. Only humans (via `POST /api/tasks/:id/approve`) can move a task to `done`. The `failed` status is used when an agent cannot complete the task.

#### `board_submit_task`

Submit completed task for human review.

**Input:** `{ taskId: string, result: string, artifacts?: Artifact[] }`

**Output:** `{ success: true, task: { id, status, columnId, submittedAt }, message: string }`

#### `board_get_task_context`

Get full context including dependencies and board state.

**Input:** `{ taskId: string }`

**Output:** `{ task, dependencies: Task[], blockedBy: Task[], blocking: Task[], boardContext }`

**Note:** The `task` object includes `rejectionReason` (string or null) — use this after a rejection to understand what needs to be fixed.

#### `board_release_task`

Release a claimed task back to pending pool.

**Input:** `{ taskId: string, reason: string }`

**Output:** `{ success: true, task: { id, status, assignedAgentId } }`

#### `board_heartbeat`

Signal agent is still alive and working.

**Input:** `{ taskId?: string, progress?: string }`

**Output:** `{ success: true, agentStatus: AgentStatus, nextCheckIn: number, taskStatus: TaskStatus }`

### 5.3 MCP Configuration

```json
// .mcp.json
{
  "mcpServers": {
    "kanban": {
      "command": "node",
      "args": ["/path/to/orcy-mcp-server/dist/index.js"],
      "env": {
        "ORCY_API_URL": "http://localhost:3000",
        "ORCY_AGENT_ID": "agent-uuid",
        "ORCY_API_KEY": "plain-api-key"
      }
    }
  }
}
```

---

## 6. Project Structure

```
orcy/
├── docs/                          # This directory
│   ├── 01-PRD.md                  # Product Requirements Document
│   ├── 02-SPEC.md                  # This file - Technical Specification
│   └── 03-PLAN.md                  # Implementation Plan
├── packages/
│   ├── api/                       # Kanban API Server (Fastify + TypeScript)
│   │   ├── src/
│   │   │   ├── index.ts           # Entry point
│   │   │   ├── routes/            # REST route handlers
│   │   │   ├── services/          # Business logic
│   │   │   ├── repositories/      # Database access
│   │   │   ├── models/           # Type definitions
│   │   │   ├── middleware/       # Auth, validation
│   │   │   ├── sse/              # SSE broadcaster
│   │   ├── db/                   # SQLite migrations
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── ui/                        # React Web UI
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── components/        # Board, TaskCard, AgentPanel, etc.
│   │   │   ├── hooks/             # useBoard, useTask, useSSE
│   │   │   ├── api/               # REST client
│   │   │   └── types/
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── mcp/                       # MCP Server (stdio)
│       ├── src/
│       │   ├── index.ts          # MCP entry point
│       │   ├── tools/             # Tool definitions
│       │   └── transport.ts       # Stdio transport
│       ├── package.json
│       └── tsconfig.json
├── scripts/
│   └── seed.ts                   # Dev seed data
├── package.json                   # Workspace root
└── README.md
```

---

## 8. Key Implementation Notes

### 8.1 Atomic Task Claiming

Uses `BEGIN IMMEDIATE` transactions in SQLite which provide write-lock serialization. Under high concurrency, claim requests may serialize and some may fail with a lock error. For high-concurrency production deployments, consider migrating to PostgreSQL with `SELECT ... FOR UPDATE SKIP LOCKED`.

### 8.2 Stale Task Detection

A background job runs every 60 seconds:

1. Find tasks where `status IN ('claimed', 'in_progress')` AND `startedAt < NOW() - INTERVAL '30 minutes'`
2. For each stale task, call `release_task` with reason `stale_timeout`
3. Set agent status to `offline` if its `lastHeartbeat` > 30 minutes ago

**Note:** A task enters `failed` status when an agent calls `board_update_task_status(taskId, "failed", { reason })`.

### 8.3 SSE Implementation

```typescript
// Each board has an EventEmitter
const boardStreams = new Map<string, EventEmitter>();

// API service publishes events
async function publishBoardEvent(boardId: string, event: BoardEvent) {
  const emitter = boardStreams.get(boardId);
  if (emitter) {
    emitter.emit('event', `data: ${JSON.stringify(event)}\n\n`);
  }
}

// SSE endpoint subscribes
app.get('/api/boards/:id/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  const emitter = boardStreams.get(req.params.id);
  emitter?.on('event', (data) => res.write(data));
  req.on('close', () => emitter?.off('event', ...));
});
```

### 8.4 Domain Routing

When `board_list_tasks` is called:

1. Agent's domain is looked up from `ORCY_AGENT_ID`
2. Tasks filtered: `required_domain IS NULL OR required_domain = agent.domain`
3. Also filter by agent's capabilities if `required_capabilities` is set
4. Only tasks in `pending` status with all dependencies met are returned
