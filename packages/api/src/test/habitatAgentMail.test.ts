/**
 * Discriminating auth for GET /habitats/:habitatId/agent-messages (ADR-0046).
 * Mutate-and-revert: dropping humanAuth, skipping the agent/remote reject, or
 * calling markAsRead in the GET would fail these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { habitatAgentMailRoutes } from "../routes/habitatAgentMail.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as teamRepo from "../repositories/team.js";
import * as orgRepo from "../repositories/organization.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as agentRepo from "../repositories/agent.js";
import * as agentMessageRepo from "../repositories/agentMessage.js";
import { users } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function ensureUser(userId: string, username?: string) {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users)
      .values({
        id: userId,
        username: username ?? userId,
        passwordHash: "hash",
        displayName: username ?? userId,
        role: "editor",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerErrorHandler(app);
  await app.register(
    async (f) => {
      await f.register(habitatAgentMailRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

describe("GET /habitats/:habitatId/agent-messages", () => {
  let app: FastifyInstance | null = null;
  let habitatId: string;
  let otherHabitatId: string;
  let fromId: string;
  let toId: string;
  let mailBody: string;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();

    ensureUser("user-local", "local");
    ensureUser("user-stranger", "stranger");
    const org = orgRepo.createOrganization({ name: "Mail Org", slug: "mail-org" });
    const team = teamRepo.createTeam({ organizationId: org.id, name: "Mail Team", slug: "mail-team" });
    const habitat = habitatRepo.createHabitat({ name: "Mail Habitat", teamId: team.id });
    habitatId = habitat.id;
    memberRepo.addMember({ teamId: team.id, userId: "user-local", role: "member" });

    const otherTeam = teamRepo.createTeam({
      organizationId: org.id,
      name: "Other Team",
      slug: "other-team",
    });
    const other = habitatRepo.createHabitat({ name: "Other Habitat", teamId: otherTeam.id });
    otherHabitatId = other.id;

    const from = agentRepo.createAgent({ name: "mail-from", type: "claude-code", domain: "backend" });
    fromId = from.agent.id;
    const to = agentRepo.createAgent({ name: "mail-to", type: "opencode", domain: "frontend" });
    toId = to.agent.id;
    mailBody = "SECRET_STACK_DUMP_DO_NOT_LEAK_TO_REMOTE";
    agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: fromId,
      toAgentId: toId,
      subject: "retry failed",
      body: mailBody,
    });
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("returns 401 without a human JWT", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/agent-messages`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an agent API key (humanAuth only)", async () => {
    const created = agentRepo.createAgent({
      name: "key-agent",
      type: "codex",
      domain: "ops",
    });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/agent-messages`,
      headers: { "x-agent-api-key": created.plainApiKey },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a human who is not a member of the habitat team", async () => {
    const token = makeToken({ sub: "user-stranger", username: "stranger", role: "editor" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/agent-messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not list another habitat's mail to a member of this habitat", async () => {
    agentMessageRepo.createMessage({
      habitatId: otherHabitatId,
      fromAgentId: fromId,
      toAgentId: toId,
      subject: "other habitat",
      body: "OTHER_HABITAT_BODY",
    });
    const token = makeToken({ sub: "user-local", username: "local", role: "editor" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/agent-messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Array<{ habitatId: string; body: string }> };
    expect(body.messages.every((m) => m.habitatId === habitatId)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("OTHER_HABITAT_BODY");
  });

  it("returns bodies to a local team member and does not set readAt", async () => {
    const token = makeToken({ sub: "user-local", username: "local", role: "editor" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/agent-messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      messages: Array<{ body: string; subject: string; readAt: string | null }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.messages[0].subject).toBe("retry failed");
    expect(body.messages[0].body).toBe(mailBody);
    expect(body.messages[0].readAt).toBeNull();

    const unread = agentMessageRepo.getUnreadCount(toId);
    expect(unread).toBe(1);
  });

  it("does not register a human POST", async () => {
    const token = makeToken({ sub: "user-local", username: "local", role: "editor" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/agent-messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subject: "nope", body: "nope" },
    });
    expect(res.statusCode).toBe(404);
  });
});
