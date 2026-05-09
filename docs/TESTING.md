# Testing Guide

This document covers the testing strategy, how to run tests, and how to write new tests for Orcy.

---

## Testing Strategy

| Layer | Framework | Location | Count |
|-------|-----------|----------|-------|
| API unit tests | Vitest | `packages/api/src/test/` | 44+ |
| MCP unit tests | Vitest | `packages/mcp/src/tools.test.ts` | 17+ |
| UI unit tests | Vitest | `packages/ui/src/` | 0 (passWithNoTests) |
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
