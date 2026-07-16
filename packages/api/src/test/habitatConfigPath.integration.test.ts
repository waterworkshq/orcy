/**
 * Config-path integration tests for the habitat settings surface (T4).
 *
 * These exercise the FULL config flow end-to-end against the real (sql.js test)
 * database with the real Fastify route handlers mounted — no mocking of the
 * habitat repository or the secret cache. They complement T3's service-level
 * tests by proving the routes, repositories, and cache behave as a single
 * working system.
 *
 * Coverage:
 *
 *   1. GetHabitatWithColumnsAndTasks (the GET bug) returns a usable habitat row
 *      and a real `Column[]` (driven via `GET /habitats/:id`).
 *   2. PATCH /habitats/:id { codeReviewSettings: {...} } round-trips: persisted
 *      row has the new settings AND the response shows masked secrets
 *      (presence booleans only).
 *   3. Same for ciCdSettings.
 *   4. PUT /habitats/:id/webhook-secrets writes a secret, the in-memory
 *      signature cache resolves the habitat for a matching signature, and
 *      GET /habitats/:id exposes `hasGithubSecret: true` but NOT the raw value.
 *   5. Merge: setting `taskPattern` via PATCH and then a secret via PUT
 *      preserves BOTH.
 *   6. End-to-end webhook trace: a synthetic `pull_request.opened` event with a
 *      matching branch pattern flows through `handlePullRequestEvent`, links a
 *      pull request row, emits a `task.updated` SSE, and (on a closed+merged
 *      action with `autoApproveOnMerge`) approves the linked task.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { columns as columnsSchema } from "../db/schema/index.js";
import { habitatRoutes } from "../routes/habitats.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as boardSecretCache from "../services/boardSecretCache.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as prRepo from "../repositories/pullRequest.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/mission.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function setupApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(habitatRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

async function createHabitat(app: FastifyInstance, token: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/habitats",
    headers: { authorization: `Bearer ${token}` },
    payload: { name, defaultColumns: true },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).habitat.id;
}

describe("config-path integration (T4)", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    await initTestDb();
    if (app) await app.close();
    app = await setupApp();
    token = makeToken({ sub: "user-config-tester", username: "config-tester", role: "admin" });
    boardSecretCache.rebuildCache();
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.restoreAllMocks();
    closeDb();
  });

  describe("GET /habitats/:id (the pre-existing GET bug)", () => {
    it("returns a habitat row plus a real Column[] (not a JSON-stringified value)", async () => {
      const habitatId = await createHabitat(app, token, "GET Bug Habitat");

      const res = await app.inject({
        method: "GET",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.habitat.id).toBe(habitatId);
      // The bug fix: habitat fields come back camelCased and columns is an
      // array. The relational-query path under sql.js returned snake_case
      // keys and `columns` as a JSON-stringified string, which broke
      // `result.columns.map(...)`.
      expect(body.habitat.createdAt).toEqual(expect.any(String));
      expect(body.habitat.teamId).toBeNull();
      expect(Array.isArray(body.columns)).toBe(true);
      expect(body.columns.length).toBeGreaterThanOrEqual(1);
      // Every column should have the camelCased `nextColumnId`, NOT a
      // `next_column_id` snake_case field. The relational query path
      // returned snake_case rows for ALL fields including the joined
      // columns.
      for (const col of body.columns) {
        expect(col.id).toEqual(expect.any(String));
        expect("next_column_id" in col).toBe(false);
        expect("habitat_id" in col).toBe(false);
      }
    });

    it("returns 404 for a non-existent habitat", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/habitats/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /habitats/:id round-trips settings with masked secrets", () => {
    it("persists codeReviewSettings and returns the masked shape", async () => {
      const habitatId = await createHabitat(app, token, "Patch CR Habitat");
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          codeReviewSettings: {
            taskPattern: "([A-Z]{2,10}-\\d+)",
            autoApproveOnMerge: true,
          },
        },
      });
      expect(patchRes.statusCode).toBe(200);
      const patchBody = JSON.parse(patchRes.body);
      expect(patchBody.habitat.codeReviewSettings).toEqual({
        hasGithubSecret: false,
        hasGitlabSecret: false,
        taskPattern: "([A-Z]{2,10}-\\d+)",
        autoApproveOnMerge: true,
      });
      // The secrets should never have been visible in the PATCH response.
      expect(patchRes.body).not.toContain("githubSecret");
      expect(patchRes.body).not.toContain("gitlabSecret");

      // The persisted repo row carries the new non-secret fields. PATCH
      // sends only the non-secret subset (`taskPattern`, `autoApproveOnMerge`)
      // so secret fields are absent (undefined) — not null — after JSON parse.
      const raw = habitatRepo.getHabitatById(habitatId);
      expect(raw?.codeReviewSettings?.taskPattern).toBe("([A-Z]{2,10}-\\d+)");
      expect(raw?.codeReviewSettings?.autoApproveOnMerge).toBe(true);
      expect(raw?.codeReviewSettings?.githubSecret).toBeFalsy();
      expect(raw?.codeReviewSettings?.gitlabSecret).toBeFalsy();
    });

    it("persists ciCdSettings and returns the masked shape", async () => {
      const habitatId = await createHabitat(app, token, "Patch CICD Habitat");
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          ciCdSettings: { taskPattern: "(CI-\\d+)" },
        },
      });
      expect(patchRes.statusCode).toBe(200);
      const patchBody = JSON.parse(patchRes.body);
      expect(patchBody.habitat.ciCdSettings).toEqual({
        hasGithubSecret: false,
        hasGitlabSecret: false,
        taskPattern: "(CI-\\d+)",
      });

      const raw = habitatRepo.getHabitatById(habitatId);
      expect(raw?.ciCdSettings?.taskPattern).toBe("(CI-\\d+)");
    });

    it("PATCH + GET agree: the persisted settings are visible on GET (masked)", async () => {
      const habitatId = await createHabitat(app, token, "Patch+Get Agreement");
      await app.inject({
        method: "PATCH",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          codeReviewSettings: {
            taskPattern: "(ABC-\\d+)",
            autoApproveOnMerge: false,
          },
        },
      });
      const getRes = await app.inject({
        method: "GET",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(getRes.statusCode).toBe(200);
      const body = JSON.parse(getRes.body);
      expect(body.habitat.codeReviewSettings).toEqual({
        hasGithubSecret: false,
        hasGitlabSecret: false,
        taskPattern: "(ABC-\\d+)",
        autoApproveOnMerge: false,
      });
    });
  });

  describe("PUT /habitats/:id/webhook-secrets → cache resolution", () => {
    it("writes a secret, rebuilds the cache, and findHabitatIdByGithubSignature resolves it", async () => {
      const habitatId = await createHabitat(app, token, "Secret Cache Habitat");
      const secretValue = "raw-cache-secret";
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/habitats/${habitatId}/webhook-secrets`,
        headers: { authorization: `Bearer ${token}` },
        payload: { provider: "code_review", githubSecret: secretValue },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.body).not.toContain(secretValue);

      // The PUT must trigger rebuildCache so live HMAC verification can use
      // the new secret. We can verify by checking that the cache lookup
      // resolves the habitat for a signature computed from the secret.
      const { findHabitatIdByGithubSignature, lookupHabitatIdBySecret } = boardSecretCache;
      const payload = "{}";
      const expectedHmac = createHmac("sha256", secretValue).update(payload).digest("hex");
      const resolved = findHabitatIdByGithubSignature(payload, `sha256=${expectedHmac}`);
      expect(resolved).toBe(habitatId);

      // GitLab: not configured, lookup returns null.
      expect(lookupHabitatIdBySecret("not-configured")).toBeNull();
    });

    it("after PUT, GET /habitats/:id exposes hasGithubSecret=true but NEVER the raw value", async () => {
      const habitatId = await createHabitat(app, token, "Get Secret Habitat");
      const secret = "should-never-leak-via-get";
      await app.inject({
        method: "PUT",
        url: `/api/habitats/${habitatId}/webhook-secrets`,
        headers: { authorization: `Bearer ${token}` },
        payload: { provider: "code_review", githubSecret: secret },
      });
      const getRes = await app.inject({
        method: "GET",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(getRes.statusCode).toBe(200);
      const body = JSON.parse(getRes.body);
      expect(body.habitat.codeReviewSettings.hasGithubSecret).toBe(true);
      expect(body.habitat.codeReviewSettings.hasGitlabSecret).toBe(false);
      expect(getRes.body).not.toContain(secret);
      // The raw field name should be absent on the wire even though the
      // underlying repo row carries it.
      expect(body.habitat.codeReviewSettings.githubSecret).toBeUndefined();
      expect(body.habitat.codeReviewSettings.gitlabSecret).toBeUndefined();
    });
  });

  describe("PATCH + PUT merge semantics", () => {
    it("taskPattern set via PATCH is preserved when a secret is set via PUT", async () => {
      const habitatId = await createHabitat(app, token, "Merge PATCH+PUT");
      await app.inject({
        method: "PATCH",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          codeReviewSettings: {
            taskPattern: "(PRESERVED-\\d+)",
            autoApproveOnMerge: true,
          },
        },
      });
      await app.inject({
        method: "PUT",
        url: `/api/habitats/${habitatId}/webhook-secrets`,
        headers: { authorization: `Bearer ${token}` },
        payload: { provider: "code_review", githubSecret: "merged-secret" },
      });

      // GET should show BOTH: the preserved pattern/flag + the new secret presence.
      const getRes = await app.inject({
        method: "GET",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const body = JSON.parse(getRes.body);
      expect(body.habitat.codeReviewSettings).toEqual({
        hasGithubSecret: true,
        hasGitlabSecret: false,
        taskPattern: "(PRESERVED-\\d+)",
        autoApproveOnMerge: true,
      });
      expect(getRes.body).not.toContain("merged-secret");

      // Raw row carries everything.
      const raw = habitatRepo.getHabitatById(habitatId);
      expect(raw?.codeReviewSettings?.taskPattern).toBe("(PRESERVED-\\d+)");
      expect(raw?.codeReviewSettings?.autoApproveOnMerge).toBe(true);
      expect(raw?.codeReviewSettings?.githubSecret).toBe("merged-secret");
    });

    it("secret set via PUT is preserved when taskPattern is updated via PATCH", async () => {
      const habitatId = await createHabitat(app, token, "Merge PUT+PATCH");
      // Set secret FIRST.
      await app.inject({
        method: "PUT",
        url: `/api/habitats/${habitatId}/webhook-secrets`,
        headers: { authorization: `Bearer ${token}` },
        payload: { provider: "code_review", githubSecret: "survives-patch" },
      });
      // Then update non-secret fields via PATCH.
      await app.inject({
        method: "PATCH",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          codeReviewSettings: {
            taskPattern: "(UPDATED-\\d+)",
            autoApproveOnMerge: true,
          },
        },
      });

      // The secret must survive the PATCH (merge, not replace).
      const raw = habitatRepo.getHabitatById(habitatId);
      expect(raw?.codeReviewSettings?.githubSecret).toBe("survives-patch");
      expect(raw?.codeReviewSettings?.taskPattern).toBe("(UPDATED-\\d+)");
      expect(raw?.codeReviewSettings?.autoApproveOnMerge).toBe(true);

      // The cache must still resolve the habitat from the secret.
      boardSecretCache.rebuildCache();
      const sig = createHmac("sha256", "survives-patch").update("{}").digest("hex");
      expect(boardSecretCache.findHabitatIdByGithubSignature("{}", `sha256=${sig}`)).toBe(
        habitatId,
      );

      // GET shows the updated pattern + secret presence, never the raw secret.
      const getRes = await app.inject({
        method: "GET",
        url: `/api/habitats/${habitatId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(getRes.body).not.toContain("survives-patch");
      const body = JSON.parse(getRes.body);
      expect(body.habitat.codeReviewSettings.hasGithubSecret).toBe(true);
      expect(body.habitat.codeReviewSettings.taskPattern).toBe("(UPDATED-\\d+)");
    });
  });
});

/**
 * Feature-review trace: a synthetic PR webhook event flows through the
 * working config-aware path end-to-end. This test creates a real habitat,
 * configures settings via the API, seeds a linked task, then invokes
 * `handlePullRequestEvent` directly with a synthetic event payload and
 * asserts each side effect (PR record, task link, SSE, auto-approve on
 * merge).
 */
describe("feature-review end-to-end PR webhook trace", () => {
  let app: FastifyInstance;
  let token: string;
  let handlePullRequestEvent: typeof import("../services/githubWebhook.js").handlePullRequestEvent;
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await initTestDb();
    if (app) await app.close();
    app = await setupApp();
    token = makeToken({ sub: "user-featurereview", username: "feat-review", role: "admin" });
    boardSecretCache.rebuildCache();
    publishSpy = vi.spyOn(sseBroadcaster, "publish").mockImplementation(() => {});
    const mod = await import("../services/githubWebhook.js");
    handlePullRequestEvent = mod.handlePullRequestEvent;
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.restoreAllMocks();
    closeDb();
  });

  function getFirstColumnId(habitatId: string): string {
    const db = getDb();
    const colRows = db
      .select()
      .from(columnsSchema)
      .where(eq(columnsSchema.habitatId, habitatId))
      .all();
    const firstCol = colRows[0];
    if (!firstCol) throw new Error("expected at least one column");
    return firstCol.id;
  }

  it("opened: PR record created + SSE task.updated emitted (and findTaskForPR matches via taskPattern)", async () => {
    const habitatId = await createHabitat(app, token, "Feature Review Open");

    const columnId = getFirstColumnId(habitatId);
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Test mission",
      createdBy: "user-featurereview",
    });
    taskRepo.createTask({
      missionId: mission.id,
      title: "Implement feature X",
      createdBy: "user-featurereview",
    });
    const task = taskRepo.getTasksByMissionId(mission.id)[0];
    if (!task) throw new Error("task creation failed");

    // Configure task pattern via the API to capture the task id from the
    // PR branch (`mission/<uuid>`). Using a capture group is required —
    // findTaskIdByPattern returns group 1 (or the whole match if no group).
    await app.inject({
      method: "PATCH",
      url: `/api/habitats/${habitatId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        codeReviewSettings: {
          taskPattern: `mission/([0-9a-f-]{36})`,
          autoApproveOnMerge: false,
        },
      },
    });

    // Synthesize a PR webhook that names the task via its prefix in the title.
    const prBody = {
      action: "opened",
      number: 4242,
      pull_request: {
        title: `[${task.id.slice(0, 8)}] Implement feature X`,
        html_url: "https://github.com/example/repo/pull/4242",
        state: "open",
        merged: false,
        head: { ref: `mission/${task.id}` },
        base: { repo: { full_name: "example/repo" } },
      },
    };

    publishSpy.mockClear();
    const result = handlePullRequestEvent(prBody as any);
    expect(result.status).toBe("linked");
    expect(result.taskId).toBe(task.id);

    // PR record persisted.
    const pr = prRepo.findByProviderAndNumber("github", "example/repo", 4242);
    expect(pr).not.toBeNull();
    expect(pr?.taskId).toBe(task.id);

    // SSE task.updated emitted on the habitat channel.
    expect(publishSpy).toHaveBeenCalled();
    const taskUpdatedCall = publishSpy.mock.calls.find(
      (c: [string, { type: string } | undefined]) => c[1]?.type === "task.updated",
    );
    expect(taskUpdatedCall).toBeDefined();
  });

  it("merged + autoApproveOnMerge: linked submitted task is auto-approved and SSE task.approved fires", async () => {
    const habitatId = await createHabitat(app, token, "Feature Review Merge");

    const columnId = getFirstColumnId(habitatId);
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Auto approve mission",
      createdBy: "user-featurereview",
    });
    taskRepo.createTask({
      missionId: mission.id,
      title: "Auto approve task",
      createdBy: "user-featurereview",
    });
    const task = taskRepo.getTasksByMissionId(mission.id)[0];
    if (!task) throw new Error("task creation failed");
    // Transition it to submitted for the autoApprove path.
    taskRepo.updateTask(task.id, { status: "submitted" });

    // Configure with autoApproveOnMerge = true and a matching pattern.
    await app.inject({
      method: "PATCH",
      url: `/api/habitats/${habitatId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        codeReviewSettings: {
          taskPattern: `mission/([0-9a-f-]{36})`,
          autoApproveOnMerge: true,
        },
      },
    });

    // Drive an opened then closed+merged sequence.
    const opened = {
      action: "opened",
      number: 9001,
      pull_request: {
        title: `[${task.id.slice(0, 8)}] Auto approve task`,
        html_url: "https://github.com/example/repo/pull/9001",
        state: "open",
        merged: false,
        head: { ref: `mission/${task.id}` },
        base: { repo: { full_name: "example/repo" } },
      },
    };
    const openedResult = handlePullRequestEvent(opened as any);
    expect(openedResult.status).toBe("linked");

    publishSpy.mockClear();

    const closedMerged = {
      action: "closed",
      number: 9001,
      pull_request: {
        title: `[${task.id.slice(0, 8)}] Auto approve task`,
        html_url: "https://github.com/example/repo/pull/9001",
        state: "closed",
        merged: true,
        head: { ref: `mission/${task.id}` },
        base: { repo: { full_name: "example/repo" } },
      },
    };
    const closedResult = handlePullRequestEvent(closedMerged as any);
    expect(closedResult.status).toBe("closed");

    // The PR record has been transitioned to merged.
    const pr = prRepo.findByProviderAndNumber("github", "example/repo", 9001);
    expect(pr?.state).toBe("merged");

    // The task was auto-approved.
    const approvedTask = taskRepo.getTaskById(task.id);
    expect(approvedTask?.status).toBe("approved");

    // SSE task.approved was emitted on the habitat channel.
    const approvedCall = publishSpy.mock.calls.find(
      (c: [string, { type: string } | undefined]) => c[1]?.type === "task.approved",
    );
    expect(approvedCall).toBeDefined();
  });

  it("returns no_matching_task when no habitat's taskPattern matches", async () => {
    await createHabitat(app, token, "Feature Review NoMatch");
    publishSpy.mockClear();
    const prBody = {
      action: "opened",
      number: 5,
      pull_request: {
        title: "Unrelated change",
        html_url: "https://github.com/example/repo/pull/5",
        state: "open",
        merged: false,
        head: { ref: "feature/no-match" },
        base: { repo: { full_name: "example/repo" } },
      },
    };
    const result = handlePullRequestEvent(prBody as any);
    expect(result.status).toBe("no_matching_task");
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
