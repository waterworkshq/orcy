import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'admin123' };

async function login(request: APIRequestContext): Promise<{ token: string; userId: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request.post('/api/auth/login', { data: ADMIN });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    expect(res.status()).toBe(200);
    const body = await res.json();
    return { token: body.token, userId: body.user.id };
  }
  throw new Error('login failed after 5 retries');
}

async function authenticatePage(page: Page, token: string): Promise<void> {
  await page.goto('/login');
  await page.evaluate((t) => localStorage.setItem('orcy_token', t), token);
}

async function createBoard(request: APIRequestContext, token: string, name: string) {
  const res = await request.post('/api/boards', {
    data: { name, defaultColumns: true },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(201);
  return res.json() as Promise<{ board: { id: string; name: string }; columns: Array<{ id: string; name: string; order: number }> }>;
}

async function createFeature(request: APIRequestContext, token: string, boardId: string, title: string, columnId: string) {
  const res = await request.post(`/api/boards/${boardId}/features`, {
    data: { title, columnId },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(201);
  return res.json() as Promise<{ feature: { id: string; title: string } }>;
}

async function createTask(request: APIRequestContext, token: string, featureId: string, title: string) {
  const res = await request.post(`/api/features/${featureId}/tasks`, {
    data: { title },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(201);
  return res.json() as Promise<{ task: { id: string; title: string; status: string } }>;
}

async function registerAgent(request: APIRequestContext, token: string) {
  const res = await request.post('/api/agents', {
    data: {
      name: `e2e-agent-${Date.now()}`,
      type: 'opencode',
      domain: 'fullstack',
      capabilities: ['typescript', 'react', 'nodejs'],
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(201);
  return res.json() as Promise<{ agent: { id: string; name: string }; apiKey: string }>;
}

async function completeQualityGates(request: APIRequestContext, token: string, taskId: string): Promise<void> {
  const reportRes = await request.get(`/api/tasks/${taskId}/quality-checklist`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(reportRes.status()).toBe(200);
  const report = await reportRes.json() as {
    checklists: Array<{
      id: string;
      required: boolean;
      status: string;
      items: Array<{ id: string; required: boolean; isCompleted: boolean }>;
    }>;
  };

  for (const checklist of report.checklists) {
    for (const item of checklist.items) {
      if (item.required && !item.isCompleted) {
        await request.put(`/api/tasks/${taskId}/quality-checklist/${checklist.id}/items/${item.id}`, {
          data: { isCompleted: true },
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    }
  }
}

async function deleteBoard(request: APIRequestContext, token: string, boardId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request.delete(`/api/boards/${boardId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    expect([204, 404]).toContain(res.status());
    return;
  }
}

async function withBoard(token: string, request: APIRequestContext, name: string, fn: (ctx: { boardId: string; columns: Array<{ id: string; name: string; order: number }>; token: string }) => Promise<void>) {
  const { board, columns } = await createBoard(request, token, name);
  try {
    await fn({ boardId: board.id, columns, token });
  } finally {
    await deleteBoard(request, token, board.id);
  }
}

test.describe('E2E: Core Agent Workflow', () => {
  test('18.1: create board, create feature, verify it appears in column', async ({ page, request }) => {
    const { token } = await login(request);
    await authenticatePage(page, token);
    const boardName = `E2E Board ${Date.now()}`;

    await withBoard(token, request, boardName, async ({ boardId, columns }) => {
      const featureTitle = `E2E Feature ${Date.now()}`;
      const { feature } = await createFeature(request, token, boardId, featureTitle, columns[0].id);

      await page.goto(`/boards/${boardId}`);
      await expect(page.locator(`[data-testid="feature-card-${feature.id}"]`)).toBeVisible({ timeout: 15000 });
      await expect(page.locator(`[data-testid="feature-card-${feature.id}"]`)).toContainText(featureTitle);
    });
  });

  test('18.2: create task, claim, submit, approve, verify done', { timeout: 60000 }, async ({ page, request }) => {
    const { token, userId } = await login(request);
    await authenticatePage(page, token);
    const boardName = `E2E Lifecycle ${Date.now()}`;

    await withBoard(token, request, boardName, async ({ boardId, columns }) => {
      const featureTitle = `Lifecycle Feature ${Date.now()}`;
      const { feature } = await createFeature(request, token, boardId, featureTitle, columns[0].id);

      const taskTitle = `Lifecycle Task ${Date.now()}`;
      const { task } = await createTask(request, token, feature.id, taskTitle);

      const { apiKey } = await registerAgent(request, token);

      const claimRes = await request.post(`/api/tasks/${task.id}/claim`, {
        data: {},
        headers: { 'X-Agent-API-Key': apiKey },
      });
      expect(claimRes.status()).toBe(200);

      const startRes = await request.post(`/api/tasks/${task.id}/start`, {
        data: {},
        headers: { 'X-Agent-API-Key': apiKey },
      });
      expect(startRes.status()).toBe(200);

      await completeQualityGates(request, token, task.id);

      const submitRes = await request.post(`/api/tasks/${task.id}/submit`, {
        data: { result: 'E2E test completed successfully.' },
        headers: { 'X-Agent-API-Key': apiKey },
      });
      expect(submitRes.status()).toBe(200);

      const approveRes = await request.post(`/api/tasks/${task.id}/approve`, {
        data: { reviewerId: userId },
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(approveRes.status()).toBe(200);

      await page.goto(`/features/${feature.id}`);
      await expect(page.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('text=Approved').first()).toBeVisible({ timeout: 10000 });
    });
  });

  test('18.3: submit task via API and verify SSE event reaches the browser', { timeout: 60000 }, async ({ browser, request }) => {
    const { token } = await login(request);
    const boardName = `E2E SSE ${Date.now()}`;

    await withBoard(token, request, boardName, async ({ boardId, columns }) => {
      const featureTitle = `SSE Feature ${Date.now()}`;
      const { feature } = await createFeature(request, token, boardId, featureTitle, columns[0].id);
      const taskTitle = `SSE Task ${Date.now()}`;
      const { task } = await createTask(request, token, feature.id, taskTitle);
      const { apiKey } = await registerAgent(request, token);

      const claimRes = await request.post(`/api/tasks/${task.id}/claim`, {
        data: {},
        headers: { 'X-Agent-API-Key': apiKey },
      });
      expect(claimRes.status()).toBe(200);

      const startRes = await request.post(`/api/tasks/${task.id}/start`, {
        data: {},
        headers: { 'X-Agent-API-Key': apiKey },
      });
      expect(startRes.status()).toBe(200);

      await completeQualityGates(request, token, task.id);

      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto('/login');
        await page.evaluate((t) => localStorage.setItem('orcy_token', t), token);

        await page.evaluate(async (bId) => {
          const win = window as any;
          win.__sseEvents = [];

          const tokenRes = await fetch('/api/auth/stream-token', {
            headers: { Authorization: `Bearer ${localStorage.getItem('orcy_token')}` },
          });
          const { token: streamToken } = await tokenRes.json();

          await new Promise<void>((resolve) => {
            const es = new EventSource(`/sse/boards/${bId}/stream?token=${encodeURIComponent(streamToken)}`);
            es.onmessage = (e) => {
              try {
                const event = JSON.parse(e.data);
                win.__sseEvents.push(event);
                if (event.type === 'connected') {
                  resolve();
                }
              } catch {}
            };
            es.onerror = () => {
              resolve();
            };
          });
        }, boardId);

        const submitRes = await request.post(`/api/tasks/${task.id}/submit`, {
          data: { result: 'SSE test submission.' },
          headers: { 'X-Agent-API-Key': apiKey },
        });
        expect(submitRes.status()).toBe(200);

        await expect(async () => {
          const events: Array<{ type: string }> = await page.evaluate(() => (window as any).__sseEvents || []);
          expect(events.some((e) => e.type === 'task.submitted')).toBe(true);
        }).toPass({ timeout: 15000 });
      } finally {
        await context.close();
      }
    });
  });
});
