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
| **MCP interface** | Orcys interact via the Model Context Protocol. 18 MCP tools, including consolidated dispatch tools for lifecycle, health metrics, audit exports, analytics, sprints, review rules, prioritization, scheduled tasks, automation rule inspection/simulation, notification inbox/ack/snooze, workflow context, and failure context retrieval. | [SKILL.md](SKILL.md) |
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

## Workflow Orchestration (v0.20)

| Capability | What it does | Learn more |
|---|---|---|
| **Mission-scoped workflow DAGs** | Optional orchestration plan attached to a mission declaring typed dependency gates between tasks. Tasks are nodes (1:1); gates are edges. Missions without workflows behave as before — any agent can claim any task. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Typed workflow gates** | Five gate types: `on_complete` (upstream task completed), `on_approve` (upstream task approved), `on_signal` (matching pulse signal posted), `on_manual` (admin unblock), `on_fail` (upstream task failed — spawns recovery). A sixth type `on_automation` is planned for v0.20.1. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Join specs** | Fan-in semantics for tasks with multiple upstream gates: `all_of` (all must fire), `any_of` (any one), `n_of` (quorum). Keyed by downstream task; applies to all upstream gates regardless of type. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Conditional edge predicates** | Optional predicate on each gate edge using the v0.18 AutomationCondition language. Gate fires only when both the match config matches AND the condition evaluates true. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Derived claim constraints** | Workflow gates are checked at claim time as a derived constraint — no new task status. Tasks with unsatisfied gates stay `pending` and return `workflow_gates_unmet` on claim. Zero changes to `IClaimStrategy` or `runPollTick`. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Two-channel event bus** | `onTransition` hook (new in v0.20, fires for all task actions) feeds the workflow service. Existing `onTaskEvent` (fires for 4 lifecycle-completing actions only) feeds habitat skill generation. Two channels, two audiences. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Blocked-by-workflow filter** | Server-side derived filter (EXISTS subquery on `task_workflow_gates`) surfaces tasks blocked by unsatisfied gates. Sets precedent as the first server-side computed filter. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Workflow CRUD** | Admin routes under `/api/v1/missions/:id/workflow` for attach, get, patch (OCC), detach, and manual gate unblock. Cross-pod agents get read-only access via `/api/shared/missions/:id/workflow` and `/api/shared/tasks/:id/workflow-context`. | [API.md](API.md) |

## Workflow Error Handling (v0.20)

| Capability | What it does | Learn more |
|---|---|---|
| **`on_fail` recovery tasks** | When a task fails (`failed`/`rejected`/heartbeat-lost), the workflow's failure handler spawns a recovery task gated by `on_fail`. Recovery tasks are normal tasks — claimed, submitted, reviewed via the existing pipeline. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Structured FailureContext** | On failure, the system captures a bundle: artifacts produced before failure, recent lifecycle events (last 20), agent experience signals (last 50), retry history (last 10), and category summary. Recovery agents read this via the `orcy_get_failure_context` MCP tool. | [SKILL.md](SKILL.md) |
| **Recovery redemption** | When a recovery task succeeds (`approved`/`completed`), the originally failed task's downstream `on_complete`/`on_approve` gates fire as if the original had succeeded. The failed task stays failed in history; redemption is a forward-flowing unblock. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Two recovery attempts maximum** | Recovery chains: original (depth 0) → recovery (depth 1) → recovery-of-recovery (depth 2) → STOP. Deeper failure emits `workflow_recovery_unrecoverable` audit event and notification for human intervention. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Per-task failure handler overrides** | Workflow declares one default failure handler. Individual tasks may override it: set an object to use a specific handler, or set `null` to explicitly disable recovery for that task. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Recovery notifications** | Three notification events: `workflow.recovery_started`, `workflow.recovery_succeeded`, `workflow.recovery_unrecoverable`. Subscribe-able through existing Notification System V2 channels. | [API.md](API.md) |
| **Workflow audit source** | New `"workflow"` audit source for recovery events. New audit kinds: `recovery`. | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Agent Experience Self-Reporting (v0.20)

| Capability | What it does | Learn more |
|---|---|---|
| **Experience signals** | Agents post implicit experience signals via the existing `orcy_pulse` tool with `signalType: "experience"` and a category: `stuck`, `confused`, `backtrack`, `surprised`, `ambiguous`, `sidetracked`, `smooth`. Both mid-task and completion-summary signals supported. | [SKILL.md](SKILL.md) |
| **Pulse pipeline integration** | Experience signals flow through the existing pulse pipeline — no new tables, no new services. `signalType` enum widens by one value; 7 categories live in `metadata.experience`. Consolidated `SIGNAL_TYPES` const in `@orcy/shared`. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Skill ingestion** | Experience signals are ingested into habitat skills via `habitatSkillService.ingestExperienceSignal`. Category maps to skill type: `stuck`/`confused`/`backtrack` → pitfall, `surprised`/`ambiguous` → domain_knowledge, `smooth` → pattern, `sidetracked` → pitfall (stopgap until `anti_patterns` SkillCategory lands in v0.20.1). Equal per-signal weight; frequency drives strength. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **FailureContext bridge** | `FailureContext.experienceSignals` captures the failing agent's recent experience signals — the recovery agent sees what the original agent noticed before failure. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Experience summary card** | Collapsed card in task timeline showing aggregate signal counts by category. Expandable to individual signal cards. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Per-agent metrics** | Signals/task ratio, category distribution, and outlier detection surfaced in admin UI. No automatic action — display only. | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Workflow Templates (v0.20)

| Capability | What it does | Learn more |
|---|---|---|
| **Workflow template column** | Existing `missionTemplates` table extended with `workflowTemplate: JSON` column (separate from `tasksTemplate`). `applyTemplate` instantiates mission + tasks + workflow + gates in one transaction. | [DATABASE.md](DATABASE.md) |
| **Template variables** | Named placeholders (`{{feature_name}}`) substituted at instantiation into task titles, descriptions, gate match configs, and recovery task templates. Runtime tokens (`{{failedTaskTitle}}`) left intact for later resolution by the recovery subsystem. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Default workflow templates** | Two shipped defaults: "Build-Test-Review-Deploy" (4-task sequential `on_approve` chain with failure handler) and "Parallel Investigation" (5-task fan-out/fan-in with `any_of` join). Seeded globally; idempotent per-name. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Form-based authoring** | UI editor with gate rows (upstream → type → downstream → match config → condition), collapsible sections for join specs, failure handler, and variables. JSON import/export round-trip. Live SVG DAG preview via dagre layout. | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Task template keys** | `TaskTemplateEntry.key` provides stable cross-references for gate source/target mapping. Auto-generated as `task_1`, `task_2` if absent. | [DATABASE.md](DATABASE.md) |
| **DAG visualization** | Mission detail page renders live workflow DAG with color-coded gate states (green=satisfied, gray=unsatisfied, red=failed). Click gate for side panel with state details and manual unblock (admin only). | [ARCHITECTURE.md](ARCHITECTURE.md) |
