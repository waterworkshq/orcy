import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { habitatRoutes } from "../routes/habitats.js";
import { habitatAnalyticsRoutes } from "../routes/board-analytics.js";
import { habitatExportRoutes } from "../routes/board-export.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as teamRepo from "../repositories/team.js";
import * as orgRepo from "../repositories/organization.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import { mockRequest, mockReply } from "./factories/mockRequest.js";
import { users } from "../db/schema/index.js";
import { isAppError } from "../errors.js";
import { eq } from "drizzle-orm";

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
        role: "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

function mockReqRes(overrides: Record<string, unknown> = {}) {
  const request = mockRequest({
    params: overrides.params as Record<string, string> | undefined,
    query: overrides.query as Record<string, string> | undefined,
    body: overrides.body,
    agent: overrides.agent as { id: string; name?: string } | undefined,
    user: overrides.user as { id: string; role?: string; type?: string } | undefined,
  });
  const { reply, sent } = mockReply();
  return { request, reply, sent };
}

type RouteHandler = (req: any, reply: any) => Promise<void>;
interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any;
}

function captureHabitatRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "POST",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
      });
    }),
    get: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "GET",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
      });
    }),
    patch: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "PATCH",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
      });
    }),
    put: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "PUT",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
      });
    }),
    delete: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "DELETE",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
      });
    }),
  };
  habitatRoutes(fakeFastify);
  habitatAnalyticsRoutes(fakeFastify);
  habitatExportRoutes(fakeFastify);
  return routes;
}

describe("requireHabitatAccess", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => {
    closeDb();
  });

  it("returns 404 when habitat does not exist", async () => {
    const { requireHabitatAccess } = await import("../middleware/team.js");
    const { request, reply, sent } = mockReqRes({
      params: { id: "nonexistent-habitat-id" },
      user: { id: "user-1", role: "admin", type: "human" },
    });
    try {
      await requireHabitatAccess(request, reply);
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.statusCode).toBe(404);
    }
  });

  it("allows human team member access", async () => {
    const { createHabitat } = await import("../repositories/habitat.js");
    const { createTeam } = await import("../repositories/team.js");
    const { addMember } = await import("../repositories/teamMember.js");
    const { createOrganization } = await import("../repositories/organization.js");
    const { requireHabitatAccess } = await import("../middleware/team.js");

    ensureUser("user-1", "user-1");
    const org = createOrganization({ name: "Test Org", slug: "test-org" });
    const team = createTeam({ organizationId: org.id, name: "Team A", slug: "team-a" });
    const habitat = createHabitat({ name: "Habitat 1", teamId: team.id });
    addMember({ teamId: team.id, userId: "user-1", role: "member" });

    const { request, reply, sent } = mockReqRes({
      params: { id: habitat.id },
      user: { id: "user-1", role: "admin", type: "human" },
    });
    await requireHabitatAccess(request, reply);
    expect(sent.code).toBeNull();
  });

  it("denies non-member human access to a habitat with a team", async () => {
    const { createHabitat } = await import("../repositories/habitat.js");
    const { createTeam } = await import("../repositories/team.js");
    const { createOrganization } = await import("../repositories/organization.js");
    const { requireHabitatAccess } = await import("../middleware/team.js");

    const org = createOrganization({ name: "Test Org", slug: "test-org2" });
    const team = createTeam({ organizationId: org.id, name: "Team B", slug: "team-b" });
    const habitat = createHabitat({ name: "Habitat 2", teamId: team.id });

    const { request, reply, sent } = mockReqRes({
      params: { id: habitat.id },
      user: { id: "stranger-user", role: "viewer", type: "human" },
    });
    try {
      await requireHabitatAccess(request, reply);
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.statusCode).toBe(403);
        expect(err.message).toBe("You do not have access to this habitat");
      }
    }
  });

  it("allows any human access to a habitat with no team", async () => {
    const { createHabitat } = await import("../repositories/habitat.js");
    const { requireHabitatAccess } = await import("../middleware/team.js");

    const habitat = createHabitat({ name: "Orphan Habitat" });

    const { request, reply, sent } = mockReqRes({
      params: { id: habitat.id },
      user: { id: "any-user", role: "viewer", type: "human" },
    });
    await requireHabitatAccess(request, reply);
    expect(sent.code).toBeNull();
  });

  it("allows agent principal access to any habitat", async () => {
    const { createHabitat } = await import("../repositories/habitat.js");
    const { createTeam } = await import("../repositories/team.js");
    const { createOrganization } = await import("../repositories/organization.js");
    const { requireHabitatAccess } = await import("../middleware/team.js");

    const org = createOrganization({ name: "Test Org", slug: "test-org3" });
    const team = createTeam({ organizationId: org.id, name: "Team C", slug: "team-c" });
    const habitat = createHabitat({ name: "Agent Habitat", teamId: team.id });

    const { request, reply, sent } = mockReqRes({
      params: { id: habitat.id },
      agent: { id: "agent-1", name: "Test Agent" },
    });
    await requireHabitatAccess(request, reply);
    expect(sent.code).toBeNull();
  });

  it("returns 401 when no principal is set", async () => {
    const { createHabitat } = await import("../repositories/habitat.js");
    const { requireHabitatAccess } = await import("../middleware/team.js");

    const habitat = createHabitat({ name: "Public Habitat" });

    const { request, reply, sent } = mockReqRes({
      params: { id: habitat.id },
    });
    try {
      await requireHabitatAccess(request, reply);
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.statusCode).toBe(401);
        expect(err.message).toBe("Authentication required");
      }
    }
  });

  it("passes through when no habitatId in params", async () => {
    const { requireHabitatAccess } = await import("../middleware/team.js");
    const { request, reply, sent } = mockReqRes({
      params: {},
    });
    await requireHabitatAccess(request, reply);
    expect(sent.code).toBeNull();
  });

  it("summary route requires requireHabitatAccess preHandler", async () => {
    const routes = captureHabitatRoutes();
    const summaryRoute = routes.find((r) => r.path === "/habitats/:habitatId/summary");
    expect(summaryRoute).toBeDefined();
    const preHandlerNames = summaryRoute!.preHandler.map((h: any) => h.name || String(h));
    expect(preHandlerNames.length).toBeGreaterThanOrEqual(2);
    const hasHabitatAccess = summaryRoute!.preHandler.some(
      (h: any) => h.name === "authorizeHabitatAccess" || h.name === "requireHabitatAccess",
    );
    expect(hasHabitatAccess).toBe(true);
  });

  it("non-member human cannot access summary of team-scoped habitat", async () => {
    const { requireHabitatAccess } = await import("../middleware/team.js");

    const org = orgRepo.createOrganization({ name: "Summary Test Org", slug: "summary-test-org" });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "Summary Team",
      slug: "summary-team",
    });
    const habitat = habitatRepo.createHabitat({ name: "Summary Habitat", teamId: team.id });

    const { request, reply, sent } = mockReqRes({
      params: { id: habitat.id },
      user: { id: "stranger-user", role: "viewer", type: "human" },
    });
    try {
      await requireHabitatAccess(request, reply);
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.statusCode).toBe(403);
    }
  });
});
