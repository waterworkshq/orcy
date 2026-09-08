/**
 * Agent review decision transport — REAL API boundary proof.
 *
 * The full production assembly (`createHttpApplication`) with a real agent
 * API key: an agent holding a pending typed reviewer row must be able to
 * approve/reject a submitted task THROUGH the route, with the decision
 * persisting (task row, reviewer row, task_events provenance carrying
 * actorType "agent"). The human JWT control on the same route proves the
 * restoration did not disturb the human path. An agent WITHOUT a pending
 * row must be refused.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import { tasks, taskEvents, users } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

const JWT_SECRET = "agent-review-boundary-test-secret";

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
  process.env.SLACK_SIGNING_SECRET = "agent-review-boundary-slack-secret";
  process.env.DISCORD_PUBLIC_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "agent-review-boundary-reg-token";
  delete process.env.HOST; // 127.0.0.1 default → local-dev posture

  await initTestDb();
  setJwtSecret(JWT_SECRET);
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]); // no discovery cycle: empty validated catalog
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

let agentKey: string;
let reviewerId: string;
let workerId: string;
let taskId: string;
let humanToken: string;

beforeEach(async () => {
  await initTestDb();

  const worker = agentRepo.createAgent({ name: "boundary-worker", type: "codex", domain: "fullstack" });
  workerId = worker.agent.id;

  const reviewer = agentRepo.createAgent({
    name: "boundary-reviewer",
    type: "codex",
    domain: "fullstack",
  });
  reviewerId = reviewer.agent.id;
  agentKey = reviewer.plainApiKey;

  getDb()
    .insert(users)
    .values({ id: "boundary-human", username: "boundary", passwordHash: "x", displayName: "b", role: "admin" })
    .run();
  humanToken = jwt.sign(
    { sub: "boundary-human", username: "boundary", role: "admin" },
    JWT_SECRET,
    { issuer: "orcy" },
  );

  const habitat = habitatRepo.createHabitat({ name: "Boundary Habitat" });
  void habitat;
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog" });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Boundary Mission",
    createdBy: "boundary-human",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Boundary Task",
    createdBy: "boundary-human",
  });
  taskRepo.claimTask(task.id, workerId);
  taskRepo.startTask(task.id, workerId);
  const submitted = taskRepo.submitTask(task.id, workerId, "boundary work", []);
  if (!submitted) throw new Error("test fixture: submitTask failed");
  taskId = task.id;
});

function terminalEvents(): Array<{ action: string; actorType: string; actorId: string }> {
  return (getDb().select().from(taskEvents).all() as any[]).filter(
    (r) => r.taskId === taskId && (r.action === "approved" || r.action === "rejected"),
  );
}

describe("Agent review decisions at the real API boundary", () => {
  it("agent API key with a pending typed row approves through the route — persistent result, agent provenance", async () => {
    taskReviewerRepo.create(taskId, "agent", reviewerId);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/approve`,
      headers: { "X-Agent-API-Key": agentKey },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("approved");
    expect(taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId)?.status).toBe("approved");
    const events = terminalEvents();
    expect(events).toHaveLength(1);
    expect(events[0].actorType).toBe("agent");
    expect(events[0].actorId).toBe(reviewerId);
  });

  it("agent API key with a pending typed row rejects through the route", async () => {
    taskReviewerRepo.create(taskId, "agent", reviewerId);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/reject`,
      headers: { "X-Agent-API-Key": agentKey },
      payload: { reason: "boundary reject" },
    });

    expect(res.statusCode).toBe(200);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.rejectionReason).toBe("boundary reject");
    expect(terminalEvents()[0].actorType).toBe("agent");
  });

  it("agent API key WITHOUT a pending row is refused (403) and nothing persists", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/approve`,
      headers: { "X-Agent-API-Key": agentKey },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("submitted");
    expect(terminalEvents()).toHaveLength(0);
  });

  it("human JWT control still approves the same route (human path undisturbed)", async () => {
    taskReviewerRepo.create(taskId, "human", "boundary-human");

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/approve`,
      headers: { Authorization: `Bearer ${humanToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("approved");
    expect(terminalEvents()[0].actorType).toBe("human");
  });
});

// Keep the tasks table import referenced for the reopen helper parity with sibling suites.
void tasks;
