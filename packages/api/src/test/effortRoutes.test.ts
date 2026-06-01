import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { effortRoutes } from "../routes/effort.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as habitatService from "../services/boardService.js";
import * as agentRepo from "../repositories/agent.js";
import * as effortRepo from "../repositories/effortEntry.js";
import { users } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function ensureUser(userId: string) {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users)
      .values({
        id: userId,
        username: userId,
        passwordHash: "hash",
        displayName: userId,
        role: "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(effortRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;
let agentApiKey: string;
let userToken: string;

function setupTestData() {
  const { habitat, columns } = habitatService.createHabitat({
    name: "Route Test Habitat",
    defaultColumns: true,
  });
  habitatId = habitat.id;
  columnId = columns[0].id;

  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Route Test Mission",
    createdBy: "test-user",
  });
  missionId = mission.id;

  const { agent, plainApiKey } = agentRepo.createAgent({
    name: `route-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  agentId = agent.id;
  agentApiKey = plainApiKey;

  ensureUser("route-test-user");
  userToken = makeToken({ sub: "route-test-user", username: "Route Tester", role: "admin" });
}

describe("Effort Routes", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    setupTestData();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  describe("GET /tasks/:id/effort-report", () => {
    it("returns 404 for non-existent task", async () => {
      const res = await app!.inject({
        method: "GET",
        url: "/api/tasks/nonexistent-id/effort-report",
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns effort report for existing task", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Report route task",
        createdBy: "test-user",
      });
      effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        minutes: 30,
        source: "human_manual",
      });

      const res = await app!.inject({
        method: "GET",
        url: `/api/tasks/${task.id}/effort-report`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.target.id).toBe(task.id);
      expect(body.totals.loggedEffortMinutes).toBe(30);
    });
  });

  describe("GET /tasks/:id/effort-entries", () => {
    it("returns entries for task", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Entries route task",
        createdBy: "test-user",
      });
      effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        minutes: 20,
        source: "human_manual",
      });

      const res = await app!.inject({
        method: "GET",
        url: `/api/tasks/${task.id}/effort-entries`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0].minutes).toBe(20);
    });

    it("respects includeCorrections query param", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Corrections query task",
        createdBy: "test-user",
      });
      effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        minutes: 30,
        source: "human_manual",
      });
      effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        minutes: -5,
        source: "correction_adjustment",
        correctsEntryId: "fake",
      });

      const resWith = await app!.inject({
        method: "GET",
        url: `/api/tasks/${task.id}/effort-entries`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(JSON.parse(resWith.body)).toHaveLength(2);

      const resWithout = await app!.inject({
        method: "GET",
        url: `/api/tasks/${task.id}/effort-entries?includeCorrections=false`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(JSON.parse(resWithout.body)).toHaveLength(1);
    });

    it("returns 404 for non-existent task", async () => {
      const res = await app!.inject({
        method: "GET",
        url: "/api/tasks/nonexistent-id/effort-entries",
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /tasks/:id/effort-entries", () => {
    it("returns 404 for non-existent task", async () => {
      const res = await app!.inject({
        method: "POST",
        url: "/api/tasks/nonexistent-id/effort-entries",
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutes: 30 },
      });
      expect(res.statusCode).toBe(404);
    });

    it("creates effort entry with valid body", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Create entry task",
        createdBy: "test-user",
      });

      const res = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutes: 45, note: "Route test entry" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.minutes).toBe(45);
      expect(body.note).toBe("Route test entry");
      expect(body.source).toBe("human_manual");
    });

    it("returns error for invalid minutes (negative, zero, non-integer)", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Invalid minutes route task",
        createdBy: "test-user",
      });

      const resNeg = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutes: -5 },
      });
      expect(resNeg.statusCode).toBe(400);

      const resZero = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutes: 0 },
      });
      expect(resZero.statusCode).toBe(400);

      const resFloat = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutes: 1.5 },
      });
      expect(resFloat.statusCode).toBe(400);
    });

    it("uses agent context when agent is authenticated", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Agent auth task",
        createdBy: "test-user",
      });

      const res = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries`,
        headers: { "x-agent-api-key": agentApiKey },
        payload: { minutes: 20 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.actorType).toBe("agent");
      expect(body.actorId).toBe(agentId);
      expect(body.source).toBe("agent_reported");
    });

    it("uses human context when user is authenticated", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Human auth task",
        createdBy: "test-user",
      });

      const res = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutes: 25 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.actorType).toBe("human");
      expect(body.source).toBe("human_manual");
    });
  });

  describe("POST /tasks/:id/effort-entries/:entryId/correct", () => {
    it("returns error if entry not found", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Correct missing task",
        createdBy: "test-user",
      });

      const res = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries/nonexistent-entry/correct`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutesDelta: -5, correctionReason: "Adjustment" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns error if minutesDelta is 0", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Zero delta route task",
        createdBy: "test-user",
      });
      const entry = effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        minutes: 30,
        source: "human_manual",
      });

      const res = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries/${entry.id}/correct`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutesDelta: 0, correctionReason: "No change" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns error if correctionReason is empty", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Empty reason route task",
        createdBy: "test-user",
      });
      const entry = effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        minutes: 30,
        source: "human_manual",
      });

      const res = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries/${entry.id}/correct`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutesDelta: -5, correctionReason: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns error if correctionReason exceeds 500 chars", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Long reason route task",
        createdBy: "test-user",
      });
      const entry = effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        minutes: 30,
        source: "human_manual",
      });

      const res = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries/${entry.id}/correct`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutesDelta: -5, correctionReason: "x".repeat(501) },
      });
      expect(res.statusCode).toBe(400);
    });

    it("creates correction with valid input", async () => {
      const task = taskRepo.createTask({
        missionId,
        title: "Valid correct route task",
        createdBy: "test-user",
      });
      const entry = effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        minutes: 60,
        source: "human_manual",
      });

      const res = await app!.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/effort-entries/${entry.id}/correct`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { minutesDelta: -10, correctionReason: "Overcounted by 10 minutes" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.source).toBe("correction_adjustment");
      expect(body.minutes).toBe(-10);
      expect(body.correctsEntryId).toBe(entry.id);
    });
  });

  describe("GET /missions/:id/effort-report", () => {
    it("returns 404 for non-existent mission", async () => {
      const res = await app!.inject({
        method: "GET",
        url: "/api/missions/nonexistent-id/effort-report",
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns mission effort report", async () => {
      const task1 = taskRepo.createTask({
        missionId,
        title: "Mission report task 1",
        createdBy: "test-user",
      });
      const task2 = taskRepo.createTask({
        missionId,
        title: "Mission report task 2",
        createdBy: "test-user",
      });
      effortRepo.createEffortEntry({
        taskId: task1.id,
        actorType: "human",
        minutes: 20,
        source: "human_manual",
      });
      effortRepo.createEffortEntry({
        taskId: task2.id,
        actorType: "human",
        minutes: 30,
        source: "human_manual",
      });

      const res = await app!.inject({
        method: "GET",
        url: `/api/missions/${missionId}/effort-report`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.target.type).toBe("mission");
      expect(body.target.id).toBe(missionId);
      expect(body.totals.loggedEffortMinutes).toBe(50);
      expect(body.tasks).toHaveLength(2);
    });
  });
});
