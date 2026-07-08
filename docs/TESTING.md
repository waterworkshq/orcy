# Testing Guide

This document covers the testing strategy, how to run tests, and how to write new tests for Orcy.

---

## Testing Strategy

| Layer | Framework | Location | Count |
|-------|-----------|----------|-------|
| API unit tests | Vitest | `packages/api/src/test/` | 201 files, ~3292 tests (+ 3 perf benchmarks run separately) |
| MCP unit tests | Vitest | `packages/mcp/src/__tests__/` | 29 files, ~508 tests |
| UI unit tests | Vitest | `packages/ui/src/` | 119 files, ~1477 tests |
| E2E tests | Playwright | `packages/ui/e2e/` | 1 spec |

### Test Pyramid

```
     ╱  E2E  ╲           ← Playwright (browser automation)
    ╱─────────╲
   ╱  API Unit ╲         ← Vitest (services, repos, state machine)
  ╱─────────────╲
 ╱  MCP Unit     ╲       ← Vitest (tool handlers)
╱─────────────────╲
```

---

## Running Tests

### All tests

```bash
pnpm test
```

### API tests only

```bash
pnpm test:api
# or
pnpm --filter api test
```

### MCP tests only

```bash
pnpm --filter mcp test
```

### UI tests

```bash
pnpm --filter ui test
```

### E2E tests

```bash
# Prerequisites: API and UI must be built
pnpm build:api
pnpm build:ui

# Run E2E tests (starts API and UI servers automatically)
node run-e2e.js
# or
cd packages/ui && npx playwright test
```

### Type checking

```bash
pnpm typecheck
```

### Linting

```bash
pnpm lint
```

---

## API Unit Tests

### Test Files

| File | Tests | Coverage |
|------|-------|----------|
| `packages/api/src/test/stateMachine.test.ts` | Task state transitions | State machine validation |
| `packages/api/src/test/claim.test.ts` | Atomic task claiming | Concurrent claim scenarios |

### Running with verbose output

```bash
pnpm --filter api test -- --reporter=verbose
```

### Running a single test file

```bash
pnpm --filter api test -- src/test/stateMachine.test.ts
```

### Running tests matching a pattern

```bash
pnpm --filter api test -- --grep "claim"
```

---

## Writing API Tests

### Test Database Setup (read this before writing a test)

Every API test that touches the database follows one convention — call `initTestDb()` in `beforeEach` and `closeDb()` in `afterEach`. This gives each test a fresh, isolated in-memory SQLite database (schema + seeded admin user + global templates):

```typescript
import { initTestDb, closeDb } from "../db/index.js";

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});
```

**How `initTestDb()` stays fast (the snapshot model).** It used to rebuild the schema and re-bcrypt the seed user on every call (~97ms/test, which made the suite take ~190s). It now caches three things in `packages/api/src/db/index.ts`:

1. **`_adminHash`** — the bcrypt hash of the seed admin password, computed once. Safe to cache because it's only ever compared via `bcrypt.compare`, and bcrypt salts are embedded in the hash string.
2. **`_sqlFactory`** — the initialized sql.js WASM module, so WASM isn't recompiled per call.
3. **`_snapshot`** — bytes of a freshly-built + seeded DB. The first call in a file does the full migration + seed and captures the snapshot via `db.export()`; every subsequent call restores via `new SQL.Database(_snapshot)` (a cheap memcpy). Vitest isolates the module registry per file, so the snapshot is naturally scoped per file — the first test in a file pays the cold build, the rest restore from the snapshot.

This took the suite from ~190s to ~12s. **Do not** "optimize" by moving `initTestDb` to `beforeAll`, clearing the caches per test, or reverting to per-test migrations — all of these reintroduce the huge overhead.

**The `foreign_keys` gotcha.** `PRAGMA foreign_keys = ON` (set by the migrations, required for `ON DELETE CASCADE` to fire) is a *connection-level* pragma and is **not** stored in the DB snapshot bytes. `initTestDb()` re-enables it explicitly on every restored connection. If you ever add another DB-creation path for tests, set the pragma after opening the connection or cascade-delete tests will silently break.

### Test Structure

Tests use Vitest with `describe`/`it` blocks:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('MyFeature', () => {
  beforeEach(() => {
    // Reset state, reseed database, etc.
  });

  it('should do something', () => {
    const result = myFunction();
    expect(result).toBe(expected);
  });
});
```

### Testing Service Functions

Services can be tested directly since they operate on the SQLite database. `initTestDb()` already gives each test a clean schema + seeded admin user, so you only need to insert the specific rows your test exercises:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/index.js';
import { createTask, claimTask } from '../services/taskService.js';

describe('Task claiming', () => {
  beforeEach(async () => {
    await initTestDb(); // fresh DB, no manual clearing needed
  });
  afterEach(() => closeDb());

  it('should claim a pending task', () => {
    const task = createTask({
      boardId: 'board-1',
      columnId: 'col-1',
      title: 'Test task',
      createdBy: 'test-user',
    });

    const result = claimTask(task.id, 'agent-1');
    expect(result.success).toBe(true);
    expect(result.task.status).toBe('claimed');
    expect(result.task.assignedAgentId).toBe('agent-1');
  });

  it('should reject double-claiming', () => {
    const task = createTask({ /* ... */ });
    claimTask(task.id, 'agent-1');
    const result = claimTask(task.id, 'agent-2');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('already_claimed');
  });
});
```

### Testing with Mocked SSE

When testing services that broadcast SSE events, you can mock the broadcaster:

```typescript
import { vi } from 'vitest';
import { sseBroadcaster } from '../sse/broadcaster.js';

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: {
    publish: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));
```

---

## MCP Unit Tests

### Structure

MCP tests mock the `OrcyApiClient` and test tool handler functions:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { boardClaimTask } from '../src/tools.js';
import type { OrcyApiClient } from '../src/api.js';

function createMockClient() {
  return {
    listTasks: vi.fn(),
    claimTask: vi.fn(),
    startTask: vi.fn(),
    // ... other methods
  } as unknown as OrcyApiClient;
}

describe('board_claim_task', () => {
  it('returns success when claim succeeds', async () => {
    const client = createMockClient();
    client.claimTask.mockResolvedValue({ success: true, task: { id: 'task-1' } });

    const result = await boardClaimTask(client, { taskId: 'task-1' });
    expect(result.success).toBe(true);
    expect(client.claimTask).toHaveBeenCalledWith('task-1');
  });
});
```

### Key patterns

- Each tool has its own `describe` block
- Use `createMockClient()` to create a fresh mock for each test
- Test both success and failure paths
- Verify the correct API client method is called with correct arguments

---

## E2E Tests

### Setup

E2E tests use Playwright with a Chromium browser. The test config (`packages/ui/playwright.config.ts`) automatically starts the API and UI servers.

### Running

```bash
node run-e2e.js
```

### Writing E2E Tests

```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature Name', () => {
  test('should do something', async ({ page }) => {
    await page.goto('/boards/board-id');

    // Interact with the page
    await page.getByRole('button', { name: 'New Task' }).click();

    // Assert state
    await expect(page.getByText('Task created')).toBeVisible();
  });
});
```

### Debugging E2E Tests

```bash
# Run with headed browser
npx playwright test --headed

# Run with Playwright Inspector
npx playwright test --debug

# Generate trace for failed tests (already configured)
npx playwright test --trace on
```

---

## Test Patterns

Battle-tested idioms used across the codebase. Each snippet is pulled from a real test file.

### Module-Level Mocking with `vi.hoisted()`

**When to use:** You need a mock accessible inside a `vi.mock()` factory (factories run at hoist time, before imports).

**How:** `vi.hoisted()` runs its callback at hoist time so the returned object is visible inside `vi.mock()` factories.

```typescript
const mocks = vi.hoisted(() => ({
  agentService: { createAgent: vi.fn() },
  taskService: { claimTask: vi.fn() },
  daemonRepo: { createDaemon: vi.fn(), updateDaemonHeartbeat: vi.fn() },
}));
vi.mock("../services/agentService.js", () => mocks.agentService);
vi.mock("../services/tasks/index.js", () => mocks.taskService);
vi.mock("../repositories/daemon.js", () => mocks.daemonRepo);
```

Used by: [`packages/api/src/test/daemonRoutes.test.ts`](../packages/api/src/test/daemonRoutes.test.ts), [`packages/api/src/test/boardService.test.ts`](../packages/api/src/test/boardService.test.ts), [`packages/daemon/test/poll-loop.test.ts`](../packages/daemon/test/poll-loop.test.ts) — 50+ files use this.

### React Component Testing (jsdom + Testing Library)

**When to use:** Testing React components without a browser.

**How:** A `// @vitest-environment jsdom` pragma enables the DOM, then `@testing-library/react` drives the component through `render` / `screen` / `fireEvent` / `waitFor`.

```tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

it('renders username and password input fields', () => {
  render(<LoginForm onSubmit={vi.fn()} error={null} />, { wrapper: MemoryRouter });
  expect(screen.getByLabelText('Username')).toBeInTheDocument();
  expect(screen.getByLabelText('Password')).toBeInTheDocument();
});
```

Used by 107 test files under `packages/ui/src/`, e.g. [`LoginForm.test.tsx`](../packages/ui/src/components/auth/LoginForm.test.tsx).

### Mock Builder with Partial Overrides

**When to use:** Testing pure functions that take complex collaborator objects (managers, strategies, clients).

**How:** A `makeX(overrides?: Partial<IX>)` helper returns a fully-populated mock with sensible defaults; spread `...overrides` on top to mutate only the fields under test.

```typescript
function makeManager(overrides?: Partial<ISessionManager>): ISessionManager {
  return {
    activeCount: 0,
    activeSessions: [],
    getSession: () => undefined,
    startSession: vi.fn().mockResolvedValue({} as never),
    terminateSession: vi.fn(),
    shutdownAll: vi.fn(),
    ...overrides,
  };
}
```

Used by: [`daemon-poll.test.ts`](../packages/shared/src/__tests__/daemon-poll.test.ts), [`poll-loop.test.ts`](../packages/daemon/test/poll-loop.test.ts), [`taskSuggestion.test.ts`](../packages/api/src/test/taskSuggestion.test.ts) — 20+ files.

### Interface Compliance Testing

**When to use:** Verifying that a class genuinely conforms to a shared interface contract (catches drift between implementation and `@orcy/shared` types).

**How:** Compile-time `expectTypeOf<Impl>().toMatchTypeOf<IInterface>()` plus runtime method-surface checks (`typeof instance.method === 'function'`).

```typescript
it("satisfies ISessionManager at compile time", () => {
  expectTypeOf<SessionManager>().toMatchTypeOf<ISessionManager>();
});

it("exposes all ISessionManager methods", () => {
  const sm = new SessionManager({ sessionUpdater: mockUpdater, apiUrl: "", dataDir: "/tmp", sessionTimeoutSeconds: 60 });
  expect(typeof sm.getSession).toBe("function");
  expect(typeof sm.terminateSession).toBe("function");
  expect(typeof sm.shutdownAll).toBe("function");
});
```

Used by: [`interface-compliance.test.ts`](../packages/daemon/test/interface-compliance.test.ts), [`factory.test.ts`](../packages/daemon/test/factory.test.ts), [`daemon-seam.test.ts`](../packages/daemon/test/daemon-seam.test.ts).

### Route Capture / Handler Isolation

**When to use:** Testing Fastify route handlers without spinning up an HTTP server.

**How:** A `captureRoutes()` helper builds a fake `FastifyInstance` whose `.post()` / `.patch()` methods record `{ handler, preHandler }` pairs by path. Tests then extract a handler by path and invoke it directly.

```typescript
function captureRoutes(): Map<string, { handler: Function; preHandler?: any[] }> {
  const routes = new Map<string, { handler: Function; preHandler?: any[] }>();
  const fake = {
    post: vi.fn((path, opts, handler?) => routes.set(`POST ${path}`, { handler: handler ?? opts, preHandler: opts?.preHandler })),
    patch: vi.fn((path, opts, handler?) => routes.set(`PATCH ${path}`, { handler: handler ?? opts })),
    get: vi.fn(), delete: vi.fn(), put: vi.fn(),
  } as unknown as FastifyInstance;
  daemonRoutes(fake);
  return routes;
}
```

Used by: [`daemonRoutes.test.ts`](../packages/api/src/test/daemonRoutes.test.ts), [`effortRoutes.test.ts`](../packages/api/src/test/effortRoutes.test.ts), [`codeEvidenceRoutes.test.ts`](../packages/api/src/test/codeEvidenceRoutes.test.ts), [`auditBundleRoutes.test.ts`](../packages/api/src/test/auditBundleRoutes.test.ts) — 6+ route test files.

### Workflow Gate Evaluation Tests (v0.20)

**When to use:** Testing gate satisfaction logic per gate type, join spec evaluation, and idempotency of gate updates.

**How:** Mock the transition emitter's `onTransition` hook to capture the subscriber, then invoke it with controlled event payloads. Verify gate rows transition from `satisfied = false` to `satisfied = true` exactly once.

```typescript
// Capture the subscriber via mocked onTransition
const hooks: TransitionHook[] = [];
vi.mock("../services/tasks/transition-emitter.js", () => ({
  onTransition: (hook: TransitionHook) => { hooks.push(hook); return () => {}; },
}));

// Fire a transition and check gate state
hooks[0]({ taskId: "task-1", action: "completed", habitatId: "h1", /* ... */ });
expect(gate.satisfied).toBe(true);

// Fire again — idempotent (no error, no duplicate update)
hooks[0]({ taskId: "task-1", action: "completed", habitatId: "h1", /* ... */ });
expect(updateCallCount).toBe(1);
```

Used by: [`workflowService.test.ts`](../packages/api/src/test/workflowService.test.ts), [`workflowServiceRecovery.test.ts`](../packages/api/src/test/workflowServiceRecovery.test.ts), [`workflowServiceRedemption.test.ts`](../packages/api/src/test/workflowServiceRedemption.test.ts), [`workflowGateEvaluator.test.ts`](../packages/api/src/test/workflowGateEvaluator.test.ts).

**Evaluator unit tests (v0.26.0):** Pure function tests for `WorkflowGateEvaluator` — no DB, no mocks beyond a stub `GateConditionChecker`. Test action-to-gate-type mapping, signal/automation matching logic, condition-false skip, and the universal satisfied-skip rule. These complement the integration tests above by exercising matching logic in isolation.

**Per-gate-type patterns:**
- `on_complete` → fire `completed` action on upstream task
- `on_approve` → fire `approved` action
- `on_signal` → fire `onPulseCreated` with matching `signalType` + `matchConfig`
- `on_manual` → call `manualUnblockGate()` directly
- `on_fail` → fire `failed`/`rejected`/`released` action; verify recovery task spawned

**Join spec tests:** `all_of` (all gates must fire), `any_of` (any one), `n_of(k)` (quorum threshold). Test with `evaluateJoin(totalGates, satisfiedGates, config)` pure function directly.

### Recovery Lifecycle Integration Tests (v0.20)

**When to use:** Testing end-to-end recovery spawning, redemption, and depth cap enforcement.

**How:** Use real in-memory SQLite (`initTestDb`) + real `attachWorkflow` + real `initWorkflowService()` + `emitTransition()` to fire the real handler end-to-end. The heavy-mocking pattern from unit tests doesn't work for integration tests that need real DB + real recovery spawning.

```typescript
const db = await initTestDb();
const workflow = attachWorkflow(missionId, habitatId, definition, {}, "test");
initWorkflowService();

// Fire the real transition — triggers the full handler chain
emitTransition("failed-task-id", "failed", habitatId, { reason: "API timeout" });

// Verify recovery task spawned
const recoveryTask = db.select().from(tasks).where(eq(tasks.title, "Investigate Test Task failure")).get();
expect(recoveryTask).toBeDefined();
expect(recoveryTask!.status).toBe("pending");
```

**Depth cap test:** Create a gate with `recoveryDepth = 2`, fire failure event, verify NO recovery task spawned and `workflow.recovery_unrecoverable` notification emitted.

**Redemption test:** Approve the recovery task, verify original failed task's downstream `on_complete`/`on_approve` gates satisfied and `failureContexts.resolvedAt` set with `resolutionKind = "redeemed"`.

Used by: [`workflowServiceRecovery.test.ts`](../packages/api/src/test/workflowServiceRecovery.test.ts), [`workflowServiceRedemption.test.ts`](../packages/api/src/test/workflowServiceRedemption.test.ts), [`workflowAuditNotifications.test.ts`](../packages/api/src/test/workflowAuditNotifications.test.ts).

### Self-Reporting Flow Tests (v0.20)

**When to use:** Testing the end-to-end experience signal flow: MCP tool → API → pulse storage → skill ingestion.

**How:** Test the MCP `pulsePost` tool with `signalType: "experience"` + `experience` param, verify metadata auto-stamping, then verify `habitatSkillService.ingestExperienceSignal` routes the signal to the correct skill category.

```typescript
// MCP tool stamps metadata.implicit, metadata.experience, metadata.timing
await pulsePost(client, {
  signalType: "experience",
  experience: "stuck",
  taskId: "task-1",
  subject: "Confused by the auth middleware",
});

// Skill ingestion maps category → skill type
// stuck → pitfall, surprised → domain_knowledge, smooth → pattern
expect(skillSignal.skillCategory).toBe("pitfall");
expect(skillSignal.sourceSignalType).toBe("experience");
```

**Category mapping tests:** All 7 categories (`stuck`, `confused`, `backtrack`, `surprised`, `ambiguous`, `sidetracked`, `smooth`) map correctly. Note: `sidetracked → pitfall` (stopgap until `anti_patterns` SkillCategory lands in v0.20.1).

Used by: [`pulse-experience.test.ts`](../packages/mcp/src/__tests__/tools/pulse-experience.test.ts), [`habitatSkillExperience.test.ts`](../packages/api/src/test/habitatSkillExperience.test.ts), [`failureContextService.test.ts`](../packages/api/src/test/failureContextService.test.ts).

### Performance Benchmark Tests (v0.20)

**When to use:** Verifying that workflow gates add zero measurable overhead to the claim path and that subscriber cost is negligible for non-workflow tasks.

**How:** Time `claimTask` with and without workflow gates on a large gate set (100 gates). Measure `FailureBundle` construction time. The benchmarks use `performance.now()` deltas.

**Results (from I2 verification):**
- Claim path overhead: zero measurable on SQLite (the EXISTS subquery is indexed)
- FailureBundle construction: ~1.2ms average (20 events + 50 signals + 10 retries)
- Subscriber early-filter: near-zero (single indexed lookup: "is this task in an active workflow?")

**Not part of the default `test` run.** These are absolute-latency benchmarks whose assertions flake under parallel/CPU-contended execution (local dev or CI). They live in `packages/api/src/test/perfWorkflow.test.ts` and are **excluded** from `pnpm test` (via the `test` script's `--exclude` flag). Run them explicitly and serially:

```bash
pnpm --filter api test:perf
```

Used by: [`perfWorkflow.test.ts`](../packages/api/src/test/perfWorkflow.test.ts).

**Key insight:** The `areAllWorkflowGatesSatisfied` guard uses an EXISTS subquery indexed on `downstream_task_id`, making it O(log n) regardless of gate count. Non-workflow tasks skip the query entirely (no rows in `task_workflow_gates`).

---

## Test Configuration

### Vitest Configuration

Vitest is configured in each package's `package.json` via the `test` script. Configuration can be extended with a `vitest.config.ts` file.

**API package (`packages/api`):**

- **Parallelism:** `fileParallelism` defaults to `true` (vitest's default). Files run concurrently, which is why the snapshot-based `initTestDb()` matters — vitest isolates the module registry per file, so each file's `_drizzleDb` singleton is independent and the snapshot is scoped per file. No need to disable parallelism.
- **Perf benchmarks excluded from the default run:** `pnpm test` excludes `src/test/perfWorkflow.test.ts` (via the `test` script's `--exclude` flag) because its timing assertions flake under parallel CPU contention. Run it serially with `pnpm --filter api test:perf`.
- **Why no `setupFiles`:** the test-DB setup lives inside `initTestDb()` itself (see [Test Database Setup](#test-database-setup-read-this-before-writing-a-test)) rather than a global setup file, so each test file remains self-contained and the snapshot cache is scoped correctly per file.

### Playwright Configuration

Located at `packages/ui/playwright.config.ts`:

- Test directory: `./e2e`
- Browser: Chromium only
- Workers: 1 (sequential)
- Auto-starts API and UI servers for tests

---

## Continuous Integration

### Recommended CI Pipeline

```yaml
# Example GitHub Actions workflow
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```
