# Contributing to Orcy

Thank you for contributing! This guide covers setting up your dev environment, code conventions, and the PR process.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |
| pnpm | 9+ | `npm install -g pnpm` |
| Docker Desktop | Latest | [docker.com](https://docker.com) (optional, for PostgreSQL/Redis) |

---

## Development Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start the API in dev mode

```bash
pnpm dev:api
```

The API runs at `http://127.0.0.1:3000` with pino-pretty logging.

### 3. Start the UI in dev mode

```bash
pnpm dev:ui
```

The UI runs at `http://localhost:5173` and proxies `/api` and `/sse` to the API.

### 4. Seed sample data (optional)

```bash
pnpm db:seed
```

This creates a sample board (`Sprint 24`), 11 tasks (10 in Todo + 1 in In Progress), and 2 agents.

---

## Project Structure

```
orcy/
├── packages/
│   ├── api/          # Fastify REST API (TypeScript)
│   ├── ui/           # React 19 SPA (Vite + TailwindCSS)
│   └── mcp/          # MCP stdio server for AI agents
├── docs/             # Documentation
├── scripts/          # Dev utilities (seed.ts)
└── package.json      # pnpm workspace root
```

Each package is self-contained with its own `package.json`, `tsconfig.json`, and build pipeline.

---

## Code Conventions

### TypeScript

- **Strict mode** is enabled across all packages
- Use ESM (`"type": "module"`) with `.js` extensions in imports (TypeScript ESM resolution)
- Never use `any` — use `unknown` and narrow with type guards
- Prefer `interface` for object types, `type` for unions/intersections

### API (`packages/api`)

- **Route files** handle HTTP parsing/validation only — delegate to services
- **Service files** contain business logic and SSE broadcasting
- **Repository files** use Drizzle ORM for data access
- **Validation** uses Zod schemas in `src/models/schemas.ts`
- **Errors** use the `AppError` class from `src/errors.ts` with `ErrorCodes`
- All route handlers use `async/await` with Fastify's typed request generics
- New endpoints go under `/api` prefix (registered in `src/index.ts`)

### UI (`packages/ui`)

- **State management**: Zustand (`src/store/boardStore.ts`)
- **Data fetching**: React Query (`@tanstack/react-query`)
- **Routing**: React Router v6 (`react-router-dom`)
- **Styling**: TailwindCSS with `class-variance-authority` for component variants
- **Components**:
  - Primitives go in `src/components/ui/` (Button, Badge, Card, Dialog)
  - Board-specific go in `src/components/board/` (Board, Column, TaskCard)
- **API client** is in `src/api/index.ts` — add new endpoints there
- **Types** are in `src/types/index.ts` — keep in sync with API models

### MCP (`packages/mcp`)

- **Tool definitions** in `src/tools/index.ts` — 11 consolidated dispatch tools (orcy_habitat, orcy_habitat_mission, orcy_habitat_task, orcy_habitat_agent, orcy_habitat_message, orcy_pulse, orcy_admin, etc.)
- **API client** in `src/api.ts` — `OrcyApiClient` class wraps REST calls
- **Types** in `src/types.ts` — mirrors API response types
- **Entry point** in `src/index.ts` — wires MCP SDK to tool implementations

### General

- 2-space indentation
- Single quotes for strings
- No unused imports (enforced by TypeScript strict)
- No `console.log` in production code — use `fastify.log` in API, proper error handling elsewhere
- No comments unless explaining "why" — code should be self-documenting

---

## Available Commands

```bash
# Development
pnpm dev:api          # Start API with hot reload
pnpm dev:ui           # Start UI with HMR
pnpm dev:mcp          # Start MCP server

# Building
pnpm build            # Build all packages
pnpm build:api        # Build API only
pnpm build:ui         # Build UI only
pnpm build:mcp        # Build MCP only

# Testing
pnpm test             # Run all tests
pnpm test:api         # Run API tests (vitest)
pnpm --filter mcp test  # Run MCP tests

# Type checking
pnpm typecheck        # TypeScript --noEmit for all packages

# Linting
pnpm lint             # Lint all packages

# Database
# pnpm db:migrate       # Not needed — migrations run automatically on API startup
pnpm db:seed          # Seed sample data
```

---

## Adding a New Feature

Features are the board-level kanban cards. Each feature contains tasks that agents work on.

1. **Create a feature** via `POST /boards/:boardId/features` or the UI
2. **Add tasks** to the feature via `POST /features/:id/tasks`
3. **Optionally decompose** using AI via `POST /features/:id/decompose`
4. Feature status is **auto-derived** from child task states
5. Features automatically move through columns based on derived status

---

## Adding a New API Endpoint

1. **Define the Zod schema** in `packages/api/src/models/schemas.ts`
2. **Add repository functions** in `packages/api/src/repositories/` if needed
3. **Add service logic** in `packages/api/src/services/` if needed
4. **Create the route handler** in `packages/api/src/routes/`
5. **Register the route** in `packages/api/src/index.ts` under the `/api` prefix
6. **Update the API client** in `packages/ui/src/api/index.ts`
7. **Update types** in `packages/ui/src/types/index.ts`
8. **Write tests** in `packages/api/src/test/`

---

## Adding a New MCP Tool Action

The MCP server uses a **consolidated dispatch pattern**. New actions are added to the appropriate dispatch handler:

1. **Define the action** in the dispatch handler (e.g., `packages/mcp/src/tools/task-dispatch.ts` for task actions)
2. **Add to `ALL_TOOLS`** in `packages/mcp/src/tools/index.ts`
3. **Add the API client method** in `packages/mcp/src/api.ts`
4. **Add the type** in `packages/mcp/src/types.ts`
5. **Write tests** in `packages/mcp/src/tools.test.ts`
6. **Update SKILL.md** and **docs/API.md** with the new action documentation

---

## Adding a Database Migration

> **Note:** The old SQL migration system (`packages/api/db/*.sql`) is no longer used. Migrations are now managed via **Drizzle Kit** in `packages/api/drizzle/`.

1. Generate a new migration using Drizzle Kit:

   ```bash
   cd packages/api
   npx drizzle-kit generate
   ```

   This creates a new `.sql` file in `packages/api/drizzle/`
2. Migrations run automatically on API startup via `packages/api/src/db/index.ts` using Drizzle's `migrate()` function
3. The migration journal (`packages/api/drizzle/meta/_journal.json`) tracks which migrations have been applied
4. Migrations are idempotent — they can be safely re-run
5. Update Drizzle schema in `packages/api/src/db/schema.ts` if adding new columns/tables
6. Update repository files to use new columns/tables

---

## Pull Request Process

1. **Create a feature branch** from `main`: `git checkout -b feature/short-description`
2. **Make your changes** following the code conventions above
3. **Run checks before pushing**:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

4. **Push and open a PR** with a clear description of what changed and why
5. **Ensure CI passes** — all tests, type checks, and lint must be green
6. **Request review** from a maintainer

### PR Title Format

- `feat: add X` — new feature
- `fix: resolve Y` — bug fix
- `docs: update Z` — documentation
- `refactor: reorganize W` — code restructuring
- `test: add tests for V` — test additions
- `chore: update deps` — maintenance

---

## Debugging Tips

### API debugging

- API logs use pino-pretty — all requests are logged with method, path, status, and duration
- Set `LOG_LEVEL=debug` for verbose output
- SQLite database file is `orcy.db` in the working directory — inspect with any SQLite tool
- Use `GET /health` to verify the API is running
- Use `GET /api/boards/:id` to inspect full board state

### UI debugging

- React DevTools for component state
- Browser Network tab for SSE events (look at `/sse/boards/:id/stream`)
- Zustand DevTools integration available via `zustand/middleware`

### MCP debugging

- The MCP server runs on stdio — errors go to stderr
- Test individual tools with the MCP client or direct API calls
- Set `ORCY_API_URL` to point to a running API instance
- Check `ORCY_API_KEY` and `ORCY_AGENT_ID` are valid

### Database inspection

```bash
# Using sqlite3 CLI (if installed)
sqlite3 orcy.db ".tables"
sqlite3 orcy.db "SELECT * FROM tasks LIMIT 5;"

# Or use a GUI tool like DB Browser for SQLite
```

---

## Release Process

1. Update version in root `package.json` and all package `package.json` files
2. Update `CHANGELOG.md` with the new version
3. Run full test suite: `pnpm test && pnpm typecheck`
4. Build all packages: `pnpm build`
5. Tag the release: `git tag v1.x.x`
6. Push tag: `git push origin v1.x.x`
