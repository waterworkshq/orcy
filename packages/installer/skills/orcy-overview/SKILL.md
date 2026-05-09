---
name: orcy-overview
description: Overview of the orcy hierarchical model — Mission -> Task -> Subtask, status rules, authentication, and tool selection
license: MIT
---

# Orcy Overview — Hierarchical Model & Authentication

This skill defines the **data model, authentication, and decision framework** for Orcy. It is a companion to the CLI usage and MCP usage skills.

---

## Hierarchy

```
Habitat
  +-- Mission (orcy card, flows through columns)
       +-- Task (work unit, claimed by agents)
            +-- Subtask (simple checklist item)
```

### Habitat

The top-level container. A habitat represents a project or sprint with configurable columns (e.g., Backlog, In Progress, Review, Done). Habitats contain missions.

### Mission

A mission is a kanban card that moves across columns. It represents a product initiative (e.g., "Implement Authentication"). Missions are **not** assigned to agents — they contain tasks which are.

Mission properties:
- Title, description, acceptance criteria
- Priority (low, medium, high, critical)
- Labels for categorization
- Dependencies on other missions (`dependsOn` / `blocks`)
- SLA timeout, due date
- Status: **auto-derived** from child task states

### Task

A task is a unit of work inside a mission. Agents **claim** tasks to lock them, then work through the lifecycle.

Task properties:
- Title, description, priority
- `requiredDomain` (frontend, backend, devops, testing, fullstack)
- `requiredCapabilities` (e.g., `["typescript", "postgresql"]`)
- `estimatedMinutes`, `version` (optimistic locking)
- Dependencies on other tasks
- Quality checklist with gated completion

### Subtask

Simple checklist item within a task. Has a title, completion flag, and optional assignee. No lifecycle — just done/not-done.

---

## Mission Status — Auto-Derivation

Mission status is **never set manually**. It is computed from child task states:

| Mission Status | Condition |
|---------------|-----------|
| `not_started` | All tasks are pending |
| `in_progress` | Any task is claimed, in_progress, submitted, approved, or rejected |
| `review` | All tasks submitted, approved, or done; none pending/in_progress/claimed |
| `done` | All tasks done or approved; at least one is done |
| `failed` | Any task failed and none being actively worked on |

### Column Mapping

Missions auto-advance to the correct column based on derived status:

| Status | Target Column |
|--------|--------------|
| `not_started` | First column (Backlog) |
| `in_progress` | Second column (In Progress) |
| `review` | Second-to-last non-terminal column (Review) |
| `done` | Terminal column (Done) |
| `failed` | Stays in current column |

---

## Artifact Types

When submitting artifacts (PR links, logs, screenshots), use one of these types:

| Type | When to Use |
|------|-------------|
| `pr` | Pull request URL (most common for code tasks) |
| `commit` | Direct commit link |
| `file` | Link to a modified file |
| `screenshot` | Visual evidence of changes |
| `log` | Build output, test results, error logs |

---

## Authentication & Environment Variables

Set these in your environment or `.env`:

```
ORCY_API_URL=http://localhost:3000
ORCY_HABITAT_ID=your-habitat-uuid
ORCY_AGENT_ID=your-agent-uuid
ORCY_API_KEY=your-api-key
```

The API key authenticates all requests. The agent identity is **derived from the key** — request body fields for agent ID are ignored by the server. This prevents impersonation.

For agent registration (first time), set `ORCY_REGISTRATION_TOKEN` if your server requires one.

---

## When to Use CLI vs MCP

| Scenario | Recommended Tool | Reason |
|----------|-----------------|--------|
| Interactive shell session | CLI (`orcy ...`) | Faster for ad-hoc queries |
| Agent automation in code | MCP (`orcy_habitat({...})`) | Structured input/output, no parsing |
| Quick habitat summary | CLI `orcy habitat summary` | Single command, grep-friendly |
| Within an agent session | MCP | Tool calls are native to agent context |
| Daemon management | CLI `orcy serve start --detach` | Only available via CLI |
| Bulk operations | CLI `orcy admin batch-*` | Shell piping, scripting |
| Cross-agent communication | MCP (`orcy_habitat_message({...})`) | Agent-readable structured messages |

### Prefer MCP for Intra-Session Tool Use

If you have the MCP server configured, use MCP dispatch tools when operating from within an agent session. The CLI is best for human-driven shell workflows, debugging, and daemon management.

---

## Critical: Context Before Action

Always call `orcy_habitat({ action: "summary" })` or `orcy habitat summary` FIRST. Understand the habitat state before diving into individual missions. This prevents context pollution from loading every mission individually.
