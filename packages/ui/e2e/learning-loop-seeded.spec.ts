/**
 * Seeded Learning Loop end-to-end browser flow (#147).
 *
 * Runs ONLY under `playwright.seeded.config.ts` (owned API/UI servers on
 * dedicated ports, dedicated DB, global feature opt-in set in the harness
 * env alone). Reproducible command:
 *
 *   corepack pnpm --filter @orcy/ui test:e2e:seeded
 *
 * Honest mixed boundary (per the approved brief):
 *  - Through the BROWSER (mounted production controls in the Learning Loop
 *    settings tab): policy enable toggle, dry run, ensure run, and run
 *    history — plus a full page reload that must re-read durable state.
 *  - Through the LIVE API request seam (Playwright `request` against the
 *    same live routes via the UI proxy): seeding of real task-lifecycle
 *    data, policy creation, review queue/detail reads, and accept/reject
 *    decisions. No review-queue UI is mounted — the spec does NOT pretend
 *    browser controls exist for review; it drives the real HTTP contract.
 *  - No browser mocks anywhere; no production path is weakened. The global
 *    opt-in is provided by the harness env, the per-habitat opt-in is
 *    performed through the mounted UI toggle.
 *
 * Deterministic seed: one agent, one mission, two tasks each driven through
 * the real lifecycle (created → claimed → started → submitted → approved =
 * 5 task events each). The `builtin.pattern` detectors then emit >= 2
 * findings (>= 1 lesson per task at 3+ events; a convention at 5+ mission
 * refs), which is enough to accept and reject independently.
 *
 * Privacy: assertions use counts/types/statuses and finding subjects
 * produced by the extractor — never raw private source content.
 *
 * Mind the Playwright actionability/viewport trap (MEMORY): force clicks
 * for settings-tab controls inside overflow containers.
 */
import {
  test,
  expect,
  type APIRequestContext,
  type TestInfo,
} from "@playwright/test";
import { login, authenticatePage, withHabitat } from "./helpers.js";

/** Deterministic lifecycle seed: 2 tasks x 4 real task events each. */
async function seedTaskLifecycle(
  request: APIRequestContext,
  token: string,
  habitatId: string,
  columnId: string,
  missionTitle: string,
): Promise<void> {
  // One registered agent drives the agent-auth transitions (claim/submit).
  const agentRes = await request.post("/api/agents", {
    data: {
      name: "E2E Seeded Loop Agent",
      type: "codex",
      domain: "fullstack",
      capabilities: ["coding"],
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(agentRes.status()).toBe(201);
  const { apiKey } = (await agentRes.json()) as { apiKey: string };
  expect(apiKey).toBeTruthy();
  const agentHeaders = { "X-Agent-API-Key": apiKey };

  // Mission in the habitat's first column.
  const missionRes = await request.post(`/api/habitats/${habitatId}/missions`, {
    data: { title: missionTitle, columnId },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(missionRes.status()).toBe(201);
  const { mission } = (await missionRes.json()) as { mission: { id: string } };

  // Publish two tasks through the live publication route.
  for (let i = 1; i <= 2; i++) {
    const pubRes = await request.post(
      `/api/missions/${mission.id}/task-publications`,
      {
        data: {
          attemptKey: `e2e-seeded-loop-${mission.id}-${i}-${Date.now()}`,
          title: `Seeded lifecycle task ${i}`,
          description: "Deterministic seed task for the Learning Loop flow.",
          assignment: { kind: "auto" },
        },
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    // 201 = terminal created; 202 = committed + recovering (client polls the
    // task list). Both mean the publication committed — poll below.
    expect([201, 202]).toContain(pubRes.status());
  }

  // Wait for both tasks to be visible, then drive each through the real
  // lifecycle: claim (agent) → start (agent) → submit (agent, after
  // completing the required quality checklist through its live route) →
  // approve (human). Each transition emits an audit task event.
  const tasks = await waitForTasks(request, token, mission.id, 2);
  expect(tasks.length).toBe(2);

  for (const task of tasks) {
    // Claim: the publication observation gate may still be pending — retry
    // the live route until the task is claimable.
    let claimRes: import("@playwright/test").APIResponse | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      claimRes = await request.post(`/api/tasks/${task.id}/claim`, {
        data: {},
        headers: agentHeaders,
      });
      if (claimRes.status() === 200) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(claimRes!.status()).toBe(200);
    const executionToken = (
      (await claimRes!.json()) as { task: { executionToken: string | null } }
    ).task.executionToken;

    const startRes = await request.post(`/api/tasks/${task.id}/start`, {
      data: { executionToken },
      headers: agentHeaders,
    });
    expect(startRes.status()).toBe(200);

    // Required quality-gate checklist items must be completed through the
    // live checklist route before submit is accepted (no gate weakening).
    // Checklist reads/writes use the AGENT identity (route is local_actor and
    // the agent owns the task) — keeps the human 60-req/min bucket small.
    const reportRes = await request.get(`/api/tasks/${task.id}/quality-checklist`, {
      headers: agentHeaders,
    });
    expect(reportRes.status()).toBe(200);
    const report = (await reportRes.json()) as {
      checklists: Array<{ id: string; items: Array<{ id: string }> }>;
    };
    for (const checklist of report.checklists) {
      for (const item of checklist.items) {
        const putRes = await request.put(
          `/api/tasks/${task.id}/quality-checklist/${checklist.id}/items/${item.id}`,
          {
            data: { isCompleted: true },
            headers: agentHeaders,
          },
        );
        expect(putRes.status()).toBe(200);
      }
    }

    const submitRes = await request.post(`/api/tasks/${task.id}/submit`, {
      data: {
        result: "Seeded lifecycle work completed for extraction.",
        executionToken,
      },
      headers: agentHeaders,
    });
    expect(submitRes.status()).toBe(200);

    const approveRes = await request.post(`/api/tasks/${task.id}/approve`, {
      data: {},
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(approveRes.status()).toBe(200);

    // Deterministic seed assertion: 5 audit lifecycle events per task.
    const eventsRes = await request.get(`/api/tasks/${task.id}/events`, {
      headers: agentHeaders,
    });
    expect(eventsRes.status()).toBe(200);
    const actions = ((await eventsRes.json()) as {
      events: Array<{ action: string }>;
    }).events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["created", "claimed", "started", "submitted", "approved"]),
    );
  }
}

/** Poll the live mission task list until `minCount` tasks exist. */
async function waitForTasks(
  request: APIRequestContext,
  token: string,
  missionId: string,
  minCount: number,
): Promise<Array<{ id: string }>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await request.get(`/api/missions/${missionId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string }> };
    if (body.tasks.length >= minCount) return body.tasks;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`mission ${missionId} never reached ${minCount} tasks`);
}

async function openLearningLoopTab(
  page: import("@playwright/test").Page,
  habitatId: string,
  habitatName: string,
): Promise<void> {
  await page.goto(`/app/habitats/${habitatId}`);
  // The habitat name can render in truncated (hidden) chrome — attached is
  // enough; the settings click below waits for its own actionability.
  await page.waitForSelector(`text="${habitatName}"`, { timeout: 15_000, state: "attached" });

  // The settings control exposes `title="Habitat settings"` (no aria-label);
  // title-based selection avoids sibling "Column settings" buttons.
  const settingsBtn = page.locator('[title="Habitat settings"]').first();
  // dispatchEvent — the header settings control can sit under overlay chrome
  // (MEMORY actionability trap); a synthetic DOM click needs no hit-target.
  await settingsBtn.dispatchEvent("click");
  await page.waitForSelector('text="Habitat Settings"', { timeout: 10_000 });

  const loopTab = page.locator('button:has-text("Learning Loop")');
  await loopTab.dispatchEvent("click");
  await page.waitForSelector('[data-testid="learning-loop-tab"]', {
    timeout: 10_000,
  });
}

test.describe.serial("Seeded Learning Loop browser flow (#147)", () => {
  test("policy → dry run (no persist) → ensure run → accept/reject → durable after reload", async ({
    page,
    request,
  }, testInfo: TestInfo) => {
    test.setTimeout(240_000);
    const { token } = await login(request);
    await authenticatePage(page, token);

    await withHabitat(
      token,
      request,
      "E2E Seeded Loop",
      async ({ habitatId, columns, token: tok }) => {
        // ── Authorization control: the review surface refuses anonymous reads.
        const anonQueue = await request.get(
          `/api/habitats/${habitatId}/extraction/review/queue`,
        );
        expect(anonQueue.status()).toBe(401);

        // ── Deterministic real-lifecycle seed.
        await seedTaskLifecycle(request, tok, habitatId, columns[0]!.id, "Seeded Loop Mission");

        // ── Policy via live route: created disabled (per-habitat opt-in still
        //    required — the harness only provides the GLOBAL opt-in env).
        const policyRes = await request.post(
          `/api/habitats/${habitatId}/extraction/policies`,
          {
            data: {
              extractorKey: "builtin.pattern",
              sourceTypes: ["task_lifecycle_audit"],
              schedule: "*/5 * * * *",
              windowSeconds: 3600,
              lookbackSeconds: 86400,
            },
            headers: { Authorization: `Bearer ${tok}` },
          },
        );
        expect(policyRes.status()).toBe(201);
        const policyBody = (await policyRes.json()) as {
          policy: { id: string; enabled: boolean; version: number };
        };
        expect(policyBody.policy.enabled).toBe(false);
        const policyId = policyBody.policy.id;

        // ── Browser: mounted policy controls.
        await openLearningLoopTab(page, habitatId, "E2E Seeded Loop");
        const card = page.locator(`[data-testid="policy-${policyId}"]`);
        await card.waitFor({ timeout: 10_000 });

        // Disabled control: Ensure is disabled while the policy is off.
        const ensureBtn = card.locator('[aria-label="Ensure run for builtin.pattern"]');
        await expect(ensureBtn).toBeDisabled();

        // Per-habitat opt-in through the mounted toggle.
        await card.locator('button[role="switch"]').dispatchEvent("click");
        await expect(
          card.locator("span").filter({ hasText: /^Enabled$/ }),
        ).toBeVisible({ timeout: 10_000 });
        await expect(ensureBtn).toBeEnabled();

        // ── Dry run through the mounted control + confirm dialog.
        await card.locator('[aria-label="Dry run for builtin.pattern"]').dispatchEvent("click");
        // Role+name selects the confirm dialog itself — the settings dialog
        // is an ancestor whose :has-text would also match.
        const dryDialog = page.getByRole("dialog", { name: "Dry Run Extraction" });
        await dryDialog.waitFor({ timeout: 10_000 });
        await dryDialog.locator('button:has-text("Dry Run")').click();

        // Run history (mounted) must show the dry-run row: candidates
        // emitted, nothing persisted.
        const history = page.locator('[data-testid="run-history"]');
        await history.waitFor({ timeout: 30_000 });
        await expect
          .poll(
            async () => history.locator('[data-run-status]').count(),
            { timeout: 30_000 },
          )
          .toBeGreaterThanOrEqual(1);
        const dryRow = history.locator('[data-run-status]').first();
        await expect(dryRow).toContainText("Persisted: 0");
        await expect(dryRow).toContainText(/Candidates: [1-9]/);

        // Dry run persisted nothing: review queue still empty via live route.
        const queueAfterDry = await request.get(
          `/api/habitats/${habitatId}/extraction/review/queue`,
          { headers: { Authorization: `Bearer ${tok}` } },
        );
        expect(queueAfterDry.status()).toBe(200);
        expect(((await queueAfterDry.json()) as { findings: unknown[] }).findings).toEqual([]);

        // ── Real run (ensure) through the mounted control + confirm dialog.
        await ensureBtn.dispatchEvent("click");
        const ensureDialog = page.getByRole("dialog", { name: "Ensure Extraction" });
        await ensureDialog.waitFor({ timeout: 10_000 });
        await ensureDialog.locator('button:has-text("Ensure")').click();

        // Newest run row first: the ensure run must have persisted >= 2.
        await expect
          .poll(
            async () => history.locator('[data-run-status]').count(),
            { timeout: 60_000 },
          )
          .toBeGreaterThanOrEqual(2);
        // Row-agnostic: the ensure run must have persisted >= 2 findings.
        await expect(
          history.locator('[data-run-status]').filter({
            hasText: /Persisted: ([2-9]|[1-9]\d+)/,
          }),
        ).toHaveCount(1);

        // ── Review queue + detail through the live API request seam
        //    (no review UI is mounted — honest boundary, no pretend controls).
        const queueRes = await request.get(
          `/api/habitats/${habitatId}/extraction/review/queue`,
          { headers: { Authorization: `Bearer ${tok}` } },
        );
        expect(queueRes.status()).toBe(200);
        const queue = (await queueRes.json()) as {
          findings: Array<{
            id: string;
            findingType: string;
            decisionVersion: number;
            sampleSize: number;
          }>;
        };
        expect(queue.findings.length).toBeGreaterThanOrEqual(2);
        expect(queue.findings.some((f) => f.findingType === "lesson")).toBe(true);

        // Distinct findings so accept and reject are verified independently.
        const toAccept = queue.findings.find((f) => f.findingType === "lesson")!;
        const toReject = queue.findings.find((f) => f.id !== toAccept.id)!;

        for (const f of [toAccept, toReject]) {
          const detailRes = await request.get(
            `/api/habitats/${habitatId}/extraction/findings/${f.id}`,
            { headers: { Authorization: `Bearer ${tok}` } },
          );
          expect(detailRes.status()).toBe(200);
          const detail = (await detailRes.json()) as {
            finding: { status: string };
            citations: unknown[];
          };
          expect(detail.finding.status).toBe("proposed");
          expect(detail.citations.length).toBeGreaterThan(0);
        }

        // ── Decisions: accept one, reject the other (reason is required).
        const acceptRes = await request.post(
          `/api/habitats/${habitatId}/extraction/findings/${toAccept.id}/accept`,
          {
            data: {
              expectedDecisionVersion: toAccept.decisionVersion,
              reason: "Seeded flow: lesson accepted after review",
            },
            headers: { Authorization: `Bearer ${tok}` },
          },
        );
        expect(acceptRes.status()).toBe(200);
        const accepted = (await acceptRes.json()) as {
          finding: { status: string; decisionVersion: number };
        };
        expect(accepted.finding.status).toBe("accepted");
        expect(accepted.finding.decisionVersion).toBe(toAccept.decisionVersion + 1);

        const rejectRes = await request.post(
          `/api/habitats/${habitatId}/extraction/findings/${toReject.id}/reject`,
          {
            data: {
              expectedDecisionVersion: toReject.decisionVersion,
              reason: "Seeded flow: rejected after review",
            },
            headers: { Authorization: `Bearer ${tok}` },
          },
        );
        expect(rejectRes.status()).toBe(200);
        expect(((await rejectRes.json()) as { finding: { status: string } }).finding.status).toBe(
          "rejected",
        );

        // ── CAS control: a stale decision version must be refused, not
        //    silently applied.
        const staleRes = await request.post(
          `/api/habitats/${habitatId}/extraction/findings/${toAccept.id}/accept`,
          {
            data: {
              expectedDecisionVersion: toAccept.decisionVersion,
              reason: "Seeded flow: stale CAS attempt",
            },
            headers: { Authorization: `Bearer ${tok}` },
          },
        );
        expect(staleRes.status()).toBe(409);

        // ── Reload reread: decisions must be durable after a full page
        //    reload, not just a successful toast.
        // Pacing: the API's rolling 60-request/minute identity bucket has
        // been spent down by the page load, run mutations, and decisions —
        // let the window roll off so the reload's query fan-out is served
        // rather than 429'd (a real refusal this flow must not trip).
        await new Promise((r) => setTimeout(r, 65_000));
        await page.reload();
        await page.waitForSelector('text="E2E Seeded Loop"', {
          timeout: 15_000,
          state: "attached",
        });

        const queueAfter = await request.get(
          `/api/habitats/${habitatId}/extraction/review/queue`,
          { headers: { Authorization: `Bearer ${tok}` } },
        );
        expect(queueAfter.status()).toBe(200);
        const queueIds = ((await queueAfter.json()) as { findings: Array<{ id: string }> })
          .findings.map((f) => f.id);
        expect(queueIds).not.toContain(toAccept.id);
        expect(queueIds).not.toContain(toReject.id);

        const acceptedListRes = await request.get(
          `/api/habitats/${habitatId}/extraction/findings`,
          { headers: { Authorization: `Bearer ${tok}` } },
        );
        expect(acceptedListRes.status()).toBe(200);
        const acceptedIds = ((await acceptedListRes.json()) as {
          findings: Array<{ id: string }>;
        }).findings.map((f) => f.id);
        expect(acceptedIds).toContain(toAccept.id);
        expect(acceptedIds).not.toContain(toReject.id);

        // Re-read the decided finding detail: durable statuses.
        const acceptedDetail = await request.get(
          `/api/habitats/${habitatId}/extraction/findings/${toAccept.id}`,
          { headers: { Authorization: `Bearer ${tok}` } },
        );
        expect(acceptedDetail.status()).toBe(200);
        expect(
          ((await acceptedDetail.json()) as { finding: { status: string } }).finding.status,
        ).toBe("accepted");
        const rejectedDetail = await request.get(
          `/api/habitats/${habitatId}/extraction/findings/${toReject.id}`,
          { headers: { Authorization: `Bearer ${tok}` } },
        );
        expect(rejectedDetail.status()).toBe(200);
        expect(
          ((await rejectedDetail.json()) as { finding: { status: string } }).finding.status,
        ).toBe("rejected");

        // Evidence artifact: Playwright-managed output path (test-results/),
        // local and non-destructive.
        await page.screenshot({
          path: testInfo.outputPath("learning-loop-seeded-final.png"),
          fullPage: true,
        });
      },
    );
  });
});
