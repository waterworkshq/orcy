/**
 * domain_expert reviewer routing — REAL API boundary proof (F2).
 *
 * Zero-human TEAM habitat (a team exists but has no human members — the
 * shape whose human-pool early exit used to swallow agent assignment).
 * The domain-matching AGENT reviews end-to-end through the real routes:
 * worker claims/starts/submits with its API key (assignment fires inside
 * the real submit path, the SSE carries reviewerType "agent"), then the
 * domain-matched reviewer approves with its own API key — 200, row
 * approved, task approved.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { habitats, teams, organizations } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

const JWT_SECRET = "domain-reviewer-boundary-test-secret";

let app: HttpRuntimeHandle;
let priorSlackSecret: string | undefined;
let priorDiscordKey: string | undefined;
let priorRegistrationToken: string | undefined;
let priorHost: string | undefined;

beforeAll(async () => {
  priorSlackSecret = process.env.SLACK_SIGNING_SECRET;
  priorDiscordKey = process.env.DISCORD_PUBLIC_KEY;
  priorRegistrationToken = process.env.ORCY_REGISTRATION_TOKEN;
  priorHost = process.env.HOST;
  process.env.SLACK_SIGNING_SECRET = "domain-reviewer-boundary-slack-secret";
  process.env.DISCORD_PUBLIC_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "domain-reviewer-boundary-reg-token";
  delete process.env.HOST;

  await initTestDb();
  setJwtSecret(JWT_SECRET);
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
});

afterAll(async () => {
  await app.close();
  closeDb();
  if (priorSlackSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = priorSlackSecret;
  if (priorDiscordKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
  else process.env.DISCORD_PUBLIC_KEY = priorDiscordKey;
  if (priorRegistrationToken === undefined) delete process.env.ORCY_REGISTRATION_TOKEN;
  else process.env.ORCY_REGISTRATION_TOKEN = priorRegistrationToken;
  if (priorHost === undefined) delete process.env.HOST;
  else process.env.HOST = priorHost;
});

let workerKey: string;
let workerId: string;
let reviewerKey: string;
let reviewerId: string;
let taskId: string;
let habitatId: string;

beforeEach(async () => {
  await initTestDb();

  const worker = agentRepo.createAgent({ name: "domain-worker", type: "codex", domain: "backend" });
  workerId = worker.agent.id;
  workerKey = worker.plainApiKey;

  const reviewer = agentRepo.createAgent({
    name: "domain-reviewer",
    type: "codex",
    domain: "backend",
  });
  reviewerId = reviewer.agent.id;
  reviewerKey = reviewer.plainApiKey;

  // Zero-human TEAM habitat: the team exists, membership is empty.
  const habitat = habitatRepo.createHabitat({ name: "Domain Boundary Habitat" });
  habitatId = habitat.id;
  const db = getDb();
  db.insert(organizations).values({ id: "org-d1", name: "OD", slug: "org-d1" }).run();
  db.insert(teams)
    .values({ id: "team-d1", organizationId: "org-d1", name: "TD", slug: "team-d1" })
    .run();
  db.update(habitats).set({ teamId: "team-d1" }).where(eq(habitats.id, habitatId)).run();

  const column = columnRepo.createColumn({ habitatId, name: "Backlog" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "Domain Boundary Mission",
    createdBy: "boundary",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Domain Boundary Task",
    createdBy: "boundary",
    requiredDomain: "backend",
  });
  taskId = task.id;

  reviewRuleRepo.create(habitatId, {
    name: "domain rule",
    assignmentStrategy: "domain_expert",
    requiredReviews: 1,
  });
});

describe("domain_expert end-to-end at the real API boundary (zero-human team habitat)", () => {
  it("real submit assigns the domain-matching agent (agent-typed row + SSE), which approves with its API key", async () => {
    const reviewEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = sseBroadcaster.subscribe(habitatId, (event: any) => {
      if (event.type === "task.review_assigned") reviewEvents.push(event.data);
    });

    try {
      const claim = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/claim`,
        headers: { "X-Agent-API-Key": workerKey },
        payload: {},
      });
      expect(claim.statusCode).toBe(200);

      const start = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/start`,
        headers: { "X-Agent-API-Key": workerKey },
      });
      expect(start.statusCode).toBe(200);

      const submit = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/submit`,
        headers: { "X-Agent-API-Key": workerKey },
        payload: { result: "domain work done", artifacts: [] },
      });
      expect(submit.statusCode).toBe(200);

      // Assignment happened inside the real submit path: one agent-typed
      // row for the domain-matching reviewer, none for the worker.
      const rows = taskReviewerRepo.getByTaskId(taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0].reviewerType).toBe("agent");
      expect(rows[0].reviewerId).toBe(reviewerId);

      // The SSE carried the row's real type at assignment time.
      expect(reviewEvents).toHaveLength(1);
      expect(reviewEvents[0].reviewerId).toBe(reviewerId);
      expect(reviewEvents[0].reviewerType).toBe("agent");

      const approve = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/approve`,
        headers: { "X-Agent-API-Key": reviewerKey },
        payload: {},
      });
      expect(approve.statusCode).toBe(200);

      const after = taskRepo.getTaskById(taskId)!;
      expect(after.status).toBe("approved");
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId, "agent")?.status).toBe(
        "approved",
      );
    } finally {
      unsubscribe();
    }
  });
});
