/**
 * TG-15: Board UX smoke tests for real-browser interactions.
 *
 * These tests cover scenarios that the mocked unit/integration tests can't:
 * real SSE event delivery and real React Query reconciliation — all over real
 * network, not mocked fetch/EventSource.
 *
 * Covered:
 *   15.1: Mission moved between columns via API → SSE updates the board in realtime
 *   15.2: New mission created via API → SSE renders the card without page refresh
 *   15.3: Mission archived via API → board reflects the change after reload
 *   15.4: Column reorder via API → board reflects new order via SSE
 *
 * Note: The @dnd-kit drag interaction itself is covered by Habitat.drag.test.tsx
 * (unit-level, simulating dnd-kit events directly). These e2e tests verify the
 * full network roundtrip (API mutation → SSE event → React Query reconcile → DOM)
 * which is what the mocked tests cannot validate.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  login,
  authenticatePage,
  createMission,
  archiveMission,
  moveMission,
  withHabitat,
} from "./helpers";

async function connectSSE(page: Page, habitatId: string): Promise<void> {
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
      (window as any).__sse = es;
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
}

test.describe("TG-15: Board UX smoke tests (real browser, real network)", () => {
  test(
    "15.1: mission moved between columns via API → SSE updates board",
    { timeout: 30000 },
    async ({ page, request }) => {
      const { token } = await login(request);
      await authenticatePage(page, token);

      await withHabitat(
        token,
        request,
        `TG15-Move ${Date.now()}`,
        async ({ habitatId, columns }) => {
          const { mission } = await createMission(
            request,
            token,
            habitatId,
            `Move Me ${Date.now()}`,
            columns[0].id,
          );

          await page.goto(`/app/habitats/${habitatId}`);
          await connectSSE(page, habitatId);

          // Verify mission starts in column 0
          await expect(page.locator(`[data-testid="feature-card-${mission.id}"]`)).toBeVisible({
            timeout: 15000,
          });

          // Move the mission to column 1 via the correct API endpoint (POST /missions/:id/move)
          await moveMission(request, token, mission.id, columns[1].id, 1);

          // The SSE event should update the board — card appears in column 1 without reload
          await expect(
            page
              .locator(`[data-testid="column-${columns[1].id}"]`)
              .locator(`[data-testid="feature-card-${mission.id}"]`),
          ).toBeVisible({ timeout: 10000 });
        },
      );
    },
  );

  test(
    "15.2: realtime SSE — new mission created via API appears in browser",
    { timeout: 30000 },
    async ({ page, request }) => {
      const { token } = await login(request);
      await authenticatePage(page, token);

      await withHabitat(
        token,
        request,
        `TG15-SSE-Create ${Date.now()}`,
        async ({ habitatId, columns }) => {
          await page.goto(`/app/habitats/${habitatId}`);
          await connectSSE(page, habitatId);

          const title = `SSE Created ${Date.now()}`;
          const { mission } = await createMission(request, token, habitatId, title, columns[0].id);

          await expect(page.locator(`[data-testid="feature-card-${mission.id}"]`)).toBeVisible({
            timeout: 10000,
          });
          await expect(page.locator(`[data-testid="feature-card-${mission.id}"]`)).toContainText(
            title,
          );
        },
      );
    },
  );

  // SKIPPED: Archive requires mission status "done", which can only be achieved
  // by completing the full task lifecycle (create → claim → start → submit → approve).
  // The updateMissionSchema doesn't accept a `status` field — there's no shortcut.
  // The archive-specific SSE behavior (mission.updated with archived metadata) is
  // tested at the unit level in projector.test.ts. Re-enable when a status-update
  // API exists or when the task lifecycle e2e (18.2) is stable enough to compose.
  test.skip("15.3: mission archived via API → archived section reflects change", async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    const { token } = await login(request);
    await authenticatePage(page, token);

    await withHabitat(
      token,
      request,
      `TG15-Archive ${Date.now()}`,
      async ({ habitatId, columns }) => {
        const { mission } = await createMission(
          request,
          token,
          habitatId,
          `Archive Me ${Date.now()}`,
          columns[0].id,
        );

        // Mission must be "done" to be archivable (status defaults to "not_started")
        await request.patch(`/api/missions/${mission.id}`, {
          data: { status: "done", expectedVersion: 1 },
          headers: { Authorization: `Bearer ${token}` },
        });

        // Archive via API
        await archiveMission(request, token, mission.id);

        // Reload the page — the archived section should show count 1
        await page.goto(`/app/habitats/${habitatId}`);
        await expect(page.locator('[data-testid="archived-toggle"]')).toBeVisible({
          timeout: 15000,
        });

        // Expand the archived section
        await page.locator('[data-testid="archived-toggle"]').click();
        await expect(page.locator(`[data-testid="archived-feature-${mission.id}"]`)).toBeVisible({
          timeout: 10000,
        });
      },
    );
  });

  test(
    "15.4: column reorder via API → board reflects new order via SSE",
    { timeout: 30000 },
    async ({ page, request }) => {
      const { token } = await login(request);
      await authenticatePage(page, token);

      await withHabitat(
        token,
        request,
        `TG15-Reorder ${Date.now()}`,
        async ({ habitatId, columns }) => {
          await page.goto(`/app/habitats/${habitatId}`);
          await connectSSE(page, habitatId);

          const firstHeader = page.locator('[data-testid^="column-header-"]').first();
          const initialFirstName = (await firstHeader.textContent())?.trim();

          // Reorder: swap first and last
          const colIds = columns.map((c: { id: string }) => c.id);
          const reordered = [colIds[colIds.length - 1], ...colIds.slice(1, -1), colIds[0]];
          await request.post(`/api/habitats/${habitatId}/columns/reorder`, {
            data: { expectedOrder: colIds, desiredOrder: reordered },
            headers: { Authorization: `Bearer ${token}` },
          });

          await expect
            .poll(
              async () => {
                const header = page.locator('[data-testid^="column-header-"]').first();
                return (await header.textContent())?.trim();
              },
              { timeout: 10000 },
            )
            .not.toBe(initialFirstName);
        },
      );
    },
  );
});
