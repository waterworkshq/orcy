# Product Requirements Document (PRD)

# Orcy — AI Agent Task Orchestration Platform

**Version:** 1.0  
**Date:** April 2, 2026  
**Status:** Draft  

---

## 1. Executive Summary

Orcy is a task orchestration platform that bridges human project management with autonomous AI agent execution. It provides a kanban-style board where tasks are created, persisted, and assigned to AI agents (Claude Code, OpenAI Codex CLI, OpenCode) that operate within their assigned domains. Agents autonom claim tasks, work on them, submit results, and tasks advance through the pipeline automatically upon approval.

The system combines a task management kanban layer with agent routing and human oversight.

---

## 2. Problem Statement

### 2.1 Current State

- AI coding agents (Claude Code, Codex, OpenCode) operate in isolation within terminal sessions
- No shared workspace exists for coordinating multiple agents across domains
- Task state is ephemeral — if a session crashes, progress is lost
- No mechanism for agents to self-organize, claim work, or report completion
- Humans must manually switch between agent sessions, assign work, and track progress

### 2.2 Pain Points

1. **No task persistence** — Agent work exists only in session memory
2. **No coordination** — Multiple agents cannot collaborate on a shared backlog
3. **No state machine** — Tasks don't flow through defined phases automatically
4. **No domain isolation** — Agents can't be restricted to their area of expertise
5. **No audit trail** — No record of who did what, when, and why
6. **No crash recovery** — Session failures lose all progress

---

## 3. Goals

### 3.1 Primary Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G1 | Persistent task state that survives crashes | 100% task recovery after simulated crash |
| G2 | Atomic task claiming — no double-assignment | Zero race conditions in concurrent claims |
| G3 | Automatic phase advancement on completion | Tasks move to next column without manual intervention |
| G4 | Domain-based agent routing | Agents only see tasks in their assigned domain |
| G5 | Human-in-the-loop review gate | Every task requires human approval before Done |
| G6 | Full audit trail | Every state change logged with actor, timestamp, reason |

### 3.2 Secondary Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G7 | Real-time board updates via SSE | < 1s latency from state change to UI update |
| G8 | Stale task detection and auto-release | Tasks idle > 2h automatically released |
| G9 | Task dependencies with auto-unblock | Dependent tasks auto-claim when blockers resolve |
| G10 | Multi-board support | Multiple projects tracked independently |

---

## 4. User Personas

### 4.1 Human Project Manager (Primary User)

- Creates and prioritizes tasks on the kanban board
- Assigns tasks to agent domains (frontend, backend, devops, testing)
- Reviews agent submissions and approves/rejects
- Monitors board health, agent activity, and bottlenecks
- Needs: Clear visibility, quick review workflow, easy task creation

### 4.2 AI Agent (Primary Consumer)

- Claude Code, OpenAI Codex CLI, or OpenCode instance
- Polls or receives notifications for available tasks in its domain
- Claims tasks atomically, works on them, submits results
- Receives feedback on rejections and reworks
- Needs: Clear task descriptions, unambiguous acceptance criteria, reliable state reporting

### 4.3 Stakeholder (Observer)

- Views board progress without editing
- Needs: Read-only dashboard, progress metrics, completion reports

---

## 5. Functional Requirements

### FR-1: Board Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1.1 | Users can create, edit, and delete kanban boards | Must Have |
| FR-1.2 | Boards contain configurable columns with custom names and order | Must Have |
| FR-1.3 | Columns support WIP (Work In Progress) limits | Should Have |
| FR-1.4 | Columns can be configured for auto-advance to next column | Must Have |
| FR-1.5 | Boards support multiple concurrent projects | Should Have |

### FR-2: Task Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | Users can create tasks with title, description, priority, labels | Must Have |
| FR-2.2 | Tasks support domain assignment (which agent domain can handle it) | Must Have |
| FR-2.3 | Tasks support capability requirements (specific skills needed) | Should Have |
| FR-2.4 | Tasks can have dependencies on other tasks (DAG) | Must Have |
| FR-2.5 | Tasks display full audit trail of all state changes | Must Have |
| FR-2.6 | Tasks can be searched and filtered by multiple criteria | Should Have |
| FR-2.7 | Tasks support artifact attachment (PRs, commits, files) | Must Have |

### FR-3: Task Lifecycle

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | Tasks flow through: Pending → Claimed → In Progress → Submitted → Approved → Done | Must Have |
| FR-3.2 | Rejected tasks return to In Progress with rejection reason | Must Have |
| FR-3.3 | Task claiming is atomic — only one agent can claim a task | Must Have |
| FR-3.4 | Claimed tasks are blocked from other agents | Must Have |
| FR-3.5 | Completed tasks auto-advance to next column | Must Have |
| FR-3.6 | Failed tasks auto-retry or return to pending | Should Have |

**FR-3.6 Note:** A task enters `failed` status when an agent calls `board_update_task_status(taskId, "failed", { reason })`. Failed tasks return to `pending` pool for re-claiming.

### FR-4: Agent Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | Agents can be registered with name, type, domain, capabilities | Must Have |
| FR-4.2 | Agents have statuses: idle, working, offline | Must Have |
| FR-4.3 | Agents authenticate via API key for MCP access | Must Have |
| FR-4.4 | Agents send heartbeats to maintain active status | Must Have |
| FR-4.5 | Offline agents (>2h no heartbeat) have tasks auto-released | Must Have |
| FR-4.6 | Agents can only access tasks in their assigned domain | Must Have |

### FR-5: Agent-Board Interaction

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.1 | Agents discover available tasks via MCP tool calls | Must Have |
| FR-5.2 | Agents claim tasks via atomic MCP tool call | Must Have |
| FR-5.3 | Agents update task status (in_progress, submitted, done) via MCP | Must Have |
| FR-5.4 | Agents submit results with artifact links via MCP | Must Have |
| FR-5.5 | Agents can release tasks back to pending if blocked | Must Have |
| FR-5.6 | Agents receive task context including dependencies | Should Have |

### FR-6: Human Review

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.1 | Submitted tasks appear in Review column for human inspection | Must Have |
| FR-6.2 | Humans can approve tasks (moves to Done or next column) | Must Have |
| FR-6.3 | Humans can reject tasks with reason (moves back to In Progress) | Must Have |
| FR-6.4 | Rejection count tracked per task | Should Have |
| FR-6.5 | Review panel shows task details, artifacts, and activity log | Must Have |

### FR-7: Real-Time Updates

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-7.1 | Board updates in real-time via Server-Sent Events (SSE) | Must Have |
| FR-7.2 | Task detail panel updates when task state changes | Must Have |
| FR-7.3 | Agent status changes reflected in real-time | Should Have |

---

## 6. Non-Functional Requirements

### NFR-1: Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1.1 | Board load time | < 500ms for boards with up to 200 tasks |
| NFR-1.2 | Task claim latency | < 100ms (including database transaction) |
| NFR-1.3 | SSE event delivery | < 1s from state change to client receipt |
| NFR-1.4 | Concurrent agent claims | Handle 50+ simultaneous claim requests |

### NFR-2: Reliability

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-2.1 | Task state durability | Zero data loss on server crash |
| NFR-2.2 | Claim atomicity | Zero double-claims under concurrent access |
| NFR-2.3 | Stale detection | Detect and release stale tasks within 30min of threshold |

### NFR-3: Security

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-3.1 | Agent authentication | API key required for all MCP operations |
| NFR-3.2 | Domain isolation | Agents cannot access tasks outside their domain |
| NFR-3.3 | Audit logging | Every mutation logged with actor identity |
| NFR-3.4 | Local-first deployment | Default bind to 127.0.0.1 |
| NFR-3.5 | Human authentication | JWT Bearer token for web UI (v1). Agent auth via per-agent API key. |

### NFR-4: Scalability

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-4.1 | Task volume | Support 10,000+ tasks per board |
| NFR-4.2 | Agent count | Support 100+ registered agents |
| NFR-4.3 | Board count | Support 50+ concurrent boards |

---

## 7. Out of Scope (v1.0)

- Agent-to-agent communication/delegation
- Automatic task decomposition by AI
- Git worktree management
- PR creation and merging automation
- Multi-tenant / team collaboration
- Mobile app
- Custom workflow builder UI
- Billing / usage tracking
- Plugin ecosystem

---

## 8. Success Criteria

### 8.1 Launch Criteria

- [ ] All Must Have functional requirements implemented
- [ ] Zero data loss in crash recovery tests
- [ ] Zero race conditions in concurrent task claiming
- [ ] At least one AI agent (Claude Code) can complete full task lifecycle via MCP
- [ ] Human can create, review, and approve tasks via web UI
- [ ] Real-time board updates working
- [ ] All Must Have functional requirements implemented

### 8.2 Post-Launch Metrics

- Tasks complete end-to-end without manual intervention (auto-advance)
- Agent claim success rate > 99%
- Average task cycle time measurable and trackable
- Zero orphaned tasks (all tasks reach terminal state or are released)

---

## 9. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Agent session complexity | Medium | Low | Design MCP tools to be composable; fallback to REST API |
| MCP tool limitations for complex agent workflows | Medium | Medium | Design MCP tools to be composable; fallback to REST API |
| Agent session crashes lose partial work | High | High | Agent re-reads task on restart |
| Race conditions in task claiming | Critical | Medium | Database-level locking (SELECT FOR UPDATE SKIP LOCKED) |
| Stale tasks block pipeline | Medium | High | Auto-release after configurable timeout with event logging |
| Agent session crashes lose partial work | High | High | Agent re-reads task state on restart; no durable workflow state |

---

## 10. Dependencies

| Dependency | Purpose | Version |
|------------|---------|---------|
| Node.js | Runtime for API and MCP server | >= 20.0 |
| PostgreSQL / SQLite | Data persistence | PG >= 15, SQLite >= 3.40 |
| @modelcontextprotocol/sdk | MCP server implementation | Latest |
| React 19 | Web UI framework | 19.x |
| Docker | Containerized deployment | Latest |

---

## 11. Glossary

| Term | Definition |
|------|------------|
| **Board** | A kanban board representing a project or sprint |
| **Column** | A stage in the task workflow (e.g., Todo, In Progress, Review, Done) |
| **Task** | A unit of work with description, priority, and lifecycle state |
| **Agent** | An AI coding agent (Claude Code, Codex, OpenCode) registered in the system |
| **Domain** | An agent's area of expertise (frontend, backend, devops, testing) |
| **Claim** | The atomic action of an agent taking ownership of a task |
| **Auto-advance** | Automatic movement of a task to the next column upon completion |
| **MCP** | Model Context Protocol — standard for AI agent tool interaction |
| **WIP Limit** | Maximum number of tasks allowed in a column simultaneously |
| **Stale Task** | A claimed task with no agent heartbeat for the configured duration (default 30 min) |
| **JWT Bearer Token** | JSON Web Token — stateless authentication for human users; issued by the API on login |
