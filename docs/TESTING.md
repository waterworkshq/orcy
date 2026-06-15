# Testing Guide

This document covers the testing strategy, how to run tests, and how to write new tests for Orcy.

---

## Testing Strategy

| Layer | Framework | Location | Count |
|-------|-----------|----------|-------|
| API unit tests | Vitest | `packages/api/src/test/` | 44+ |
| MCP unit tests | Vitest | `packages/mcp/src/tools.test.ts` | 17+ |
| UI unit tests | Vitest | `packages/ui/src/` | 107 (91 `.test.tsx` + 16 `.test.ts`) |
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

Services can be tested directly since they operate on the SQLite database:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTask, claimTask } from '../services/taskService.js';
import { getDb } from '../db/index.js';

describe('Task claiming', () => {
  beforeEach(async () => {
    const db = await getDb();
    // Clear and reseed test data
  });

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

---

## Test Configuration

### Vitest Configuration

Vitest is configured in each package's `package.json` via the `test` script. Configuration can be extended with a `vitest.config.ts` file.

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
