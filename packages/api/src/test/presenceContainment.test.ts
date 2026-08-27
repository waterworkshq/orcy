import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { users } from "../db/schema/index.js";
import { presenceRoutes } from "../routes/presence.js";
import { sharedInviteRoutes } from "../routes/sharedInvite.js";
import {
  resetPresenceForTesting,
  getHabitatPresence,
  cleanupStalePresence,
} from "../sse/presence.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as orgRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as podRepo from "../repositories/remotePod.js";
import * as inviteService from "../services/remoteInviteService.js";
import * as providerService from "../services/identityProviderService.js";
import * as agentService from "../services/agentService.js";

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getSubscriberCount: vi.fn(() => 0),
  },
}));

import { sseBroadcaster } from "../sse/broadcaster.js";

const mockedPublish = vi.mocked(sseBroadcaster.publish);

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(userId: string, username: string): string {
  return jwt.sign({ sub: userId, username, role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

/** Inserts a user row so JWT subjects exist as real principals. */
function ensureUser(userId: string, username: string): void {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users)
      .values({
        id: userId,
        username,
        passwordHash: "hash",
        displayName: username,
        role: "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

/** Habitat without a team — any authenticated human has access. */
function setupOpenHabitat(): string {
  return habitatRepo.createHabitat({ name: "Presence Open Habitat" }).id;
}

/** Team-gated habitat; `memberUserId` is a member, any other human is not. */
function setupGatedHabitat(memberUserId: string): { habitatId: string; teamId: string } {
  ensureUser(memberUserId, `member-${memberUserId}`);
  const org = orgRepo.createOrganization({ name: "Presence Org", slug: `presence-org-${uuid()}` });
  const team = teamRepo.createTeam({
    organizationId: org.id,
    name: "Presence Team",
    slug: `presence-team-${uuid()}`,
  });
  const habitat = habitatRepo.createHabitat({ name: "Presence Gated Habitat", teamId: team.id });
  teamMemberRepo.addMember({ teamId: team.id, userId: memberUserId, role: "member" });
  return { habitatId: habitat.id, teamId: team.id };
}

async function buildPresenceApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(presenceRoutes, { prefix: "/sse" });
  await app.ready();
  return app;
}

/** Mirrors production: sharedInviteRoutes is registered under both API prefixes. */
async function buildInviteApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sharedInviteRoutes, { prefix: "/api/v1" });
  await app.register(sharedInviteRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("Presence containment — authentication", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    mockedPublish.mockClear();
    resetPresenceForTesting();
    app = await buildPresenceApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    app = null;
  });

  it("rejects anonymous join with 401", async () => {
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      payload: { sessionId: "sess-anon", habitatId },
    });
    expect(res.statusCode).toBe(401);
    expect(getHabitatPresence(habitatId)).toHaveLength(0);
  });

  it("rejects anonymous heartbeat with 401", async () => {
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/heartbeat",
      payload: { sessionId: "sess-anon", habitatId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects anonymous leave with 401", async () => {
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/leave",
      payload: { sessionId: "sess-anon", habitatId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects anonymous viewer list with 401", async () => {
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "GET",
      url: `/sse/presence/viewers/${habitatId}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("Presence containment — Habitat access", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    mockedPublish.mockClear();
    resetPresenceForTesting();
    app = await buildPresenceApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    app = null;
  });

  it("rejects join from an authenticated human without Habitat access", async () => {
    ensureUser("stranger-1", "stranger");
    const { habitatId } = setupGatedHabitat("member-1");
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken("stranger-1", "stranger")}` },
      payload: { sessionId: "sess-stranger", habitatId },
    });
    expect(res.statusCode).toBe(403);
    expect(getHabitatPresence(habitatId)).toHaveLength(0);
  });

  it("rejects heartbeat from a non-member even for an existing session", async () => {
    ensureUser("member-1", "member");
    ensureUser("stranger-1", "stranger");
    const { habitatId } = setupGatedHabitat("member-1");
    const joinRes = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken("member-1", "member")}` },
      payload: { sessionId: "sess-member", habitatId },
    });
    expect(joinRes.statusCode).toBe(200);

    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/heartbeat",
      headers: { authorization: `Bearer ${makeToken("stranger-1", "stranger")}` },
      payload: { sessionId: "sess-member", habitatId, viewingTaskId: "task-evil" },
    });
    expect(res.statusCode).toBe(403);
    expect(getHabitatPresence(habitatId)[0]?.viewingTaskId).toBeNull();
  });

  it("rejects leave from a non-member", async () => {
    ensureUser("member-1", "member");
    ensureUser("stranger-1", "stranger");
    const { habitatId } = setupGatedHabitat("member-1");
    await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken("member-1", "member")}` },
      payload: { sessionId: "sess-member", habitatId },
    });

    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/leave",
      headers: { authorization: `Bearer ${makeToken("stranger-1", "stranger")}` },
      payload: { sessionId: "sess-member", habitatId },
    });
    expect(res.statusCode).toBe(403);
    expect(getHabitatPresence(habitatId)).toHaveLength(1);
  });

  it("rejects viewer-list reads from a non-member", async () => {
    ensureUser("member-1", "member");
    ensureUser("stranger-1", "stranger");
    const { habitatId } = setupGatedHabitat("member-1");
    const res = await app!.inject({
      method: "GET",
      url: `/sse/presence/viewers/${habitatId}`,
      headers: { authorization: `Bearer ${makeToken("stranger-1", "stranger")}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for join against a nonexistent Habitat", async () => {
    ensureUser("human-1", "alice");
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken("human-1", "alice")}` },
      payload: { sessionId: "sess-1", habitatId: uuid() },
    });
    expect(res.statusCode).toBe(404);
  });

  it("allows a team member to join and read viewers", async () => {
    ensureUser("member-1", "member");
    const { habitatId } = setupGatedHabitat("member-1");
    const joinRes = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken("member-1", "member")}` },
      payload: { sessionId: "sess-member", habitatId },
    });
    expect(joinRes.statusCode).toBe(200);

    const viewRes = await app!.inject({
      method: "GET",
      url: `/sse/presence/viewers/${habitatId}`,
      headers: { authorization: `Bearer ${makeToken("member-1", "member")}` },
    });
    expect(viewRes.statusCode).toBe(200);
    const body = JSON.parse(viewRes.body);
    expect(body.viewers).toHaveLength(1);
    expect(body.viewers[0].sessionId).toBe("sess-member");
  });
});

describe("Presence containment — identity is server-derived", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    mockedPublish.mockClear();
    resetPresenceForTesting();
    app = await buildPresenceApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    app = null;
  });

  it("rejects a join carrying forged identity fields", async () => {
    ensureUser("human-1", "alice");
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken("human-1", "alice")}` },
      payload: {
        sessionId: "sess-1",
        habitatId,
        type: "agent",
        userId: "forged-user",
        userName: "Mallory",
        agentId: "forged-agent",
        agentName: "EvilBot",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(getHabitatPresence(habitatId)).toHaveLength(0);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("rejects a heartbeat carrying forged identity fields", async () => {
    ensureUser("human-1", "alice");
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/heartbeat",
      headers: { authorization: `Bearer ${makeToken("human-1", "alice")}` },
      payload: { sessionId: "sess-1", habitatId, userId: "forged-user" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("derives stored identity from request.user only", async () => {
    ensureUser("human-1", "alice");
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken("human-1", "alice")}` },
      payload: { sessionId: "sess-1", habitatId },
    });
    expect(res.statusCode).toBe(200);

    const [entry] = getHabitatPresence(habitatId);
    expect(entry.type).toBe("human");
    expect(entry.userId).toBe("human-1");
    expect(entry.userName).toBe("alice");

    // The broadcast presence event carries the derived identity, not a caller-authored one.
    const joined = mockedPublish.mock.calls.find(
      ([, event]) => (event as { type?: string }).type === "presence.joined",
    );
    expect(joined).toBeDefined();
    const presence = (joined![1] as { data: { presence: { userId?: string } } }).data.presence;
    expect(presence.userId).toBe("human-1");
  });
});

describe("Presence containment — session ownership binding", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    mockedPublish.mockClear();
    resetPresenceForTesting();
    app = await buildPresenceApp();
    ensureUser("human-1", "alice");
    ensureUser("human-2", "bob");
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    app = null;
  });

  async function joinAs(humanId: string, username: string, sessionId: string, habitatId: string) {
    return app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken(humanId, username)}` },
      payload: { sessionId, habitatId },
    });
  }

  it("lets a second authenticated human join the same Habitat with their own session", async () => {
    const habitatId = setupOpenHabitat();
    expect((await joinAs("human-1", "alice", "sess-alice", habitatId)).statusCode).toBe(200);
    expect((await joinAs("human-2", "bob", "sess-bob", habitatId)).statusCode).toBe(200);
    expect(getHabitatPresence(habitatId)).toHaveLength(2);
  });

  it("rejects a second human joining with the first human's sessionId", async () => {
    const habitatId = setupOpenHabitat();
    await joinAs("human-1", "alice", "sess-alice", habitatId);

    const res = await joinAs("human-2", "bob", "sess-alice", habitatId);
    expect(res.statusCode).toBe(403);
    expect(getHabitatPresence(habitatId)[0].userId).toBe("human-1");
  });

  it("blocks a second human from heartbeating or re-tasking the first human's session", async () => {
    const habitatId = setupOpenHabitat();
    await joinAs("human-1", "alice", "sess-alice", habitatId);
    mockedPublish.mockClear();

    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/heartbeat",
      headers: { authorization: `Bearer ${makeToken("human-2", "bob")}` },
      payload: { sessionId: "sess-alice", habitatId, viewingTaskId: "task-42" },
    });
    expect(res.statusCode).toBe(403);
    const [entry] = getHabitatPresence(habitatId);
    expect(entry.viewingTaskId).toBeNull();
    expect(entry.userId).toBe("human-1");
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("blocks a second human from leaving the first human's session without mutating state", async () => {
    const habitatId = setupOpenHabitat();
    await joinAs("human-1", "alice", "sess-alice", habitatId);
    mockedPublish.mockClear();

    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/leave",
      headers: { authorization: `Bearer ${makeToken("human-2", "bob")}` },
      payload: { sessionId: "sess-alice", habitatId },
    });
    expect(res.statusCode).toBe(403);
    expect(getHabitatPresence(habitatId)).toHaveLength(1);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("allows the owning human to heartbeat a task change and leave", async () => {
    const habitatId = setupOpenHabitat();
    await joinAs("human-1", "alice", "sess-alice", habitatId);

    const heartbeatRes = await app!.inject({
      method: "POST",
      url: "/sse/presence/heartbeat",
      headers: { authorization: `Bearer ${makeToken("human-1", "alice")}` },
      payload: { sessionId: "sess-alice", habitatId, viewingTaskId: "task-42" },
    });
    expect(heartbeatRes.statusCode).toBe(200);
    expect(getHabitatPresence(habitatId)[0].viewingTaskId).toBe("task-42");

    const leaveRes = await app!.inject({
      method: "POST",
      url: "/sse/presence/leave",
      headers: { authorization: `Bearer ${makeToken("human-1", "alice")}` },
      payload: { sessionId: "sess-alice", habitatId },
    });
    expect(leaveRes.statusCode).toBe(200);
    expect(getHabitatPresence(habitatId)).toHaveLength(0);
  });

  it("keeps heartbeat and leave no-ops for unknown sessions without emitting events", async () => {
    ensureUser("human-1", "alice");
    const habitatId = setupOpenHabitat();
    mockedPublish.mockClear();

    const heartbeatRes = await app!.inject({
      method: "POST",
      url: "/sse/presence/heartbeat",
      headers: { authorization: `Bearer ${makeToken("human-1", "alice")}` },
      payload: { sessionId: "sess-ghost", habitatId },
    });
    expect(heartbeatRes.statusCode).toBe(200);

    const leaveRes = await app!.inject({
      method: "POST",
      url: "/sse/presence/leave",
      headers: { authorization: `Bearer ${makeToken("human-1", "alice")}` },
      payload: { sessionId: "sess-ghost", habitatId },
    });
    expect(leaveRes.statusCode).toBe(200);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("expires an abruptly-closed session through the existing 120-second cleanup", async () => {
    const habitatId = setupOpenHabitat();
    ensureUser("human-1", "alice");
    await joinAs("human-1", "alice", "sess-abrupt", habitatId);
    expect(getHabitatPresence(habitatId)).toHaveLength(1);

    // A fresh entry must survive the 120-second window...
    expect(cleanupStalePresence()).toBe(0);
    expect(getHabitatPresence(habitatId)).toHaveLength(1);

    // ...and expire past it. No awaits under fake timers: only jump the clock.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 130_000);
      expect(cleanupStalePresence()).toBe(1);
      expect(getHabitatPresence(habitatId)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Presence containment — human-only authentication policy", () => {
  let app: FastifyInstance | null = null;
  let agentKey: string;

  beforeEach(async () => {
    await initTestDb();
    mockedPublish.mockClear();
    resetPresenceForTesting();
    app = await buildPresenceApp();
    // A real, valid agent credential. humanAuth must reject it: Presence is
    // human-only. (If humanAuth were removed, the agent principal would pass
    // checkHabitatAccess's agent branch and the route would return 200.)
    const { plainApiKey } = agentService.createAgent({
      name: "Presence Probe Agent",
      type: "codex",
      domain: "testing",
    });
    agentKey = plainApiKey;
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    app = null;
  });

  it("rejects agent credentials on join", async () => {
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { "x-agent-api-key": agentKey },
      payload: { sessionId: "sess-agent", habitatId },
    });
    expect(res.statusCode).toBe(401);
    expect(getHabitatPresence(habitatId)).toHaveLength(0);
  });

  it("rejects agent credentials on heartbeat", async () => {
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/heartbeat",
      headers: { "x-agent-api-key": agentKey },
      payload: { sessionId: "sess-agent", habitatId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects agent credentials on leave", async () => {
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/leave",
      headers: { "x-agent-api-key": agentKey },
      payload: { sessionId: "sess-agent", habitatId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects agent credentials on the viewer list", async () => {
    const habitatId = setupOpenHabitat();
    const res = await app!.inject({
      method: "GET",
      url: `/sse/presence/viewers/${habitatId}`,
      headers: { "x-agent-api-key": agentKey },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("Presence containment — Habitat access revalidation for the session owner", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    mockedPublish.mockClear();
    resetPresenceForTesting();
    app = await buildPresenceApp();
    ensureUser("owner-1", "owner");
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    app = null;
  });

  /** Joins as the owner while they are still a member, then revokes membership. */
  async function joinThenRevokeOwner(habitatId: string, teamId: string): Promise<void> {
    const joinRes = await app!.inject({
      method: "POST",
      url: "/sse/presence/join",
      headers: { authorization: `Bearer ${makeToken("owner-1", "owner")}` },
      payload: { sessionId: "sess-owner", habitatId },
    });
    expect(joinRes.statusCode).toBe(200);
    expect(getHabitatPresence(habitatId)).toHaveLength(1);

    teamMemberRepo.removeMember(teamId, "owner-1");
  }

  it("blocks the owner's heartbeat after their membership is revoked (ownership still satisfied)", async () => {
    const { habitatId, teamId } = setupGatedHabitat("owner-1");
    await joinThenRevokeOwner(habitatId, teamId);
    mockedPublish.mockClear();

    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/heartbeat",
      headers: { authorization: `Bearer ${makeToken("owner-1", "owner")}` },
      payload: { sessionId: "sess-owner", habitatId, viewingTaskId: "task-late" },
    });
    expect(res.statusCode).toBe(403);
    const [entry] = getHabitatPresence(habitatId);
    expect(entry.viewingTaskId).toBeNull();
    expect(entry.userId).toBe("owner-1");
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("blocks the owner's leave after their membership is revoked (session survives)", async () => {
    const { habitatId, teamId } = setupGatedHabitat("owner-1");
    await joinThenRevokeOwner(habitatId, teamId);
    mockedPublish.mockClear();

    const res = await app!.inject({
      method: "POST",
      url: "/sse/presence/leave",
      headers: { authorization: `Bearer ${makeToken("owner-1", "owner")}` },
      payload: { sessionId: "sess-owner", habitatId },
    });
    expect(res.statusCode).toBe(403);
    expect(getHabitatPresence(habitatId)).toHaveLength(1);
    expect(mockedPublish).not.toHaveBeenCalled();
  });
});

describe("Provider invite containment — closed acceptance surface", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    app = await buildInviteApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    app = null;
  });

  function setupPendingProviderInvite(habitatId: string): string {
    const provider = providerService.configureProvider({
      habitatId,
      kind: "github",
      name: "GitHub",
      clientId: "gh-client",
      clientSecret: "gh-secret",
      enabled: true,
    });
    const invite = inviteService.createProviderInvite({
      habitatId,
      providerId: provider.id,
      baselineStanding: "remote_contributor",
      invitedBy: "admin-1",
    });
    return invite.id;
  }

  it("returns 404 for POST /api/v1/shared/invites/accept-provider and writes nothing", async () => {
    const habitatId = habitatRepo.createHabitat({ name: "Provider Containment Habitat" }).id;
    const inviteId = setupPendingProviderInvite(habitatId);

    const res = await app!.inject({
      method: "POST",
      url: "/api/v1/shared/invites/accept-provider",
      payload: {
        inviteId,
        podName: "Attacker Pod",
        participantDisplayName: "Attacker",
      },
    });
    expect(res.statusCode).toBe(404);

    const invite = inviteService.getInviteById(habitatId, inviteId);
    expect(invite.status).toBe("pending");
    expect(podRepo.getRemotePodsByHabitat(habitatId)).toHaveLength(0);
  });

  it("returns 404 for POST /api/shared/invites/accept-provider (deprecated prefix) and writes nothing", async () => {
    const habitatId = habitatRepo.createHabitat({ name: "Provider Containment Habitat 2" }).id;
    const inviteId = setupPendingProviderInvite(habitatId);

    const res = await app!.inject({
      method: "POST",
      url: "/api/shared/invites/accept-provider",
      payload: {
        inviteId,
        podName: "Attacker Pod",
        participantDisplayName: "Attacker",
      },
    });
    expect(res.statusCode).toBe(404);

    expect(inviteService.getInviteById(habitatId, inviteId).status).toBe("pending");
    expect(podRepo.getRemotePodsByHabitat(habitatId)).toHaveLength(0);
  });

  it("still accepts manual invites via the token route", async () => {
    const habitatId = habitatRepo.createHabitat({ name: "Manual Invite Habitat" }).id;
    const { oneTimeToken } = inviteService.createManualInvite({
      habitatId,
      baselineStanding: "remote_contributor",
      invitedBy: "admin-1",
    });

    const res = await app!.inject({
      method: "POST",
      url: "/api/v1/shared/invites/accept",
      headers: { "x-orcy-invite-token": oneTimeToken },
      payload: { podName: "Manual Pod", participantDisplayName: "Manual Admin" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.invite.status).toBe("accepted");
    expect(body.remotePod.name).toBe("Manual Pod");
  });
});
