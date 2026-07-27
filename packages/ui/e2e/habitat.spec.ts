import { test, expect } from "@playwright/test";
import { login, authenticatePage, createMission, withHabitat } from "./helpers";

test.describe("E2E: Core Agent Workflow", () => {
  test("18.1: create habitat, create mission, verify it appears in column", async ({
    page,
    request,
  }) => {
    const { token } = await login(request);
    await authenticatePage(page, token);

    await withHabitat(token, request, `E2E Board ${Date.now()}`, async ({ habitatId, columns }) => {
      const title = `E2E Mission ${Date.now()}`;
      const { mission } = await createMission(request, token, habitatId, title, columns[0].id);

      await page.goto(`/app/habitats/${habitatId}`);
      await expect(page.locator(`[data-testid="feature-card-${mission.id}"]`)).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator(`[data-testid="feature-card-${mission.id}"]`)).toContainText(title);
    });
  });

  test(
    "18.2: create task, claim, submit, approve, verify done",
    { timeout: 60000 },
    async ({ page, request }) => {
      const { token, userId } = await login(request);
      await authenticatePage(page, token);

      await withHabitat(
        token,
        request,
        `E2E Lifecycle ${Date.now()}`,
        async ({ habitatId, columns }) => {
          const { mission } = await createMission(
            request,
            token,
            habitatId,
            `Lifecycle Mission ${Date.now()}`,
            columns[0].id,
          );

          const taskRes = await request.post(`/api/missions/${mission.id}/tasks`, {
            data: { title: `Lifecycle Task ${Date.now()}` },
            headers: { Authorization: `Bearer ${token}` },
          });
          const { task } = await taskRes.json();

          const agentRes = await request.post("/api/agents", {
            data: {
              name: `e2e-agent-${Date.now()}`,
              type: "opencode",
              domain: "fullstack",
              capabilities: ["typescript", "react", "nodejs"],
            },
            headers: { Authorization: `Bearer ${token}` },
          });
          const { apiKey } = await agentRes.json();

          await request.post(`/api/tasks/${task.id}/claim`, {
            data: {},
            headers: { "X-Agent-API-Key": apiKey },
          });
          await request.post(`/api/tasks/${task.id}/start`, {
            data: {},
            headers: { "X-Agent-API-Key": apiKey },
          });

          // Complete required quality gates
          const reportRes = await request.get(`/api/tasks/${task.id}/quality-checklist`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const report = await reportRes.json();
          for (const checklist of report.checklists ?? []) {
            for (const item of checklist.items ?? []) {
              if (item.required && !item.isCompleted) {
                await request.put(
                  `/api/tasks/${task.id}/quality-checklist/${checklist.id}/items/${item.id}`,
                  { data: { isCompleted: true }, headers: { Authorization: `Bearer ${token}` } },
                );
              }
            }
          }

          await request.post(`/api/tasks/${task.id}/submit`, {
            data: { result: "E2E test completed successfully." },
            headers: { "X-Agent-API-Key": apiKey },
          });
          await request.post(`/api/tasks/${task.id}/approve`, {
            data: { reviewerId: userId },
            headers: { Authorization: `Bearer ${token}` },
          });

          await page.goto(`/app/missions/${mission.id}`);
          await expect(page.locator("text=Approved").first()).toBeVisible({ timeout: 10000 });
        },
      );
    },
  );

  test(
    "18.3: submit task via API and verify SSE event reaches the browser",
    { timeout: 60000 },
    async ({ browser, request }) => {
      const { token } = await login(request);

      await withHabitat(token, request, `E2E SSE ${Date.now()}`, async ({ habitatId, columns }) => {
        const { mission } = await createMission(
          request,
          token,
          habitatId,
          `SSE Mission ${Date.now()}`,
          columns[0].id,
        );

        const taskRes = await request.post(`/api/missions/${mission.id}/tasks`, {
          data: { title: `SSE Task ${Date.now()}` },
          headers: { Authorization: `Bearer ${token}` },
        });
        const { task } = await taskRes.json();

        const agentRes = await request.post("/api/agents", {
          data: {
            name: `e2e-agent-${Date.now()}`,
            type: "opencode",
            domain: "fullstack",
            capabilities: ["typescript", "react", "nodejs"],
          },
          headers: { Authorization: `Bearer ${token}` },
        });
        const { apiKey } = await agentRes.json();

        await request.post(`/api/tasks/${task.id}/claim`, {
          data: {},
          headers: { "X-Agent-API-Key": apiKey },
        });
        await request.post(`/api/tasks/${task.id}/start`, {
          data: {},
          headers: { "X-Agent-API-Key": apiKey },
        });

        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          await page.goto("/app/login");
          await page.evaluate((t) => localStorage.setItem("orcy_token", t), token);

          // Connect SSE and wait for 'connected' event
          await page.evaluate(async (hId: string) => {
            const tokenRes = await fetch("/api/auth/stream-token", {
              headers: { Authorization: `Bearer ${localStorage.getItem("orcy_token")}` },
            });
            const { token: streamToken } = await tokenRes.json();
            (window as any).__sseEvents = [];
            await new Promise<void>((resolve) => {
              const es = new EventSource(
                `/sse/habitats/${hId}/stream?token=${encodeURIComponent(streamToken)}`,
              );
              es.onmessage = (e) => {
                try {
                  const event = JSON.parse(e.data);
                  (window as any).__sseEvents.push(event);
                  if (event.type === "connected") resolve();
                } catch {}
              };
              es.onerror = () => resolve();
            });
          }, habitatId);

          await request.post(`/api/tasks/${task.id}/submit`, {
            data: { result: "SSE test submission." },
            headers: { "X-Agent-API-Key": apiKey },
          });

          await expect
            .poll(async () => {
              const events: Array<{ type: string }> = await page.evaluate(
                () => (window as any).__sseEvents || [],
              );
              return events.some((e) => e.type === "task.submitted");
            })
            .toBe(true);
        } finally {
          await context.close();
        }
      });
    },
  );
});
