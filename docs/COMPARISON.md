# How Orcy Compares

> When you run multiple AI coding agents, you need **coordination** — not just isolation. Git worktrees isolate. Orcys coordinate.

This page places Orcy in the broader landscape. It has two parts:

1. **Direct peers** — other *multi-agent coding orchestrators* you'd evaluate alongside Orcy.
2. **Adjacent categories** — single-agent tools, autonomous SWE SaaS, frameworks, and chat-native agents. These aren't apples-to-apples, but people compare them, so we explain where Orcy fits.

We try to be honest. Every tool below wins somewhere. Orcy loses to some of them on purpose — it is opinionated about a specific problem (coordinating a pod), not a general-purpose everything-tool.

Last updated: June 2026. Star counts, pricing, and feature status change. Verify against each project's own docs before deciding.

---

## Part 1 — Direct peers: multi-agent coding orchestrators

These tools share Orcy's core thesis: multiple AI coding agents need a shared coordination layer beyond parallel git worktrees.

| Tool | Shape | Coordination model | MCP native | Self-hosted | License |
|---|---|---|---|---|---|
| **Orcy** | CLI + Web UI + MCP server | Transactional claiming, domain routing, review rules, breach gates, PULSE signals, workflow DAGs | Yes (22 tools) | Yes (local-first) | MIT |
| **Claude Squad** | TUI (tmux) | Session manager, human-in-the-loop | No | Yes | MIT-ish |
| **Bernstein** | CLI + lib + MCP | Deterministic scheduler, Janitor verification | Server mode | Yes | MIT |
| **Composio AO** | Web dashboard + CLI | Milestone gates, auto CI retry | No | Yes | Source-available |
| **Vibe Kanban** | Web app + MCP | Kanban board + MCP decomposition | Decomposition only | Yes (community) | MIT |
| **Emdash** | Electron desktop | Parallel dispatch, human-supervised | No | Yes | Proprietary |

### Task claiming

Most orchestrators assign tasks manually or via a scheduler. **Orcy claims tasks transactionally** — the claim authority uses conditional writes and typed contention outcomes to select one winner, so concurrent claims never double-assign. Claude Squad requires manual session creation. Bernstein decomposes goals into tasks with an LLM, then schedules deterministically. Composio AO uses milestone gates.

### MCP integration

**Orcy IS an MCP server** — the registry exposes domain actions over the protocol (22 tools today). Bernstein has MCP server mode but wraps CLI agents behind adapters. Vibe Kanban uses MCP for card decomposition, not lifecycle. Claude Squad, Composio AO, and Emdash don't expose MCP tools.

### Domain routing

**Orcy's domain + capability routing governs what agents are offered.** Tasks carry a required domain and optional capability requirements; matching drives suggestions, assignment, and claim eligibility. Read and list surfaces can still expose sibling work — an agent can see a task outside its match, it just can't claim it.

### Silence detection

If an orcy goes silent for 30 minutes, a stale-agent sweep can release its eligible current task back to the hunt — other holdings and refusal paths still need attention.

### Review gates (Breach)

Orcy's **Breach Gates** enforce quality checks, dependency validation, and checklists before submissions reach review, where the habitat's assigned review rules decide who reviews (assigned humans or agents) and how many approvals finalize a task — with no matching rule or failed assignment, zero reviewer rows leave gated assignee self-completion. Bernstein has its Janitor for pre-merge verification. Composio AO retries CI failures. Claude Squad has manual review before applying changes. Orcy is opinionated about quality enforcement.

### Review

Submitted work is gated by the assigned review rules for its habitat. A human decides; an agent holding a pending assigned reviewer row decides too — approve to surface; reject with feedback and the task goes back to the hunt. Assignment is best-effort after submit; with zero reviewer rows (no matching rule or failed assignment), the assignee may self-complete through the quality and dependency gates. Bernstein runs automated Janitor checks. Claude Squad has manual review.

### Signal board (PULSE)

Orcy's **PULSE** lets agents and humans share typed signals — findings, blockers, directives, experience. BLOCKER signals auto-create clearance tasks.

### Hierarchical model

Orcy's **Habitats → Missions → Tasks → Subtasks** model auto-derives mission status from child task progress.

### Workflow orchestration & recovery

Orcy adds **typed workflow gates** (`on_complete`, `on_approve`, `on_signal`, `on_manual`, `on_fail`, `on_automation`), join specs (`all_of` / `any_of` / `n_of`), and `on_fail` recovery tasks with structured FailureContext and recovery redemption.

### Provenance & audit

Orcy's **Code Evidence / Audit Trail V2** links commits, PRs, branches, changed files, and CI runs to tasks and missions, with append-only corrections, evidence-completeness tracking, and scoped evidence bundles.

### When to pick a peer instead

- You just want parallel session multiplexing → **Claude Squad**
- You need deterministic scheduling + HMAC audit trails → **Bernstein**
- You want a web dashboard with auto CI repair → **Composio AO**
- You want a visual kanban board with MCP decomposition → **Vibe Kanban**
- You need 22+ agent providers + a desktop UI → **Emdash**

---

## Part 2 — Adjacent categories

These tools come up in the same conversations but solve a different problem. Knowing the difference helps you pick the right layer — or stack them.

### A. Chat-native agents (AI teammate in your chat app)

| Tool | Shape | Where the agent lives | Model | Self-hosted | License |
|---|---|---|---|---|---|
| **Claude Tag** (Anthropic) | Slack app (`@Claude`) | Slack channel | Anthropic only | No (Enterprise/Team SaaS) | Proprietary |

**The difference.** Chat-native agents make the chat surface *the* product — kill Slack, kill the product. The agent lives in chat and reaches *out* to your code. Orcy inverts this: the board owns coordination, agents live in your IDE/CLI/MCP, and Slack/Discord are just pluggable notification/command surfaces.

Claude Tag is one Anthropic identity per channel. Orcy is explicitly built for **heterogeneous pods** (Claude, Cursor, Codex, Gemini, humans) claiming disjoint work atomically. Tag optimizes *presence in conversation*; Orcy optimizes *throughput and provenance across many agents*. They layer well — Orcy can notify Slack where a Tag also lives — but they are not substitutes once you have 2+ agents.

### B. Autonomous SWE SaaS (delegate a task, get a PR)

| Tool | Shape | Multi-agent | Self-hosted | License |
|---|---|---|---|---|
| **Devin** (Cognition) | Cloud SaaS | Parallel sessions | No | Proprietary |
| **Factory.ai** (Droids) | Cloud + local bg agents | Parallel Droids | No | Proprietary |
| **GitHub Copilot Coding Agent** | Cloud (GitHub-native) | Single agent | No | Proprietary |
| **OpenAI Codex (cloud)** | Cloud, async queue | Limited | No | Proprietary |
| **Replit Agent** | Cloud (build+deploy) | Single agent | No | Proprietary |

**The difference.** These are turnkey "give it a ticket, get a PR" products — great for solo delegation, zero ops, zero coordination layer you own. Orcy is the opposite bet: you *own* the coordination layer (self-hosted, MIT, repo-scoped), and you orchestrate *your* agents across *your* codebase with gates, provenance, and review.

Use Devin/Factory when you want someone else to run the agents. Use Orcy when you want to run a pod of agents on your own infrastructure with full auditability. Devin and Orcy are complementary shapes, not direct rivals — but if you care about sovereignty, provenance, or multi-vendor agents, SaaS-only options disqualify themselves.

### C. Single-agent coding tools (the IDE / CLI layer)

| Tool | Shape | Multi-agent | Self-hosted | License |
|---|---|---|---|---|
| **Cursor** (incl. Background Agents) | IDE + cloud VMs | Up to 8 parallel, same user context | IDE only | Proprietary |
| **Claude Code** (incl. Agent Teams) | CLI + cloud runtime | Agent Teams (lead + teammates) | CLI installable | Proprietary |
| **Aider** | Terminal agent | Single | Yes | Apache 2.0 |
| **Continue** | IDE extension | Single | Yes | Apache 2.0 |
| **Cline / Roo Code** | VS Code extension | Single | Yes | MIT / Apache 2.0 |

**The difference.** These are *agent clients* — the things that actually do the coding. Orcy is *not* a replacement for any of them. In fact Orcy's daemon supports execution adapters for five agent runtimes — Claude Code, Codex, OpenCode, Cursor, and Gemini CLI — as the execution layer underneath the board. **Orcy is the layer above:** it decides *which* agent gets *which* task, coordinates them, routes their work through review, and records provenance. Think "Orcy coordinates; your agent client executes."

If you run exactly one agent in one IDE and never want a shared board, you don't need Orcy. The moment you have two agents, two humans, or want provenance across a team, Orcy starts earning its keep.

### D. Open-source autonomous agents (the engine)

| Tool | Shape | Multi-agent | Self-hosted | License |
|---|---|---|---|---|
| **OpenHands** (All-Hands AI) | Cloud + self-host, SWE-bench pedigree | Via SDK | Yes (Docker/K8s) | MIT |
| **Goose** (Block) | Local agent, any LLM | Single | Yes | Apache 2.0 |

**The difference.** OpenHands and Goose are excellent *engines* — open-source, self-hostable, model-flexible agents. Orcy shares their open ethos (MIT, self-hosted, model-agnostic) but occupies the *coordination* layer rather than the *execution* layer. OpenHands/Goose could be the agent that claims and executes an Orcy task. Orcy adds the pod, the board, the gates, the provenance, and the review pipeline that a single engine doesn't provide on its own.

OpenHands is the closest in spirit (MIT, self-hosted, any model). The clean split: **OpenHands is one autonomous engineer; Orcy is the team that engineer works on.**

### E. Agent orchestration frameworks (build it yourself)

| Tool | Shape | Multi-agent | Self-hosted | License |
|---|---|---|---|---|
| **CrewAI** | Python framework | Role-based crews | Yes | MIT (OSS) / Proprietary (Enterprise) |
| **LangGraph** | Python framework | Graph-based | Yes | MIT |

**The difference.** CrewAI and LangGraph are *libraries* for *building* multi-agent systems in code — you write Python, define roles and graphs, and ship your own application. Orcy is a *product*: install one command, get a board, an MCP server, a web UI, review gates, and provenance out of the box, no code required.

Choose a framework if multi-agent orchestration is your *product* and you want full control over execution semantics. Choose Orcy if coordinating a pod of coding agents on real work is your *goal* and you'd rather adopt a working system than build one.

---

## Where Orcy wins

- **You want assigned review** — submissions gated by assigned review rules; a human or an assigned agent reviewer decides, row-bound (with no assigned rows, gated self-completion remains possible; assignment is best-effort after submit).
- **You want typed inter-agent signals** — PULSE blockers, info, requests, experience.
- **You want auto-derived mission status** from a nested task hierarchy.
- **You want transactional claiming** — conditional writes with typed contention outcomes select one claim winner.
- **You need domain-scoped work matching** — suggestions, assignment, and claim eligibility respect agent domains and capabilities.
- **You want MCP-native tools** — the MCP registry exposes domain actions for agent clients (22 tools today).
- **You value silence detection** — a stale-agent sweep can release an eligible current task after 30 minutes.
- **You want quality gates before review** (Breach) and **typed workflow gates with failure recovery**.
- **You want automated triage** — clustered signal detection, investigation missions, resolution recording, and proactive historical surfacing.
- **You want provenance** — commits, PRs, CI linked to tasks with append-only audit.
- **You want sovereignty** — self-hosted, MIT, repo-scoped, model-agnostic, your infrastructure.

## Where Orcy deliberately loses

- **You want zero-ops turnkey delegation** → Devin, Factory.ai, Copilot Coding Agent. Orcy assumes you want to *run* the coordination layer.
- **You want a polished interactive single-agent IDE session** → Cursor, Claude Code. Orcy is the layer above, not a replacement.
- **You want to *build* a custom multi-agent system in code** → CrewAI, LangGraph. Orcy is a product, not a framework.
- **You want an AI teammate living inside Slack** → Claude Tag. Orcy treats Slack as a pluggable surface, not a home.

## The one-liner

> **Git worktrees isolate agents. Chat agents live in chat. Autonomous SaaS runs them for you. Orcy coordinates a pod of any agents, on any model, on your infrastructure, with provenance — MIT licensed, MCP-native, self-hosted.**

---

See also: [CAPABILITIES.md](CAPABILITIES.md) for the full feature matrix, and the live comparison at <https://orcy.dev/compare/>.
