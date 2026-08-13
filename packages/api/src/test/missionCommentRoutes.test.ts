/**
 * Discriminating auth for mission comment writes.
 * Mutate-and-revert: restoring `agentAuth` on POST/PATCH/DELETE would 401 a JWT.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { missionCommentRoutes } from "../routes/missionComments.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerErrorHandler(app);
  await app.register(
    async (f) => {
      await f.register(missionCommentRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

describe("mission comment write auth", () => {
  let app: FastifyInstance | null = null;
  let missionId: string;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
    const habitat = habitatRepo.createHabitat({ name: "Comment Habitat" });
    const column = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Comment Mission",
      createdBy: "user-local",
    });
    missionId = mission.id;
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("lets a human JWT create, edit, and delete a mission comment", async () => {
    const token = makeToken({ sub: "user-local", username: "local", role: "editor" });
    const auth = { Authorization: `Bearer ${token}` };

    const created = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/comments`,
      headers: auth,
      payload: { content: "ship the fix" },
    });
    expect(created.statusCode).toBe(201);
    const comment = created.json().comment as { id: string; authorType: string; authorId: string };
    expect(comment.authorType).toBe("human");
    expect(comment.authorId).toBe("user-local");

    const patched = await app!.inject({
      method: "PATCH",
      url: `/api/missions/${missionId}/comments/${comment.id}`,
      headers: auth,
      payload: { content: "shipped" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().comment.content).toBe("shipped");

    const deleted = await app!.inject({
      method: "DELETE",
      url: `/api/missions/${missionId}/comments/${comment.id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("returns 401 without auth on POST", async () => {
    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/comments`,
      payload: { content: "ship the fix" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("still lets an agent API key create a comment", async () => {
    const created = agentRepo.createAgent({
      name: "comment-agent",
      type: "codex",
      domain: "ops",
    });
    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/comments`,
      headers: { "X-Agent-API-Key": created.plainApiKey },
      payload: { content: "retry failed" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().comment.authorType).toBe("agent");
    expect(res.json().comment.authorId).toBe(created.agent.id);
  });
});
