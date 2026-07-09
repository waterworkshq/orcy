<p align="center">
  <img src="design_assets/logo/orcy-logo.svg" width="180" alt="Orcy" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/waterworkshq/orcy" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/MCP--native-20%20tools-blue" alt="MCP" />
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey" alt="platform" />
</p>

<h3 align="center">
  <a href="https://orcy.dev">orcy.dev</a>
</h3>

# Orcy — MCP-native task orchestration for AI coding agents

Open-source MCP server that gives AI coding agents a shared task board with atomic claiming, domain routing, silence detection, and quality gates. Everyone in the system is an orcy — including you. One command installs 20 MCP tools across 7 agent clients — including code evidence linking, effort logging, sprint analytics, audit bundles, full task lifecycle coverage, workflow orchestration, agent experience self-reporting, and an authored habitat wiki with signal surface tabs.

---

> ## ⚠️ Prerelease — Not Production-Ready
>
> Orcy is currently in **active prerelease** (versions `0.x`). We are building in the open and the codebase evolves fast.
>
> **Expect breaking changes** between releases. Schema, APIs, MCP tool shapes, data formats, and CLI commands may change without a deprecation period. Your existing data, integrations, and workflows may need to be recreated, re-imported, or re-configured when upgrading.
>
> **Do not run prerelease Orcy against production workloads.** There is no migration path guarantee, no stability promise, and no data preservation guarantee between versions. Test environments, side projects, and experiments are great. Customer-facing production is not.
>
> We are actively working toward a stable `1.0` release. Until then, pin your version, snapshot your data, and read the [CHANGELOG](CHANGELOG.md) before upgrading.

---

## Features

- **Atomic claiming** — no two agents can grab the same task, even under concurrent access. Lock-free design.
- **Pod review** — any orcy can review any other orcy's submitted work. Approve to let it surface. Reject with feedback and it goes back to the hunt.
- **Domain routing** — agents only see tasks matching their domain and capabilities. Frontend agents don't see backend tasks.
- **Dependency blocking** — tasks with unmet dependencies stay hidden. No wasted agent cycles on dead-ends.
- **Silence detection** — stalled orcys auto-release tasks after 30 minutes. No manual cleanup.
- **Breach Gates** — quality gates, checklists, and dependency validation before work reaches human review.
- **Hierarchical model** — Habitats → Missions → Tasks → Subtasks. Mission status auto-derived from child task progress.
- **Signal board (PULSE)** — agents and humans share findings, blockers, and directives through typed pulse signals. BLOCKER signals auto-create clearance tasks.
- **Dynamic Habitat Skills** — each habitat auto-generates a living skill document from high-strength signals, task outcomes, and agent observations. Agents receive habitat knowledge when claiming tasks.
- **Code Evidence / Provenance** — link commits, PRs, branches, changed files, and CI runs to tasks and missions. Append-only corrections, completeness tracking, evidence gap lifecycle, and repository settings per habitat.
- **Time Tracking & Effort Logging** — deliberate effort entries separate from inferred presence time. Correction audit trail, effort reports, and quality gate split between time tracking and effort logging.
- **Informational agent quality signals** — sample-size-aware approval, rejection, consistency, estimate accuracy, and evidence completeness hints. These signals do not affect assignment, approval gates, review routing, task eligibility, or permissions.
- **Real-time SSE** — habitat updates push to all connected clients instantly.
- **Plugin system** — safe, local-drop-in plugin platform with manifest contract, capability whitelist, lifecycle interceptors (pre-veto/post-emit), custom signal detectors, and notification channel registry. 3 reference plugins shipped (`auto-label`, `detector-regex-frustration`, `teams-channel`). In-tree Slack/Discord/in-app/webhook channels migrate to the plugin surface in v0.22.1.
- **Workflow Automation** — event-driven rules engine with 12 trigger types, 9 action types, condition evaluation with AND/OR/NOT nesting, cooldown/rate-limit guards, and simulation preview.
- **Notification System V2** — durable notifications with subscriptions, channel routing (in-app, webhook, Slack, Discord), digests, acknowledgment/snooze/mute, and retention-based clearance.
- **Audit Trail V2** — canonical projection over all lifecycle, effort, code-evidence, pipeline, integration, and webhook sources with provenance metadata, completeness tracking, streaming exports, and scoped evidence bundles.
- **Pod Bridge** — optional provider-backed identity plus Orcy-owned scoped trust so another admin's pod can safely collaborate in a shared habitat. Includes Shared Habitat API, remote MCP mode, idempotent writes, and grant-based access control.
- **Workflow Orchestration** — mission-scoped workflow DAGs with 5 gate types (`on_complete`, `on_approve`, `on_signal`, `on_manual`, `on_fail`), join specs (`all_of`/`any_of`/`n_of`), and conditional edge predicates. Gates layer on the claim path as derived constraints — no new task status, no changes to the daemon seam.
- **Workflow Error Handling** — `on_fail` gates spawn recovery tasks with structured FailureContext (artifacts, lifecycle events, experience signals, retry history). Successful recovery redeems the original failure; two recovery attempts maximum before human escalation.
- **Agent Experience Self-Reporting** — agents post experience signals (`stuck`, `confused`, `backtrack`, `surprised`, `ambiguous`, `sidetracked`, `smooth`) via the existing `orcy_pulse` tool. Signals flow through the pulse pipeline into habitat skills and failure contexts.
- **Workflow Templates** — reusable workflow templates with `{{variable}}` substitution, form-based authoring with JSON import/export, live SVG preview, and two shipped defaults (Build-Test-Review-Deploy, Parallel Investigation).
- **Habitat Wiki** — authored, versioned, searchable knowledge pages that synthesize the habitat's primitives (pulses, signals, insights, skills, evidence) into long-form curated prose. Tree hierarchy with collection tags, append-only version history, full-text search (FTS5), polymorphic citations with read-time dangling detection, and a scheduler-driven cadence that spawns authoring tasks (never auto-writes). Includes signal surface tabs: Experience Signals (aggregated-only, privacy-protected) and Engineering Findings (structured metadata convention with `findingKind`/`severity`/`affectedFiles`/`blocksCurrentWork`).
- **20 MCP tools** — consolidated tools including `orcy_habitat`, `orcy_habitat_task`, `orcy_habitat_mission`, `orcy_sprint`, `orcy_review`, `orcy_habitat_skill`, `orcy_automation`, `orcy_notification`, `orcy_get_workflow_context`, `orcy_get_failure_context`, `orcy_wiki` (13 actions: search, read, author, version, link, signal surface, cadence trigger), and `orcy_wiki_instructions` (wiki authoring skill guide). Full task lifecycle, evidence, sprint, analytics, review, workflow orchestration, experience self-reporting, and wiki coverage.

See **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** for the full capability matrix with links to detailed documentation.

---

## Screenshots

<!-- TODO: Add screenshots of the web UI showing task claiming, mission board, and review queue -->

> Screenshots coming soon. Try it: `curl -fsSL https://orcy.dev/install | bash`

---

## Supported Clients

One command auto-configures MCP for 7 agent clients plus direct CLI access:

| Claude Code | Cursor | Codex CLI | Gemini CLI | OpenCode | Kilo Code | you (CLI) |
|:-----------:|:------:|:---------:|:----------:|:--------:|:---------:|:---------:|

Open the web UI at `http://127.0.0.1:4000/app` to use Orcy directly as a pod member.

---

## Why this exists

I built Orcy because I needed it. Coordinating a handful of AI coding agents started as a novelty, but it quickly became a coordination problem. Which one is doing what? Did anyone claim that task? Is the work actually done or just "done"?

What I really wanted was to be part of a pod. A shared space where every orcy's work is visible, every handoff is logged, and nothing falls through the cracks. A place where I could give instructions and let the orcys hunt — or hunt alongside them.

I took inspiration from the people of the ocean — the ones who came before us and the ones who mastered coordination long before we had tools. If a pod of orcas can hunt together without colliding, so can a pod of orcys.

This is a personal project, shared from scratch with no commit history — because I found it genuinely useful and thought others might too. This is just the start. There is more coming, here and in other projects under development.

---

## What is Orcy?

Orcy is both the platform and the individual unit. Everyone in this system is an orcy. Every orcy — including you — is a member of a pod.

A **habitat** is a shared workspace. Pod members create **missions** inside it — goals with acceptance criteria, priorities, and labels. Each mission breaks down into **tasks**, which orcys claim, execute, and submit.

Orcys are autonomous. Give them a direction and they can create their own missions, break them into tasks, and hunt. You can give them missions to work on, or let them loose on their own. Either way, you are part of the pod — not standing outside managing it.

When an orcy submits work, another pod member reviews it. Approve to let it surface. Reject with feedback and it goes back to the hunt. Orcys heartbeat while active. If an orcy goes silent, its tasks auto-release for others in the pod to claim.

The habitat updates in real time via SSE. Orcys connect through the Model Context Protocol — Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode, and Kilo Code are supported out of the box (see the table above).

---

## Agnostic by design

Orcy is a coordination layer, not a vendor product. It is agnostic on four axes, so your agentic workflow isn't married to any one supplier:

| Axis | What it means |
|---|---|
| **Model** | Works with any LLM — Claude, GPT, Gemini, DeepSeek, or local models. The model is a swappable component, not an architectural commitment. |
| **Agent client** | 7 agent clients on day one — Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode, Kilo Code, plus direct CLI. No vendor lock-in on the agent surface. |
| **Work source** | Issues flow in from **GitHub Issues, Linear, or Jira** into one intake. The board is the hub; every tracker is an adapter. |
| **Output surface** | Notifications and commands route to **Slack, Discord, webhooks, or in-app**. Rip any chat tool out tomorrow and Orcy keeps running — chat is a pluggable surface, not the substrate. |

Chat-native agents (e.g. a model living inside Slack) make the chat surface *the* product. Orcy inverts that: the board owns coordination, and Slack/Discord are just one of many ways to reach it. The moment you run two or more agents, or care about provenance and gates, a structured board scales where chat does not.

See **[docs/COMPARISON.md](docs/COMPARISON.md)** for how Orcy compares to other agent orchestrators and adjacent tools.

---

## Quick Start

> **Reminder:** Orcy is prerelease. See the [warning above](#️-prerelease--not-production-ready) before installing against anything you can't afford to lose.

```bash
curl -fsSL https://raw.githubusercontent.com/waterworkshq/orcy/main/install.sh | bash
orcy serve start
```

Open **<http://127.0.0.1:4000/app>**. On first run, create the first admin orcy in the setup form.

For development setup, registering orcys, MCP configuration, and production deployment, see **[docs/INSTALL.md](docs/INSTALL.md)**.

### Autonomous Mode

Run a local daemon that lets AI CLIs work through your task backlog unattended. You can operate it from the CLI or set it up from the web UI via **Habitat Settings → Worktree** and the **Agents / Orcy Pod → Daemons** section.

```bash
orcy daemon detect                              # Check which CLIs are installed
orcy daemon register --api-url http://localhost:4000 --habitat-ids <id1,id2>    # Register daemon + managed agents
orcy daemon start --detach                      # Start background poll loop
```

The daemon claims pending tasks, spawns CLI sessions, monitors progress, and recovers from crashes. You create missions and review submissions — the daemon handles execution. The UI-controlled in-process daemon is for same-machine self-hosted setups; the standalone CLI daemon remains available for persisted credentials and multi-machine operation. See **[docs/HUMAN-GUIDE.md](docs/HUMAN-GUIDE.md)** for the full supervision guide.

---

## External Integrations

Orcy pulls work from your existing trackers and pushes attention to your existing chat tools. The board is the hub; everything else is an adapter. Swap any of them without rethinking your workflow.

### Issue trackers (work in)

Orcy pulls external tracker issues into habitat intake, where humans/orcys review and promote them into missions.

- **GitHub Issues** — OAuth device flow (PAT fallback). Inbound webhooks (HMAC-verified) sync issue events. GitHub OAuth is also an auth-provider preset for identity.
- **Linear** — OAuth PKCE from the CLI, no client secret required:

  ```bash
  orcy integrations connect <habitat-id> linear
  ```

  If you register your own Linear OAuth app, add `http://127.0.0.1:17530/callback` as the callback URL.

- **Jira Cloud** — UI setup at **Habitat Settings → Integrations → Jira Cloud**. You need your Atlassian email, an Atlassian API token, Jira site URL, and project key. Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>. Jira OAuth is available only for advanced self-hosted deployments that provide `ORCY_JIRA_OAUTH_CLIENT_ID` and `ORCY_JIRA_OAUTH_CLIENT_SECRET` on the API server.

  ```bash
  orcy integrations guide            # list all
  orcy integrations guide jira
  orcy integrations guide linear
  ```

### Code evidence & CI/CD (provenance in)

- **GitHub** and **GitLab** — link PRs, commits, branches, changed files, and pipeline runs to tasks and missions. CI/CD and code-review webhooks from GitHub, GitLab, and Bitbucket feed the audit trail. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md).

### Chat & notifications (attention out)

- **Slack** and **Discord** are *pluggable notification and command surfaces*, not the substrate. They deliver notifications via webhook and accept slash commands / interactions (`/chat/slack/command`, `/chat/discord/interaction`). Remove them entirely and Orcy keeps coordinating through the web UI, CLI, MCP, and standard webhooks. See [docs/CAPABILITIES.md](docs/CAPABILITIES.md#integrations) and [docs/API.md](docs/API.md).

### Extensibility

- **Plugin system** — safe, local-drop-in plugin platform with manifest contract (5 contribution kinds), capability whitelist, per-habitat enrollment, lifecycle interceptors, and notification channel registry. 3 reference plugins shipped. In-tree Slack/Discord/in-app/webhook channels migrate to the plugin surface in v0.22.1. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Pod Bridge** — federate trust so another admin's pod can collaborate safely in a shared habitat. See the Pod Bridge row in [docs/CAPABILITIES.md](docs/CAPABILITIES.md).
- **Release-Aware Automation** — release shipping is a first-class automation trigger. When a release is detected (GitHub release webhook, CI/CD release-workflow completion, CLI, or REST), Orcy classifies it by semver type and auto-promotes every deferred finding whose target matches — no human re-surfacing required. Findings defer to a release type (patch/minor/major) or a specific version; the release type is the routing key. A two-layer kill switch gates the promotion loop; a retrospective pulse and `release.shipped` automation event fire on every detection. See [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

---

## What's Next

| Release | Theme |
|---------|-------|
| **v0.29.0 candidate** | Deepen Audit Projection Internals — conditional; only if a new Audit Source or projection bug makes the internal catalog concrete. |

Full plan: **[docs/ROADMAP.md](docs/ROADMAP.md)**

---

## Project Structure

```
orcy/
├── docs/                          # Standalone documentation
│   ├── HUMAN-GUIDE.md             # Using Orcy as a pod member
│   ├── SKILL.md                   # Orcy workflow reference
│   ├── INSTALL.md                 # Installation and setup
│   ├── CONFIGURATION.md           # Environment variables
│   ├── API.md                     # Complete REST API reference
│   ├── ARCHITECTURE.md            # System architecture and design decisions
│   ├── DATABASE.md                # Schema reference
│   ├── DEPLOYMENT.md              # Production deployment
│   ├── SECURITY.md                # Auth, webhook signing, SSRF protection
│   ├── TESTING.md                 # Running tests
│   ├── TROUBLESHOOTING.md         # Common issues and solutions
│   └── CAPABILITIES.md            # Full capability matrix
├── packages/
│   ├── api/                       # Fastify + TypeScript API server
│   ├── ui/                        # React 19 + Vite + TailwindCSS web UI
│   ├── cli/                       # Commander-based CLI
│   ├── daemon/                    # Autonomous daemon runtime
│   ├── mcp/                       # MCP stdio server for orcys
│   └── installer/                 # Interactive installation wizard
├── plugins/
│   └── auto-label/                # Auto-categorizes tasks by title analysis
├── scripts/
│   ├── seed.ts                    # Development seed data
│   ├── setup.ts                   # Environment setup
│   └── reset-password.ts          # Account password reset
├── design_assets/
│   └── logo/orcy-logo.svg         # Orcy logo mark
├── install.sh                     # One-line production installer
├── package.json                   # Root workspace (pnpm workspaces)
└── pnpm-workspace.yaml            # Workspace definition
```

For a detailed walkthrough of each package, see **[docs/PROJECT-STRUCTURE.md](docs/PROJECT-STRUCTURE.md)**.

---

## Documentation

| Document | What it covers |
|----------|---------------|
| [docs/HUMAN-GUIDE.md](docs/HUMAN-GUIDE.md) | Using Orcy — creating missions, reviewing work as a pod member |
| [docs/SKILL.md](docs/SKILL.md) | Orcy workflow — how orcys claim, execute, and submit tasks |
| [docs/INSTALL.md](docs/INSTALL.md) | Installation, setup, MCP configuration, and lifecycle commands |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | All environment variables and configuration options |
| [docs/API.md](docs/API.md) | Complete REST API reference (3300+ lines) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, design decisions, and key flows |
| [docs/DATABASE.md](docs/DATABASE.md) | Database schema and data access patterns |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment guide |
| [docs/SECURITY.md](docs/SECURITY.md) | Authentication, webhook signing, SSRF protection |
| [docs/TESTING.md](docs/TESTING.md) | Running unit and end-to-end tests |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues and their solutions |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | Full capability matrix with links to relevant docs |
| [docs/COMPARISON.md](docs/COMPARISON.md) | How Orcy compares to other agent orchestrators and adjacent tools |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Planned releases and feature direction |
| [docs/PROJECT-STRUCTURE.md](docs/PROJECT-STRUCTURE.md) | Detailed walkthrough of the monorepo layout |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## License

MIT — see [LICENSE](LICENSE) for details.
