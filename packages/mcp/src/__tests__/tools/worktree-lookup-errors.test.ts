import { describe, it, expect, vi, afterEach } from 'vitest';
import { WORKTREE_DISPATCH_HANDLER } from '../../tools/worktree-dispatch.js';
import { KanbanApiClient } from '../../api.js';
import { ApiClientError } from '@orcy/shared';

const BASE_URL = 'http://localhost:3000';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stubs global fetch with a fixed reply; returns the recorded call count. */
function stubFetch(reply: () => Response): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      state.calls += 1;
      return reply();
    }),
  );
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('orcy_worktree get-worktree — a failed lookup is not a disabled configuration', () => {
  it('reports an unavailable read as a typed failure, not enabled:false', async () => {
    stubFetch(() => new Response('Service Unavailable', { status: 503 }));
    const client = new KanbanApiClient(BASE_URL, 30_000, { maxRetries: 0 });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, {
      action: 'get-worktree',
      taskId: 'task-1',
    });

    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toContain('503');
    // The disabled projection must not reappear as the answer to a failure.
    expect(raw.content[0].text).not.toContain('"enabled": false');
  });

  it('reports a denied read as a typed failure, not enabled:false', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new KanbanApiClient(BASE_URL, 30_000, { maxRetries: 0 });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, {
      action: 'get-worktree',
      taskId: 'task-1',
    });

    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toContain('403');
    expect(raw.content[0].text).not.toContain('"enabled": false');
  });

  it('rejects the client call with the typed ApiClientError carrying the status', async () => {
    stubFetch(() => new Response('Service Unavailable', { status: 503 }));
    const client = new KanbanApiClient(BASE_URL, 30_000, { maxRetries: 0 });

    await expect(client.getWorktree('task-1')).rejects.toThrowError(ApiClientError);
    await expect(client.getWorktree('task-1')).rejects.toMatchObject({ status: 503 });
  });
});

// The status a failed read reports depends on the failure mode, so the agent
// guide cannot promise "the HTTP status" for every failure.
describe('orcy_worktree get-worktree — the status a non-HTTP failure reports', () => {
  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const client = new KanbanApiClient(BASE_URL, 30_000, { maxRetries: 0 });

    await expect(client.getWorktree('task-1')).rejects.toMatchObject({ status: 0 });
  });

  it('reports a timeout as a synthetic 408', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const client = new KanbanApiClient(BASE_URL, 50, { maxRetries: 0 });

    await expect(client.getWorktree('task-1')).rejects.toMatchObject({ status: 408 });
  });

  it('surfaces an unparseable response body as a raw parse error with no status', async () => {
    stubFetch(
      () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new KanbanApiClient(BASE_URL, 30_000, { maxRetries: 0 });

    // The transport returns `response.json()` without awaiting it, so a parse
    // failure escapes the transport's own error mapping and carries no status.
    await expect(client.getWorktree('task-1')).rejects.toThrowError(SyntaxError);

    const raw = await WORKTREE_DISPATCH_HANDLER(client, {
      action: 'get-worktree',
      taskId: 'task-1',
    });
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).not.toContain('"enabled": false');
  });
});

describe('orcy_worktree get-worktree — successful reads keep their established meaning', () => {
  it('keeps a genuine disabled result distinct', async () => {
    stubFetch(() => jsonResponse({ worktree: null, enabled: false }));
    const client = new KanbanApiClient(BASE_URL, 30_000, { maxRetries: 0 });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, {
      action: 'get-worktree',
      taskId: 'task-1',
    });

    expect(raw.isError).toBeFalsy();
    expect(JSON.parse(raw.content[0].text)).toEqual({ worktree: null, enabled: false });
  });

  it('keeps enabled-without-worktree distinct from disabled', async () => {
    stubFetch(() => jsonResponse({ worktree: null, enabled: true }));
    const client = new KanbanApiClient(BASE_URL, 30_000, { maxRetries: 0 });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, {
      action: 'get-worktree',
      taskId: 'task-1',
    });

    expect(raw.isError).toBeFalsy();
    expect(JSON.parse(raw.content[0].text)).toEqual({ worktree: null, enabled: true });
  });

  it('reads an existing worktree normally', async () => {
    const worktreeInfo = {
      path: '/repo/worktrees/task-1',
      branch: 'task/task-1',
      repoRoot: '/repo',
    };
    stubFetch(() => jsonResponse({ worktree: worktreeInfo, enabled: true }));
    const client = new KanbanApiClient(BASE_URL, 30_000, { maxRetries: 0 });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, {
      action: 'get-worktree',
      taskId: 'task-1',
    });

    expect(raw.isError).toBeFalsy();
    expect(JSON.parse(raw.content[0].text)).toEqual({
      worktree: worktreeInfo,
      enabled: true,
    });
  });
});

describe('orcy_worktree get-worktree — the read retry policy still applies', () => {
  it('retries a 503 read up to the configured maximum', async () => {
    const fetchState = stubFetch(() => new Response('Service Unavailable', { status: 503 }));
    const client = new KanbanApiClient(BASE_URL, 30_000, { baseDelay: 1, maxDelay: 1 });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, {
      action: 'get-worktree',
      taskId: 'task-1',
    });

    expect(fetchState.calls).toBe(4); // initial attempt + 3 retries
    expect(raw.isError).toBe(true);
  });

  it('does not retry a denied read', async () => {
    const fetchState = stubFetch(() => new Response('Forbidden', { status: 403 }));
    const client = new KanbanApiClient(BASE_URL, 30_000, { baseDelay: 1, maxDelay: 1 });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, {
      action: 'get-worktree',
      taskId: 'task-1',
    });

    expect(fetchState.calls).toBe(1);
    expect(raw.isError).toBe(true);
  });
});
