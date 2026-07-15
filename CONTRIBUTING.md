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

- **State management** has a sharp boundary — see "State ownership" below.
- **Data fetching**: React Query (`@tanstack/react-query`) — the sole authority for durable server data.
- **Routing**: React Router v6 (`react-router-dom`)
- **Styling**: TailwindCSS with `class-variance-authority` for component variants
- **Components**:
  - Primitives go in `src/components/ui/` (Button, Badge, Card, Dialog)
  - Habitat-specific go in `src/components/habitat/` (Habitat, Column, TaskCard, StatsModal)
- **API client** is in `src/api/index.ts` — per-domain modules; canonical shapes only (`{ habitat, columns, missions }`, `{ missions, total }`, `{ mission }`). No `board`/`feature` aliases.
- **Types** are in `src/types/index.ts` — keep in sync with API models

#### State ownership

The UI has two stores with non-overlapping responsibilities. The boundary is
structural: durable server data and ephemeral UI state never share a slice.

| Concern | Owner | Where |
|---|---|---|
| Habitat, columns, active missions, mission detail, archived missions, tasks, agents, stats, durable activity | **React Query** | `packages/ui/src/lib/queryKeys.ts`, hooks under `src/hooks/` |
| Theme, presence, WIP alerts, UI selection (mission/task bulk select, collapsed columns), notifications, drag/reorder preview | **Zustand ephemeral slices** | `packages/ui/src/store/habitatStore.ts` |
| Recent SSE events (debug buffer) | **Zustand `recentSSEEvents`** | `packages/ui/src/store/slices/sseHandler.ts` |

Rules:

- **Never** put a Habitat/Column/Mission/Task/Agent durable projection in
  Zustand. If a screen needs server data, it reads it from a React Query
  hook (`useHabitat`, `useMission`, etc.). The Habitat board renders with
  an empty Zustand server-entity store — no `board`/`features` mirrors.
- **Never** write server data from an SSE handler into Zustand. The SSE
  registry's `server` projector patches or invalidates React Query keys
  only; the `ephemeral` projector is type-constrained to non-domain state
  (presence, WIP alerts, the recent-events debug buffer).
- **Never** dual-write on a mutation. The canonical mutation pattern is
  one server round-trip → one guarded cache patch via
  `patchMissionInHabitatDetail` / `patchColumnsInHabitatDetail` →
  `invalidateHabitatRepresentations` (background invalidation remains
  the reconciliation authority).
- **The Mission-list `search` parameter does not exist.** The repository
  has no defined search semantics and the route discards the parameter.
  Do not add it back without an end-to-end route + repository +
  query-key contract.
- **Drag intent is an overlay, not a cache replacement.** Tentative drag
  position lives in `useMissionDragMove`'s `previewByMission` until the
  move resolves; the canonical Query data is never snapshot-rolled back
  on failure.
- **Subscription generation is the staleness boundary.** A stale SSE
  generation performs no patch, invalidate, notification, or navigation
  effect (see `useSSE` and ADR-0040).

If you find yourself reaching for a Zustand field that doesn't fit the
table above, the answer is almost always "add a React Query key" or
"this state belongs on the server." If you genuinely need a new
ephemeral slice, add it explicitly to `habitatStore.ts`'s composition
with a narrow responsibility and update ADR-0040.

Stale paths that should not be referenced:

- `src/store/boardStore.ts` — does not exist; the store is
  `src/store/habitatStore.ts` and holds only ephemeral slices.
- `src/components/board/` — does not exist; habitat components are
  under `src/components/habitat/`.
- `useBoard`, `useFeature`, `BoardTasksFilters`, `boardId`, `features`,
  `featureCount`, `columnPagination`, `setBoard`, `setColumns`,
  `appendColumnFeatures`, `setColumnLoadingMore`, `clearColumnPagination`
  — all removed by the Habitat State Ownership initiative; do not
  reintroduce them.
- `POST /boards/:boardId/features` — does not exist; canonical paths are
  `/habitats/:habitatId/missions` and `/missions/:id/move`
  (with `expectedVersion`).

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

## Adding a New Feature (Mission)

Missions are the habitat-level cards. Each mission contains tasks that agents work on.

1. **Create a mission** via `POST /habitats/:habitatId/missions` or the UI
2. **Add tasks** to the mission via `POST /missions/:id/tasks`
3. **Optionally decompose** using AI via `POST /missions/:id/decompose`
4. Mission status is **auto-derived** from child task states
5. Missions move through columns via `POST /missions/:id/move` (requires
   `expectedVersion`; returns `409 VERSION_CONFLICT` on mismatch)

## Moving a Mission or Reordering Columns

Mission drag and column reorder both rely on optimistic-concurrency contracts. Do not roll your own.

- **Mission move** — single-flight per mission, latest-target coalescing.
  Use `useMissionDragMove(habitatId)` from `packages/ui/src/hooks/useMissionDragMove.ts`.
  The hook owns the per-mission in-flight ref, dispatches the queued
  latest target with the previous successful response's authoritative
  version, and surfaces `409 VERSION_CONFLICT` distinctly (never as a
  generic network failure) via `notifyVersionConflict`.
- **Column reorder** — one atomic OCC operation. Use
  `POST /habitats/:habitatId/columns/reorder` with
  `{ expectedOrder, desiredOrder }`. The server validates both arrays
  cover the same unique columns, compares `expectedOrder` to the current
  order inside one transaction, and returns `409 VERSION_CONFLICT`
  (with the current order) before any writes. Do not loop over columns
  with sequential PATCH calls — the prior loop and its compensation
  requests are removed and an interleaved actor can no longer be
  overwritten by compensation.

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

> **Important:** The Drizzle TypeScript schema files are the **single source of truth** for table/column/index declarations. Migration SQL files are authored artifacts — never edit a released migration. For the complete workflow, see [`docs/DATABASE.md` — Schema Workflow](./docs/DATABASE.md#schema-workflow).

**Quick summary:**

1. Edit the Drizzle schema in `packages/api/src/db/schema/` (e.g., `board.ts`, `cicd.ts`)
2. Generate the migration: `cd packages/api && pnpm drizzle-kit generate --name <descriptive_name>`
3. Review the emitted SQL, journal entry, and snapshot
4. Update `packages/api/src/test/schemaValidation.test.ts` if table/index counts changed
5. Run tests and the production-migration gate: `pnpm --filter @orcy/api test && pnpm -r typecheck && pnpm lint && pnpm --filter @orcy/api test:production-migration`

**Two initialization paths:**

- **Test DBs** (`initTestDb()`) apply `0000_schema.sql` (frozen consolidated baseline) then all other `NNNN_*.sql` files sorted, tolerantly swallowing "already exists" errors
- **Production DBs** (`initDb()`) apply the journal chain (`0000`, `0001`, `0002`, `0027`–`0053`) in order via Drizzle `migrate()`, preserving data

**Common mistakes to avoid:**

- Don't regenerate or replace `0000_schema.sql` — it is a frozen consolidated baseline; generate a new migration instead
- Don't overwrite `_journal.json` with a fresh single-entry journal — it would recreate the production journal gap
- Don't add indexes only in migration SQL — they must be in the Drizzle schema too
- Don't delete `drizzle/meta/` — Drizzle needs the snapshots and journal for future diffs

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

### Production-migration safety

Database changes carry a mandatory safety check that is enforced **locally
before a `main` push** and **verified independently in GitHub Actions after
the push**.

**Local prevention (pre-push hook).** A checkout-local `.git/hooks/pre-push`
hook runs the focused migration suites before any push to `refs/heads/main`
and blocks the push on failure. The hook is intentionally untracked
(`.git/hooks/` is never committed); it must be present in your checkout.
Other branch pushes are not gated.

Run the same suites on demand:

```bash
pnpm --filter @orcy/api test:production-migration
```

**Remote post-push verification (GitHub Actions).** The
`production-migration` workflow (`.github/workflows/production-migration.yml`)
re-runs the same suites from a clean checkout on every `main` push (and pull
request). It is independent clean-environment verification — the solo
direct-to-`main` workflow does not gate merges on a required status check.

**Branch protection.** A lightweight active ruleset on `main` blocks branch
deletion and non-fast-forward (`--force`) pushes. It does not require pull
requests or reviews.

The focused suites cover:

- journal/disk migration completeness and timestamp ordering
- production-driver fresh-database initialization and seed completion
- v0.29 and legacy-ledger data-preserving upgrades
- prerelease 0053 marker reconciliation and one-shot reset behavior
- compiled installed-package startup from an empty database

This gate is stronger than `drizzle-kit check`, which missed the journal gap
that blocked the original release.

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
- Use `GET /api/habitats/:id` to inspect a habitat's complete active
  mission collection (this is the unpaginated board state).

### UI debugging

- React DevTools for component state
- TanStack Query DevTools for the React Query cache (in dev builds)
- Browser Network tab for SSE events (look at `/sse/habitats/:id/stream`)
- Zustand DevTools integration available via `zustand/middleware` for the
  ephemeral slices (presence, wipAlerts, notifications, recentSSEEvents);
  durable server data does not appear there

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
