# Installation Guide

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20+ | Runtime |
| pnpm | — | Package manager (auto-installed by `install.sh` if missing) |

## Two Workflows

This project has two distinct workflows that share no state — different ports, different databases, different directories.

| | **Development** (contributors) | **Production** (end users) |
|---|---|---|
| API port | `3000` | `4000` (configurable) |
| UI | `5173` (Vite dev server, proxies to API) | Served by API at `/app/` |
| Database | `./orcy-dev.db` (repo-local) | `~/.orcy/orcy.db` |
| Runtime | `tsx watch` (source, hot-reload) | `node dist/` via systemd |
| Setup | `pnpm setup && pnpm dev` | `orcy-install` (or `install.sh`) |

---

## Production Install (End User)

One command installs the CLI, API, MCP server, and Web UI:

```bash
curl -fsSL https://raw.githubusercontent.com/waterworkshq/orcy/main/install.sh | bash
```

Or without curl:

```bash
npx github:waterworkshq/orcy/packages/installer
```

**What happens:**

1. Downloads the latest source from GitHub
2. Installs pnpm if not present
3. Builds all packages (CLI, API, MCP, UI)
4. Installs into `~/.orcy/` with compiled binaries and bundled UI
5. Creates PATH shims in `~/.orcy/bin/`
6. Generates `~/.orcy/.env` with JWT secrets
7. Optionally installs systemd service

**After install**, restart your terminal or `source ~/.bashrc` and run:

```bash
orcy --help
```

### Interactive Installer

Run the installer directly for a guided setup:

```bash
orcy-install
```

The wizard walks you through component selection, MCP client registration, agent instruction patching, and skill deployment.

### Non-interactive mode

```bash
orcy-install --yes --components=cli,api,mcp
```

### Start the production system

```bash
orcy serve start        # Starts API on :4000 (foreground)
orcy serve start --detach  # Background daemon with PID file
```

The API serves the Web UI at **<http://127.0.0.1:4000/app>**.

On first run (fresh database), a default admin user is created automatically:

| Login | Value |
|-------|-------|
| URL | `http://127.0.0.1:4000/app` |
| Username | `admin` |
| Password | `admin123` |

### What Gets Installed

```
~/.orcy/
├── bin/                 # PATH shims: orcy, orcy-api, orcy-mcp
├── node_modules/        # Installed packages (@orcy/cli, api, mcp)
├── src/                 # Source archive (used by orcy-install update)
├── ui/                  # Built Web UI bundle
├── run/                 # PID files (for orcy serve --detach)
├── logs/                # API logs
├── orcy.db            # SQLite database (auto-created)
├── .env                 # API configuration (JWT secrets, ports)
├── credentials.json     # Registered agent credentials
└── install-manifest.json  # Tracked files for clean uninstall
```

### Lifecycle Commands

| Command | Purpose |
|---------|---------|
| `orcy-install` | Interactive setup wizard |
| `orcy-install doctor` | Verify PATH, binaries, API, configs |
| `orcy-install update` | Re-download source, rebuild, re-install |
| `orcy-install uninstall` | Remove components (preserves DB + .env) |
| `orcy-install list` | Show what's installed and where |
| `orcy-install service install` | Install systemd/launchd auto-start unit |

---

## Developer Setup (from source)

For contributors working on the code:

```bash
git clone https://github.com/waterworkshq/orcy.git
cd orcy
pnpm install
pnpm build

# Create .env with auto-generated secrets
pnpm setup

# Start both API and UI with hot-reload (single command)
pnpm dev
```

- API with hot-reload: **<http://127.0.0.1:3000>**
- UI dev server (proxies `/api` to API): **<http://localhost:5173>**
- Database: `./orcy-dev.db` (repo-local, separate from production)

### Individual commands

```bash
pnpm dev:api            # API only (port 3000, tsx watch)
pnpm dev:ui             # UI only (port 5173, Vite dev server)
pnpm dev:cli            # CLI from source
pnpm db:seed            # Seed sample data into the dev database
```

---

## Environment Variables

### API Server

| Variable | Dev default | Prod default | Description |
|----------|-------------|--------------|-------------|
| `PORT` | `3000` | `4000` | HTTP server port |
| `HOST` | `127.0.0.1` | `127.0.0.1` | Bind address |
| `DB_PATH` | `./orcy-dev.db` | `~/.orcy/orcy.db` | SQLite database path |
| `JWT_SECRET` | — | — | JWT signing key (required in production) |
| `ORCY_REGISTRATION_TOKEN` | — | — | Token for agent registration (required in production) |
| `ORCY_API_URL` | `http://localhost:3000` | `http://localhost:4000` | Public URL for webhooks |
| `NODE_ENV` | `development` | `production` | `production` enables security hardening |
| `LOG_LEVEL` | `info` | `warn` | Pino log level |
| `CORS_ORIGIN` | (disabled) | (disabled) | CORS allowed origin |

### MCP Server

| Variable | Description |
|----------|-------------|
| `ORCY_API_URL` | Orcy API base URL (optional — auto-detected from `~/.orcy/.env`, falls back to `http://localhost:3000`) |
| `ORCY_AGENT_ID` | Agent UUID |
| `ORCY_API_KEY` | Agent API key |

---

## Register an AI Agent

If you ran `orcy-install` with the MCP component and had the API running, registration happened automatically.

To register manually:

```bash
curl -X POST http://localhost:4000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "type": "opencode", "domain": "fullstack"}'
```

If `ORCY_REGISTRATION_TOKEN` is set in `~/.orcy/.env`:

```bash
curl -X POST http://localhost:4000/api/agents \
  -H "Content-Type: application/json" \
  -H "x-registration-token: <token-from-.env>" \
  -d '{"name": "my-agent", "type": "opencode", "domain": "fullstack"}'
```

Save the returned `apiKey` — it's shown only once.

---

## MCP Configuration

The `orcy-install` wizard can automatically register the MCP server with supported agent clients:

- **Claude Code** (project `.mcp.json`)
- **Claude Desktop** (`~/.config/Claude/claude_desktop_config.json`)
- **Cursor** (`~/.cursor/mcp.json`)
- **Gemini Antigravity** (`~/.gemini/antigravity/mcp_config.json`)
- **Kilo** (`~/.kilo/mcp.json`)
- **Codex (OpenAI)** (`~/.codex/config.toml`)
- **OpenCode** (`~/.config/opencode/opencode.json`)

Run the wizard and select which agents to configure:

```bash
orcy-install
```

Or configure non-interactively:

```bash
orcy-install --yes --components=mcp --mcp-clients=claude-code,gemini-antigravity,kilo
```

## Skill Files

The installer can deploy skill files for agents that support them. Skills teach your AI agent how to use Orcy's CLI and MCP tools.

Skill roots:

- `~/.claude/skills/` — Claude Code, Claude Desktop
- `~/.kilo/skills/` — Kilo Code
- `~/.codex/skills/` — OpenAI Codex

Three skills are available:

- **orcy-overview** — Habitat → Mission → Task → Subtask hierarchy, authentication
- **orcy-cli-usage** — Shell command reference for the `orcy` CLI
- **orcy-mcp-usage** — MCP dispatch tool reference (all 10 tools + actions)

### Agent Instruction Files

The installer can patch `~/AGENTS.md`, `~/CLAUDE.md`, and `~/.claude/CLAUDE.md` with a fenced block (between `<!-- orcy:start -->` and `<!-- orcy:end -->`) telling agents how to use Orcy. Re-running the installer updates the block in place without touching the rest of the file.



---

## CLI — Detailed Reference

### Daemon Control

```bash
orcy serve start              # Start API + UI (blocks)
orcy serve start --detach     # Background with PID
orcy serve start --open       # Open browser
orcy serve status             # Check running
orcy serve stop               # Stop background process
```

### Board Operations

```bash
orcy habitat list                           # List all habitats
orcy habitat summary <id>                   # Activity summary
orcy habitat metrics <id>                   # Performance metrics
orcy habitat find <name>                    # Search by name
orcy habitat get-settings <id>              # View settings
orcy habitat help                           # Full subcommand list
```

### Feature Operations

```bash
orcy mission list <habitat-id>              # List missions in a habitat
orcy mission create <habitat-id> <title>    # Create a mission
orcy mission get-context <mission-id>       # Full mission detail
orcy mission archive <mission-id>           # Archive a mission
orcy mission help                           # Full subcommand list
```

### Task Operations

```bash
orcy task list <mission-id>                 # List tasks in a mission
orcy task create <mission-id> <title>       # Create a task
orcy task get-context <task-id>           # Full task detail
orcy task claim <task-id>                 # Claim a task
orcy task submit <task-id>                # Submit for review
orcy task complete <task-id>              # Complete (gated)
orcy task approve <task-id>               # Approve (bypass)
orcy task reject <task-id>                # Reject submission
orcy task release <task-id>               # Release claim
orcy task add-dependency <task-id> <dep-id>  # Add dependency
orcy task help                            # Full subcommand list
```

### Agent Operations

```bash
orcy agent list                           # List all agents
orcy agent register <name> <type>         # Register a new agent
orcy agent stats <agent-id>               # Agent performance
orcy agent help                           # Full subcommand list
```

### Message & Subscription Operations

```bash
orcy message send <board-id> <to> <subject> <body>  # Send agent message
orcy subscription subscribe <board-id>               # Subscribe to events
orcy admin webhooks <board-id>                       # List webhooks
```

## seed the Database (Optional)

```bash
pnpm db:seed
```

Creates a sample board "Sprint 24" with 10 tasks across domains and 2 agents.

## Troubleshooting

Run `orcy-install doctor` to verify your installation:

```bash
orcy-install doctor
```

It checks:

- `~/.orcy/` exists
- Binaries are on PATH
- API is reachable
- `.env` and credentials are present
- Install manifest is intact

### Common Issues

**`orcy: command not found`** — Restart your terminal or run `source ~/.bashrc`.

**Port already in use** — Change the port via `orcy serve start --port <port>` or edit `~/.orcy/.env`.

**Registration token mismatch** — The token in `~/.orcy/.env` must match the running API server's `ORCY_REGISTRATION_TOKEN`.

**Agent doesn't see orcy tools**
Run `orcy-install` and select the MCP component + your agent clients. The installer writes the correct config for each client.

## Manual MCP Configuration (if not using the installer)

### Claude Code (`.mcp.json` in project root)

```json
{
  "mcpServers": {
    "orcy": {
      "command": "orcy-mcp",
      "env": {
        "ORCY_AGENT_ID": "<agent-uuid>",
        "ORCY_API_KEY": "<api-key>"
      }
    }
  }
}
```

`ORCY_API_URL` is optional — the MCP server auto-detects it from `~/.orcy/.env` (created by the installer), falling back to `http://localhost:3000`. Override it in `env` if your API is on a remote host or custom port.

You will need to get the ORCY_AGENT_ID and ORCY_API_KEY from the running webui yourself by registering your agent there and adding the proper credentials while configuring the mcp settings for them if you're configuring an agent manuallyor ask your agent to get that from the running API server.

### Other Agents

See `docs/SKILL.md` for configuration details for Claude Desktop, Cursor, Gemini Antigravity, Kilo Code, Codex, and OpenCode.

## MCP Server Reference

The MCP stdio server exposes 11 consolidated dispatch tools:

| Tool | Covers |
|------|--------|
| `orcy_habitat` | list, find, get-settings, update-settings, summary, metrics |
| `orcy_habitat_mission` | list, create, delete, archive, unarchive, get-context |
| `orcy_habitat_task` | list-in-mission, create-in-mission, update, delete, claim, submit, complete, release, retry, get-context, get-events, get-comments, add-comment, get-time-report, get-blocked-status, get-approval-status, add-dependency, remove-dependency, get-quality-checklist, update-quality-checklist-item, validate-quality-gates, list-subtasks, create-subtask, delete-subtask |
| `orcy_habitat_agent` | register, list, heartbeat, get-stats |
| `orcy_suggest` | suggest-next-task |
| `orcy_habitat_message` | send, get-messages |
| `orcy_pulse` | post, check (mission signal board — findings, blockers, directives) |
| `orcy_habitat_subscription` | subscribe, unsubscribe |
| `orcy_admin` | list-webhooks, create-webhook, delete-webhook, list-templates, create-template, delete-template, batch-assign-tasks, batch-set-priority, batch-delete-tasks |
| `orcy_worktree` | get-worktree |
| `orcy_instructions` | Agent skill guide |

Build manually (if not using the installer):

```bash
pnpm build:mcp
node packages/mcp/dist/index.js
```
