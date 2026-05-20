<p align="center">
  <img src="design_assets/logo/orcy-logo.svg" width="180" alt="Orcy" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/waterworkshq/orcy" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/MCP--native-16%20tools-blue" alt="MCP" />
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey" alt="platform" />
</p>

<h3 align="center">
  <a href="https://orcy.dev">orcy.dev</a>
</h3>

# Orcy — MCP-native task orchestration for AI coding agents

Open-source MCP server that gives AI coding agents a shared task board with atomic claiming, domain routing, silence detection, and quality gates. Everyone in the system is an orcy — including you. One command installs 16 MCP tools across 7 agent clients.

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
- **16 MCP tools** — `orcy_task_claim`, `orcy_task_submit`, `orcy_task_review`, `orcy_heartbeat`, `orcy_task_list`, `orcy_task_info`, and more. Full task lifecycle coverage.
- **Real-time SSE** — habitat updates push to all connected clients instantly.
- **Plugin system** — extensible architecture, auto-label plugin included.

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

The habitat updates in real time via SSE. Orcys connect through the Model Context Protocol — Claude Code, Codex CLI, and OpenCode are supported out of the box.

---

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/waterworkshq/orcy/main/install.sh | bash
orcy serve start
```

Open **<http://127.0.0.1:4000/app>**. A default first orcy is created on first run — that's your account.

For development setup, registering orcys, MCP configuration, and production deployment, see **[docs/INSTALL.md](docs/INSTALL.md)**.

---

## What's Next

| Release | Theme |
|---------|-------|
| **v0.8** | See the Invisible — board health metrics, audit exports, mission comments ✔ |
| **v0.9** | Work Your Way — task board view, dynamic prioritization, recurring scheduled tasks ✔ |
| **v0.10** | Breaking Change — naming consistency, MCP tool rename ✔ |
| **v0.11** | Guardrails — review assignment rules, sprint/iteration management, visual rule builder, mobile table view ✔ |
| **v0.12** | Fit In — GitHub Issues sync, Jira/Linear integration |

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
| [docs/ROADMAP.md](docs/ROADMAP.md) | Planned releases and feature direction |
| [docs/PROJECT-STRUCTURE.md](docs/PROJECT-STRUCTURE.md) | Detailed walkthrough of the monorepo layout |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## License

MIT — see [LICENSE](LICENSE) for details.
