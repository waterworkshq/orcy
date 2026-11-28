import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { habitats, pipelineEvents, taskEvents } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as pipelineRepo from "../repositories/pipelineEvent.js";
import { rebuildCache } from "../services/habitatSecretCache.js";
import { ciCdWebhookRoutes } from "../routes/ciCdWebhooks.js";

const WEBHOOK_SECRET = "test-cicd-webhook-secret";

function signPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("GitHub workflow_job webhook (served authenticated Fastify + SQL.js)", () => {
  let app: FastifyInstance | null = null;
  let habitatId: string;
  let taskId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();

    const habitat = habitatRepo.createHabitat({ name: "CI/CD Webhook Habitat" });
    habitatId = habitat.id;

    db.update(habitats)
      .set({
        ciCdSettings: {
          githubSecret: WEBHOOK_SECRET,
          gitlabSecret: null,
          taskPattern: "mission/([0-9a-f-]{36})",
        },
      })
      .where(eq(habitats.id, habitatId))
      .run();

    rebuildCache();

    const column = columnRepo.createColumn({
      habitatId,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId,
      columnId: column.id,
      title: "CI/CD Mission",
      createdBy: "user-1",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Fix workflow_job",
      createdBy: "user-1",
    });
    taskId = task.id;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    closeDb();
  });

  async function buildApp(): Promise<FastifyInstance> {
    const server = Fastify({ logger: false });
    await server.register(
      async (f) => {
        await f.register(ciCdWebhookRoutes);
      },
      { prefix: "/api" },
    );
    await server.ready();
    return server;
  }

  async function postGitHubCi(
    server: FastifyInstance,
    payload: unknown,
    event = "workflow_job",
    signatureOverride?: string,
  ) {
    const rawBody = JSON.stringify(payload);
    const signature = signatureOverride ?? signPayload(rawBody, WEBHOOK_SECRET);
    return server.inject({
      method: "POST",
      url: "/api/webhooks/github-ci",
      payload: rawBody,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-hub-signature-256": signature,
      },
    });
  }

  it("accepts official GitHub workflow_job payload with top-level repository and records normalized identity", async () => {
    app = await buildApp();
    const payload = {
      action: "completed",
      workflow_job: {
        id: 9901,
        run_id: 4242,
        name: "unit-tests",
        status: "completed",
        conclusion: "success",
        head_branch: `mission/${taskId}`,
        head_sha: "deadbeef1234",
        html_url: "https://github.com/waterworkshq/orcy/actions/runs/4242/job/9901",
      },
      repository: {
        id: 123456,
        full_name: "waterworkshq/orcy",
      },
    };

    const res = await postGitHubCi(app, payload);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: "processed", taskId });

    const rows = pipelineRepo.getByTaskId(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId,
      provider: "github",
      repo: "waterworkshq/orcy",
      runId: "4242",
      status: "success",
      branch: `mission/${taskId}`,
      commitSha: "deadbeef1234",
    });

    const db = getDb();
    const eventRows = db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].metadata).toMatchObject({
      provider: "github",
      repo: "waterworkshq/orcy",
      runId: "4242",
      pipelineStatus: "success",
      branch: `mission/${taskId}`,
    });
  });

  it("prefers top-level delivery repository over nested workflow_job.repository when both are present", async () => {
    app = await buildApp();
    const payload = {
      action: "in_progress",
      workflow_job: {
        id: 9902,
        run_id: 4243,
        name: "lint",
        status: "in_progress",
        conclusion: null,
        head_branch: `mission/${taskId}`,
        head_sha: "cafebabe",
        repository: { full_name: "nested/ignored" },
        html_url: "https://github.com/waterworkshq/orcy/actions/runs/4243/job/9902",
      },
      repository: {
        full_name: "waterworkshq/orcy",
      },
    };

    const res = await postGitHubCi(app, payload);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: "processed", taskId });

    const rows = pipelineRepo.getByTaskId(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe("waterworkshq/orcy");
  });

  it("preserves legacy synthetic payload when only workflow_job.repository is present", async () => {
    app = await buildApp();
    const payload = {
      action: "completed",
      workflow_job: {
        id: 9903,
        run_id: 4244,
        name: "legacy",
        status: "completed",
        conclusion: "failure",
        head_branch: `mission/${taskId}`,
        head_sha: "112233",
        repository: { full_name: "legacy/repo" },
        html_url: "https://github.com/legacy/repo/actions/runs/4244/job/9903",
      },
    };

    const res = await postGitHubCi(app, payload);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: "processed", taskId });

    const rows = pipelineRepo.getByTaskId(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe("legacy/repo");
    expect(rows[0].status).toBe("failure");
  });

  it.each([
    [
      "missing repository everywhere",
      (tid: string) => ({
        action: "completed",
        workflow_job: {
          id: 1,
          run_id: 100,
          status: "completed",
          conclusion: "success",
          head_branch: `mission/${tid}`,
          head_sha: "abc",
        },
      }),
    ],
    [
      "malformed top-level repository (missing full_name) even with nested repository",
      (tid: string) => ({
        action: "completed",
        repository: { full_name: "   " },
        workflow_job: {
          id: 1,
          run_id: 100,
          status: "completed",
          conclusion: "success",
          head_branch: `mission/${tid}`,
          head_sha: "abc",
          repository: { full_name: "legacy/repo" },
        },
      }),
    ],
    [
      "null top-level repository",
      (tid: string) => ({
        action: "completed",
        repository: null,
        workflow_job: {
          id: 1,
          run_id: 100,
          status: "completed",
          conclusion: "success",
          head_branch: `mission/${tid}`,
          head_sha: "abc",
        },
      }),
    ],
    [
      "missing workflow_job",
      () => ({
        action: "completed",
        repository: { full_name: "waterworkshq/orcy" },
      }),
    ],
    [
      "missing workflow_job.run_id",
      (tid: string) => ({
        action: "completed",
        repository: { full_name: "waterworkshq/orcy" },
        workflow_job: {
          id: 1,
          status: "completed",
          conclusion: "success",
          head_branch: `mission/${tid}`,
          head_sha: "abc",
        },
      }),
    ],
    [
      "invalid workflow_job.run_id (non-positive)",
      (tid: string) => ({
        action: "completed",
        repository: { full_name: "waterworkshq/orcy" },
        workflow_job: {
          id: 1,
          run_id: 0,
          status: "completed",
          conclusion: "success",
          head_branch: `mission/${tid}`,
          head_sha: "abc",
        },
      }),
    ],
    [
      "missing workflow_job.head_branch",
      () => ({
        action: "completed",
        repository: { full_name: "waterworkshq/orcy" },
        workflow_job: {
          id: 1,
          run_id: 100,
          status: "completed",
          conclusion: "success",
          head_branch: null,
          head_sha: "abc",
        },
      }),
    ],
    [
      "missing workflow_job.status",
      (tid: string) => ({
        action: "completed",
        repository: { full_name: "waterworkshq/orcy" },
        workflow_job: {
          id: 1,
          run_id: 100,
          status: "",
          conclusion: null,
          head_branch: `mission/${tid}`,
          head_sha: "abc",
        },
      }),
    ],
    [
      "unrecognized workflow_job.status",
      (tid: string) => ({
        action: "completed",
        repository: { full_name: "waterworkshq/orcy" },
        workflow_job: {
          id: 1,
          run_id: 100,
          status: "compeleted",
          conclusion: "success",
          head_branch: `mission/${tid}`,
          head_sha: "abc",
        },
      }),
    ],
    [
      "missing workflow_job.conclusion on completed job",
      (tid: string) => ({
        action: "completed",
        repository: { full_name: "waterworkshq/orcy" },
        workflow_job: {
          id: 1,
          run_id: 100,
          status: "completed",
          conclusion: null,
          head_branch: `mission/${tid}`,
          head_sha: "abc",
        },
      }),
    ],
    [
      "empty workflow_job.conclusion on completed job",
      (tid: string) => ({
        action: "completed",
        repository: { full_name: "waterworkshq/orcy" },
        workflow_job: {
          id: 1,
          run_id: 100,
          status: "completed",
          conclusion: "   ",
          head_branch: `mission/${tid}`,
          head_sha: "abc",
        },
      }),
    ],
  ])(
    "returns typed 400 validation rejection before DB effects for %s",
    async (_label, buildPayload) => {
      app = await buildApp();
      const db = getDb();
      const beforePipelines = db.select().from(pipelineEvents).all().length;
      const beforeEvents = db.select().from(taskEvents).all().length;

      const res = await postGitHubCi(app, buildPayload(taskId));
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toMatchObject({
        status: "error",
        statusCode: 400,
      });
      expect(typeof body.error).toBe("string");

      expect(db.select().from(pipelineEvents).all().length).toBe(beforePipelines);
      expect(db.select().from(taskEvents).all().length).toBe(beforeEvents);
    },
  );

  it("preserves webhook admission (rejects invalid HMAC signature with 401)", async () => {
    app = await buildApp();
    const payload = {
      action: "completed",
      repository: { full_name: "waterworkshq/orcy" },
      workflow_job: {
        id: 1,
        run_id: 100,
        status: "completed",
        conclusion: "success",
        head_branch: `mission/${taskId}`,
        head_sha: "abc",
      },
    };

    const res = await postGitHubCi(app, payload, "workflow_job", "sha256=deadbeef");
    expect(res.statusCode).toBe(401);
  });

  it("preserves parent workflow_run handling and artifacts", async () => {
    app = await buildApp();
    const workflowRunPayload = {
      action: "completed",
      workflow_run: {
        id: 7777,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        head_branch: `mission/${taskId}`,
        head_sha: "aaa111",
        repository: { full_name: "waterworkshq/orcy" },
        html_url: "https://github.com/waterworkshq/orcy/actions/runs/7777",
      },
    };

    const runRes = await postGitHubCi(app, workflowRunPayload, "workflow_run");
    expect(runRes.statusCode).toBe(200);
    expect(JSON.parse(runRes.payload)).toEqual({ status: "processed", taskId });

    const taskAfterRun = taskRepo.getTaskById(taskId);
    expect(taskAfterRun?.artifacts).toEqual([
      expect.objectContaining({
        type: "log",
        url: "https://github.com/waterworkshq/orcy/actions/runs/7777",
        description: "CI failed",
      }),
    ]);
  });
});
