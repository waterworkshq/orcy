import { describe, it, expect, vi, beforeEach } from "vitest";
import { auditExportRoutes } from "../routes/auditExport.js";
import { isAppError } from "../errors.js";

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  handler: any;
}

const {
  mockStreamAuditExport,
  mockGetCanonicalAuditEvents,
  mockGetAuditSummary,
  mockCreateSchedule,
  mockListSchedules,
  mockDeleteSchedule,
  mockGetScheduleById,
} = vi.hoisted(() => ({
  mockStreamAuditExport: vi.fn(),
  mockGetCanonicalAuditEvents: vi.fn(() => ({
    events: [],
    warnings: [],
    completenessSummary: {
      totalEvents: 0,
      byStatus: { complete: 0, legacy_partial: 0, source_unavailable: 0 },
      caveats: [],
    },
  })),
  mockGetAuditSummary: vi.fn(() => ({
    totalEvents: 0,
    byAction: {},
    byActorType: {},
    byDay: [],
    topMissions: [],
    warnings: [],
    completenessSummary: {
      totalEvents: 0,
      byStatus: { complete: 0, legacy_partial: 0, source_unavailable: 0 },
      caveats: [],
    },
  })),
  mockCreateSchedule: vi.fn(() => ({ id: "schedule-1", habitatId: "habitat-1" })),
  mockListSchedules: vi.fn(() => []),
  mockDeleteSchedule: vi.fn(() => true),
  mockGetScheduleById: vi.fn(() => ({ id: "schedule-1", habitatId: "habitat-1" })),
}));

const { mockHumanAuth, mockRequireHabitatAccess } = vi.hoisted(() => ({
  mockHumanAuth: vi.fn(),
  mockRequireHabitatAccess: vi.fn(),
}));

const { mockGetHabitatById, mockIsTeamMemberByHabitatId } = vi.hoisted(() => ({
  mockGetHabitatById: vi.fn<() => any>(() => ({ id: "habitat-1", teamId: null })),
  mockIsTeamMemberByHabitatId: vi.fn(() => false),
}));

vi.mock("../services/auditExportService.js", () => ({
  streamAuditExport: mockStreamAuditExport,
  getCanonicalAuditEvents: mockGetCanonicalAuditEvents,
  getAuditSummary: mockGetAuditSummary,
  createSchedule: mockCreateSchedule,
  listSchedules: mockListSchedules,
  deleteSchedule: mockDeleteSchedule,
  getScheduleById: mockGetScheduleById,
}));

vi.mock("../middleware/auth.js", () => ({
  humanAuth: mockHumanAuth,
}));

vi.mock("../middleware/team.js", () => ({
  requireHabitatAccess: mockRequireHabitatAccess,
}));

vi.mock("../repositories/habitat.js", () => ({
  getHabitatById: mockGetHabitatById,
}));

vi.mock("../repositories/teamMember.js", () => ({
  isTeamMemberByHabitatId: mockIsTeamMemberByHabitatId,
}));

async function captureAuditExportRoutes(): Promise<CapturedRoute[]> {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    get: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "GET",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
        handler,
      });
    }),
    post: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "POST",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
        handler,
      });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "DELETE",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
        handler,
      });
    }),
  };
  await auditExportRoutes(fakeFastify);
  return routes;
}

describe("auditExportRoutes auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetScheduleById.mockReturnValue({ id: "schedule-1", habitatId: "habitat-1" });
    mockGetHabitatById.mockReturnValue({ id: "habitat-1", teamId: null });
    mockIsTeamMemberByHabitatId.mockReturnValue(false);
  });

  it("requires human auth and habitat access on habitat-scoped audit routes", async () => {
    const { humanAuth } = await import("../middleware/auth.js");
    const { requireHabitatAccess } = await import("../middleware/team.js");
    const routes = await captureAuditExportRoutes();

    const habitatRoutes = routes.filter((route) =>
      route.path.startsWith("/habitats/:habitatId/audit/"),
    );
    expect(habitatRoutes).toHaveLength(5);
    for (const route of habitatRoutes) {
      expect(route.preHandler).toContain(humanAuth);
      expect(route.preHandler).toContain(requireHabitatAccess);
    }
  });

  it("authorizes schedule deletion against the schedule habitat", async () => {
    const { humanAuth } = await import("../middleware/auth.js");
    const routes = await captureAuditExportRoutes();
    const route = routes.find((r) => r.method === "DELETE" && r.path === "/audit/schedules/:id");
    expect(route).toBeDefined();
    expect(route!.preHandler).toHaveLength(2);
    expect(route!.preHandler[0]).toBe(humanAuth);

    await route!.preHandler[1](
      {
        params: { id: "schedule-1" },
        user: { id: "user-1", role: "viewer", type: "human" },
      } as any,
      {} as any,
    );

    expect(mockGetScheduleById).toHaveBeenCalledWith("schedule-1");
    expect(mockGetHabitatById).toHaveBeenCalledWith("habitat-1");
  });

  it("denies schedule deletion for non-members of a team habitat", async () => {
    mockGetHabitatById.mockReturnValue({ id: "habitat-1", teamId: "team-1" });
    mockIsTeamMemberByHabitatId.mockReturnValue(false);
    const routes = await captureAuditExportRoutes();
    const route = routes.find((r) => r.method === "DELETE" && r.path === "/audit/schedules/:id");

    try {
      await route!.preHandler[1](
        {
          params: { id: "schedule-1" },
          user: { id: "stranger", role: "viewer", type: "human" },
        } as any,
        {} as any,
      );
      throw new Error("Expected preHandler to reject");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.statusCode).toBe(403);
    }
  });

  it("accepts canonical export filters and forwards them to the service", async () => {
    const routes = await captureAuditExportRoutes();
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/habitats/:habitatId/audit/export",
    );

    await route!.handler(
      {
        params: { habitatId: "habitat-1" },
        query: {
          format: "json",
          entityType: "pipeline_event",
          source: "webhook",
          provider: "github",
          preset: "failed_pipelines",
          includeProvenance: "true",
          includeIntegrity: "true",
        },
      },
      {} as any,
    );

    expect(mockStreamAuditExport).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({
        format: "json",
        entityType: "pipeline_event",
        source: "webhook",
        provider: "github",
        preset: "failed_pipelines",
        includeProvenance: "true",
        includeIntegrity: "true",
      }),
      expect.anything(),
    );
  });

  it("returns canonical audit events with completeness summaries", async () => {
    const routes = await captureAuditExportRoutes();
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/habitats/:habitatId/audit/events",
    );

    const response = await route!.handler(
      {
        params: { habitatId: "habitat-1" },
        query: { entityType: "task", includeHealthSnapshots: "true" },
      },
      {} as any,
    );

    expect(mockGetCanonicalAuditEvents).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({ entityType: "task", includeHealthSnapshots: "true" }),
    );
    expect(response).toMatchObject({
      events: [],
      warnings: [],
      completenessSummary: { totalEvents: 0 },
    });
  });
});
