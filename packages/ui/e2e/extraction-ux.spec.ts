/**
 * Extraction / Learning Loop E2E browser flow.
 *
 * Verifies the full browser flow: navigate to habitat settings → Learning Loop
 * tab → verify disabled-by-default → create policy via API → verify rendering
 * → verify no Wiki publish or Automation Rule affordance.
 *
 * NOTE: The accept/reject browser flow requires extraction findings to exist,
 * which depends on the extraction execution service having run (ensure/fresh_
 * rerun/dry_run routes are pending backend wiring). When those routes are
 * wired, extend this test with the full: configure policy → dry run → real
 * run → accept/reject a finding through production routes.
 *
 * Mind the Playwright actionability/viewport trap (MEMORY): use dispatchEvent
 * or {force:true} for offscreen controls in overflow containers.
 */
import { test, expect } from "@playwright/test";
import {
  login,
  authenticatePage,
  createHabitat,
  deleteHabitat,
  withHabitat,
} from "./helpers.js";

test.describe("Learning Loop / Extraction UI", () => {
  test("settings tab shows disabled-by-default state and no Wiki/Automation affordance", async ({
    page,
    request,
  }) => {
    const { token, userId } = await login(request);
    await authenticatePage(page, token);

    await withHabitat(token, request, "E2E Learning Loop", async ({ habitatId }) => {
      // Navigate to the habitat page
      await page.goto(`/app/habitats/${habitatId}`);

      // Wait for the page to load
      await page.waitForSelector('text="E2E Learning Loop"', { timeout: 15000 });

      // Open settings dialog
      const settingsBtn = page.locator('button:has-text("Settings"), [aria-label*="ettings"]').first();
      await settingsBtn.click({ force: true });

      // Wait for the settings dialog
      await page.waitForSelector('text="Habitat Settings"', { timeout: 10000 });

      // Click the Learning Loop tab — may be offscreen, use force
      const loopTab = page.locator('button:has-text("Learning Loop")');
      await loopTab.click({ force: true });

      // Verify disabled-by-default state is shown honestly
      await page.waitForSelector('text="Disabled (off by default)"', { timeout: 10000 });
      await expect(page.locator('text="No extraction runs occur"')).toBeVisible();

      // Verify NO Wiki publish affordance
      await expect(page.locator('text=/publish.*wiki/i')).toHaveCount(0);

      // Verify NO Automation Rule create/enable affordance
      await expect(page.locator('text=/create.*automation.*rule/i')).toHaveCount(0);
      await expect(page.locator('text=/enable.*automation.*rule/i')).toHaveCount(0);

      // Close dialog
      await page.keyboard.press("Escape");
    });
  });

  test("policy created via API renders in settings tab", async ({ page, request }) => {
    const { token, userId } = await login(request);
    await authenticatePage(page, token);

    await withHabitat(token, request, "E2E Policy Render", async ({ habitatId }) => {
      // Create a policy via API
      const res = await request.post(`/api/habitats/${habitatId}/extraction/policies`, {
        data: {
          extractorKey: "builtin:pattern_v1",
          sourceTypes: ["task_lifecycle_audit"],
          schedule: "*/5 * * * *",
          windowSeconds: 3600,
          lookbackSeconds: 86400,
        },
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.outcome).toBe("created");
      expect(body.policy.enabled).toBe(false);

      // Navigate to habitat settings
      await page.goto(`/app/habitats/${habitatId}`);
      await page.waitForSelector('text="E2E Policy Render"', { timeout: 15000 });

      // Open settings
      const settingsBtn = page.locator('button:has-text("Settings"), [aria-label*="ettings"]').first();
      await settingsBtn.click({ force: true });
      await page.waitForSelector('text="Habitat Settings"', { timeout: 10000 });

      // Click Learning Loop tab
      const loopTab = page.locator('button:has-text("Learning Loop")');
      await loopTab.click({ force: true });

      // Verify the policy renders
      await page.waitForSelector('text="builtin:pattern_v1"', { timeout: 10000 });
      await expect(page.locator('text="Disabled"')).toBeVisible();

      // Verify run history empty state
      await expect(page.locator('text="No extraction runs recorded."')).toBeVisible();

      // Close dialog
      await page.keyboard.press("Escape");
    });
  });

  test("review queue shows empty state when no findings", async ({ page, request }) => {
    const { token, userId } = await login(request);
    await authenticatePage(page, token);

    await withHabitat(token, request, "E2E Empty Queue", async ({ habitatId }) => {
      // Query the review queue via API — should be empty
      const res = await request.get(`/api/habitats/${habitatId}/extraction/review/queue`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.findings).toEqual([]);
    });
  });
});
