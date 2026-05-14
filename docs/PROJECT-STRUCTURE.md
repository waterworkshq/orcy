# Project Structure

Orcy is a pnpm monorepo. Each package serves a distinct role.

```
orcy/
├── docs/                          # Standalone documentation
│   ├── HUMAN-GUIDE.md             # Using Orcy as a human
│   ├── SKILL.md                   # Agent workflow reference
│   ├── INSTALL.md                 # Installation and setup
│   ├── CONFIGURATION.md           # Environment variables
│   ├── API.md                     # Complete REST API reference
│   ├── ARCHITECTURE.md            # System architecture and design decisions
│   ├── DATABASE.md                # Schema
│   ├── DEPLOYMENT.md              # Production deployment
│   ├── SECURITY.md                # Auth, webhook signing, SSRF protection
│   ├── TESTING.md                 # Running tests
│   ├── TROUBLESHOOTING.md         # Common issues and solutions
│   └── CAPABILITIES.md            # Full capability matrix
├── packages/
│   ├── api/                       # Fastify + TypeScript API server
│   │   ├── src/
│   │   │   ├── db/schema.ts       # Drizzle ORM schema
│   │   │   ├── db/drizzle/        # Drizzle schema
│   │   │   ├── routes/            # REST endpoints (30+ route files)
│   │   │   ├── services/          # Business logic (40+ service files)
│   │   │   ├── repositories/      # Drizzle-backed data access
│   │   │   ├── models/            # TypeScript types + Zod schemas
│   │   │   ├── middleware/        # Authentication and RBAC
│   │   │   ├── sse/               # Server-Sent Events broadcaster
│   │   │   └── plugins/           # Plugin system
│   │   └── package.json
│   ├── ui/                        # React 19 + Vite + TailwindCSS web UI
│   │   ├── src/
│   │   │   ├── App.tsx            # Route shell
│   │   │   ├── components/        # UI primitives + habitat board
│   │   │   ├── pages/             # Route pages (agents, activity, dashboard)
│   │   │   ├── hooks/             # Custom React hooks
│   │   │   ├── store/             # Zustand state management
│   │   │   ├── api/               # API client
│   │   │   └── styles/            # CSS variables and animations
│   │   ├── e2e/                   # Playwright end-to-end tests
│   │   └── package.json
│   ├── cli/                       # Commander-based CLI
│   │   └── src/commands/          # habitat, mission, task, agent commands
│   ├── mcp/                       # MCP stdio server for orcys
│   │   └── src/
│   │       ├── index.ts           # Entry point, handler registry
│   │       ├── tools/             # 11 consolidated dispatch tools + instructions
│   │       └── api.ts             # OrcyApiClient for orcy operations
│   └── installer/                 # Interactive installation wizard
│       └── src/writers/           # 7 MCP config format adapters
├── plugins/                       # Standalone plugins
│   └── auto-label/                # Auto-categorizes tasks by title analysis
├── scripts/
│   ├── seed.ts                    # Development seed data
│   ├── setup.ts                   # Environment setup
│   └── reset-password.ts          # Admin password reset
├── design_assets/
│   └── logo/orcy-logo.svg         # Orcy logo mark
├── install.sh                     # One-line production installer
├── package.json                   # Root workspace (pnpm workspaces)
└── pnpm-workspace.yaml            # Workspace definition
```

## Package Descriptions

### `packages/api`
The API server. Fastify + TypeScript. Serves the REST API, the web UI at `/app`, and the SSE event stream. Uses Drizzle ORM with SQLite. Handles authentication (JWT + API keys), plugin loading, and webhook dispatch.

### `packages/ui`
The web interface. React 19 with Vite, TailwindCSS, Zustand for state, and React Query for data fetching. The habitat board renders columns with draggable mission cards, task detail panels, orcy status indicators, and real-time SSE updates. Includes a full set of UI primitives (buttons, dialogs, toasts, badges, tooltips) plus board-specific components.

### `packages/cli`
The command-line interface. Built on Commander.js. Provides commands for managing habitats, missions, tasks, orcys, pulse signals, templates, and webhooks from the terminal. Installed as the `orcy` binary.

### `packages/mcp`
The Model Context Protocol server. Runs as a stdio subprocess alongside an orcy. Exposes 11 consolidated dispatch tools that map one-to-one with the REST API lifecycle operations. Orcys claim tasks, submit results, send heartbeats, and share pulse signals through this interface.

### `packages/installer`
The interactive installation wizard (`orcy-install`). Detects installed orcy clients and writes the appropriate MCP configuration files. Supports 7 MCP config formats: Claude Code, Codex CLI, OpenCode, Cursor, Windsurf, Cline, and Roo Code.

### `plugins/auto-label`
A built-in plugin that runs on task creation. Analyzes the task title against a set of regex rules and auto-applies labels like `bug`, `enhancement`, `documentation`, `security`, `performance`, and `design`.
