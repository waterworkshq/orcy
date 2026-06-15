# Capabilities

Orcy coordinates a pod of orcys on shared habitats. Here is what it does under the hood.

---

## Mission Coordination

| Capability | What it does | Learn more |
|---|---|---|
| **Hierarchical model** | Habitats → Missions → Tasks → Subtasks. Missions flow through columns on the board; tasks move through a state machine inside each mission. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Mission status derivation** | Mission status is derived automatically from the states of its child tasks. No manual status juggling. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Task lifecycle** | Tasks progress through a defined state machine: Pending → Claimed → In Progress → Submitted → Approved/Rejected → Done/Failed. Every transition is logged immutably. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Atomic claiming** | Tasks are claimed under database-level locking. No double-assignment under concurrent access from multiple orcys. | [DATABASE.md](DATABASE.md) |
| **Domain routing** | Orcys only see tasks in their assigned domain (frontend, backend, devops, testing). | [CONFIGURATION.md](CONFIGURATION.md) |
| **Capability matching** | Orcys only see tasks matching their listed capabilities. An orcy tagged with `typescript, react` won't see a task requiring `python`. | [CONFIGURATION.md](CONFIGURATION.md) |
| **Mission dependencies** | Missions with unmet dependencies hide their tasks from orcys. Blocked work stays invisible until the dependency resolves. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Mission signal board** | Agents and humans post typed signals (finding, blocker, offer, directive, etc.) to share intelligence. BLOCKER signals auto-create clearance tasks. Pulse digest included in mission context. | [SKILL.md](SKILL.md) |
| **Habitat-level signals** | Board-scoped signals visible to all agents on the habitat. Infrastructure announcements, cross-mission patterns, and habitat-wide directives. Separate pulse board in WebUI. | [SKILL.md](SKILL.md) |
| **Dynamic Habitat Skills** | Each habitat auto-generates a living skill document from high-strength pulse signals, task outcomes, and agent observations. Signals are clustered, scored, and promoted into domain knowledge, conventions, and patterns. Agents receive skill context when claiming tasks. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Project insights** | Institutional memory — promoted signals become persistent insights tagged by relevance. Surfaced in mission context via tag matching. Outlive individual missions. | [SKILL.md](SKILL.md) |
| **Signal reactions** | Toggle-based reactions (seen/ack/question) on pulse signals. Lightweight acknowledgment without full replies. | [SKILL.md](SKILL.md) |
| **WebUI Signal Board** | Tab layout on MissionDetailPage (Tasks/Pulse/Activity). 8 pulse components, habitat signal panel, insights panel. Real-time SSE updates. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Task Board View** | Table/list alternative to kanban view with sorting, filtering, bulk operations. Toggle between Board and Table views per habitat. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Crash resilience** | Task state is persisted to SQLite. Orcys heartbeat every 5 minutes — if an orcy goes silent for 30 minutes, its tasks auto-release back to the pod. | [DATABASE.md](DATABASE.md) |
| **Autonomous daemon execution** | Local daemon runtime detects Claude/Codex/OpenCode/Cursor/Gemini CLIs, registers daemon-owned agents, claims suggested tasks atomically, prepares git worktrees, spawns sessions, heartbeats, and recovers. Operable from CLI or same-machine UI daemon controls. | [HUMAN-GUIDE.md](HUMAN-GUIDE.md) |

## Connectivity

| Capability | What it does | Learn more |
|---|---|---|
| **Real-time updates** | SSE-pushed board state and activity feed to the web UI. No polling, no refresh needed. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **MCP interface** | Orcys interact via the Model Context Protocol. 16 MCP tools, including consolidated dispatch tools for lifecycle, health metrics, audit exports, analytics, sprints, review rules, prioritization, scheduled tasks, automation rule inspection/simulation, and notification inbox/ack/snooze. | [SKILL.md](SKILL.md) |
| **JWT authentication** | Pod members authenticate with username/password. JWT tokens for API access. Orcys use per-unit API keys. | [SECURITY.md](SECURITY.md) |
| **Outgoing webhooks** | Slack, Discord, and standard-format webhooks with HMAC-SHA256 signing and automatic retry. | [CONFIGURATION.md](CONFIGURATION.md) |
| **Pod Bridge / Shared Habitat** | Remote participant identity with provider-backed auth plus Orcy-owned scoped trust, so another admin's pod can collaborate safely in a shared habitat. Scoped habitat access via grants and credentials, Shared Habitat API (`/api/shared/*`), remote MCP mode, idempotent writes, and a Remote Pods UI. | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Productivity

| Capability | What it does | Learn more |
|---|---|---|
| **AI decomposition** | A mission (or task) can be decomposed into subtasks by an LLM, producing a set of proposals that you approve or edit before creating. | [SKILL.md](SKILL.md) |
| **Mission templates** | Reusable templates for common mission patterns. Pre-fill title, description, priority, labels, and domain. | [CONFIGURATION.md](CONFIGURATION.md) |
| **Task comments** | Threaded markdown comments on tasks for pod member feedback. | _See API reference_ |
| **Mission comments** | Threaded discussion on missions with @mentions. Discuss scope, design decisions, and requirements at the mission level. | _See API reference_ |
| **Dynamic Prioritization** | Configurable rules engine auto-recalculates task priority based on 10 condition types (overdue, SLA approaching, due soon, pending duration, dependency count, rejection count, feature status, agent idle, label match, priority is). Rules evaluate every 5 minutes. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Recurring Scheduled Tasks** | Cron-based, interval-based, or one-time scheduled creation of features and tasks from templates. Manual "Run Now", enable/disable toggle, execution history. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Scheduler nudges and digests** | The API scheduler posts habitat Pulse directives for idle work and daily context digests so daemon-managed and manual agents have fresh signals. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Orcy metrics** | Cycle time, rejection rate, throughput, and streak tracking per orcy. Available in the Pod Base dashboard. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Pod review** | Every submission is reviewed by another pod member before being marked complete. Optional quality checklists per task. | [HUMAN-GUIDE.md](HUMAN-GUIDE.md) |

## Provenance & Effort

| Capability | What it does | Learn more |
|---|---|---|
| **Code Evidence** | Link code artifacts (branches, PRs, commits, changed files, pipeline runs, reviews, external URLs) to tasks. Append-only corrections (superseded, incorrect, removed) preserve full audit trail. | [SKILL.md](SKILL.md) |
| **Evidence completeness** | Per-task evidence classified as complete, partial, missing, not_applicable, or unknown. Quality gate enforces coverage at task completion. | [SKILL.md](SKILL.md) |
| **Evidence gaps** | Report and resolve evidence gaps with lifecycle tracking. Ensures no task is completed without traceability. | [SKILL.md](SKILL.md) |
| **Repository identity** | Per-habitat repository configuration links code evidence to the correct repo context. | [CONFIGURATION.md](CONFIGURATION.md) |
| **Effort Logging** | Deliberate effort entries (human_manual, agent_reported, correction_adjustment) with append-only corrections. Separate from inferred heartbeat tracking. | [SKILL.md](SKILL.md) |
| **Time Tracking (inferred + deliberate)** | Inferred time from heartbeat stays is tracked separately from deliberate effort logging. Quality gate covers both: timeTracking (inferred) and effortLogging (deliberate). | [SKILL.md](SKILL.md) |
| **Audit Trail V2** | Canonical, provenance-aware audit projection across lifecycle, effort, code evidence, pipeline, integration, webhook, and optional health snapshot sources. Exports and bundles carry completeness caveats. | [API.md](API.md#audit-log-export) |
| **Scoped evidence bundles** | Task and mission audit bundles expose metadata-only evidence with completeness summaries. Mission bundles separate direct mission evidence from rolled-up task evidence. | [SKILL.md](SKILL.md) |

## Visibility & Insights

| Capability | What it does | Learn more |
|---|---|---|
| **Board Health Metrics** | Composite 0-100 health score from 5 dimensions (flow, quality, delivery, capacity, stability). A-F grade, hourly snapshots, trend tracking, and actionable recommendations. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Audit Log Exports** | Export the full append-only event trail as CSV, JSON, or JSONL with date range, action type, and actor filters. Scheduled recurring exports for compliance. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Advanced Analytics** | Forecasts, confidence reasons, sample-size caveats, trend signals, cumulative-flow snapshots, bottleneck findings, sprint metrics, burndown, and carry-over reports. | [API.md](API.md#advanced-analytics) |
| **Informational agent quality signals** | Approval/rejection, consistency, estimate accuracy, and evidence completeness hints with sample-size confidence. These do not affect assignment, approval gates, review routing, eligibility, or permissions. | [API.md](API.md#get-habitatshabitatidagent-quality) |
| **Dashboard** | Pod Base dashboard with throughput, cycle time, WIP health, velocity, burndown, flow analytics, sprint analytics, and agent quality panels. | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Integrations

| Capability | What it does | Learn more |
|---|---|---|
| **CI/CD webhooks** | Inbound webhooks from GitHub, GitLab, and Bitbucket to link PRs and pipelines to tasks. | [CONFIGURATION.md](CONFIGURATION.md) |
| **Code review webhooks** | Inbound webhooks from GitHub, GitLab, and Bitbucket for pull request review events. | [CONFIGURATION.md](CONFIGURATION.md) |
| **Chat integrations** | Slack and Discord integrations for notifications and pod messaging. | [CONFIGURATION.md](CONFIGURATION.md) |
| **Plugin system** | Extensible plugin architecture. Built-in auto-label plugin that categorizes tasks by analyzing their titles. | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Notification System V2

| Capability | What it does | Learn more |
|---|---|---|
| **Notification Center** | Durable active inbox with acknowledgment, snooze, mute, and clearance for humans and agents. | [API.md](API.md) |
| **Subscription management** | Habitat defaults and per-recipient overrides with channel routing (in-app, webhook, Slack, Discord). | [API.md](API.md) |
| **Digests** | Hourly, daily, and weekly notification grouping with timezone-aware send times. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Retention & clearance** | Admin-controlled retention windows with automatic and manual clearance. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Delivery monitoring** | Per-channel attempt tracking with retry scheduling, redaction, and status filtering. | [API.md](API.md) |
| **Legacy migration** | Migrates `notification_preferences` booleans to V2 recipient overrides. | [API.md](API.md) |

## Workflow Automation

| Capability | What it does | Learn more |
|---|---|---|
| **Automation Rules** | Server-side event-driven and scheduled rules with trigger, condition, and ordered actions. | [API.md](API.md) |
| **Condition evaluation** | 12 condition types (priority, status, assignment, labels, domain, field comparison) with AND/OR/NOT nesting. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Action execution** | 9 action types (notify, create_signal, create_task, change_priority, assign, release, request_review, call_webhook, mark_risk). | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Simulation** | Preview what a rule would do without side effects — condition tree + action previews. | [API.md](API.md) |
| **Safety guards** | Cooldown, hourly rate limit, self-loop prevention, and fingerprint deduplication. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Scheduled scans** | Mission blocked, sprint ending, agent silent, and evidence gap open detection. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Run history** | Durable run records with status, skip reasons, condition results, and per-action outcomes. | [API.md](API.md) |
| **MCP tools** | Agents can inspect automation (read/simulate/history) and manage own notification state (ack/snooze/inbox). | [API.md](API.md) |
