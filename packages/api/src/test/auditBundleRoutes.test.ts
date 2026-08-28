import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditBundleRoutes } from "../routes/auditBundle.js";
import { isAppError } from "../errors.js";

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  handler: any;
  authPolicy: any;
}

const { mockGetTaskAuditBundle, mockGetMissionAuditBundle } = vi.hoisted(() => ({
  mockGetTaskAuditBundle: vi.fn(),
  mockGetMissionAuditBundle: vi.fn(),
}));

const { mockAgentOrHumanAuth } = vi.hoisted(() => ({ mockAgentOrHumanAuth: vi.fn() }));
const { mockGetHabitatById, mockIsTeamMemberByHabitatId } = vi.hoisted(() => ({
  mockGetHabitatById: vi.fn<() => any>(() => ({ id: "habitat-1", teamId: null })),
  mockIsTeamMemberByHabitatId: vi.fn(() => false),
}));

vi.mock("../services/auditBundleService.js", () => ({
  getTaskAuditBundle: mockGetTaskAuditBundle,
  getMissionAuditBundle: mockGetMissionAuditBundle,
}));
vi.mock("../middleware/auth.js", () => ({
  humanAuth: async () => {},
  agentAuth: async () => {},
  registrationAuth: async () => {},
  agentOrHumanAuth: mockAgentOrHumanAuth,
}));
vi.mock("../repositories/habitat.js", () => ({ getHabitatById: mockGetHabitatById }));
vi.mock("../repositories/teamMember.js", () => ({
  isTeamMemberByHabitatId: mockIsTeamMemberByHabitatId,
}));

async function captureRoutes(): Promise<CapturedRoute[]> {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    addHook: vi.fn(),
    withTypeProvider: () => fakeFastify,
    get: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "GET",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
        handler,
        authPolicy: opts?.config?.authPolicy,
      });
    }),
  };
  await auditBundleRoutes(fakeFastify);
  return routes;
}

describe("auditBundleRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHabitatById.mockReturnValue({ id: "habitat-1", teamId: null });
    mockIsTeamMemberByHabitatId.mockReturnValue(false);
    mockGetTaskAuditBundle.mockReturnValue({
      target: { habitatId: "habitat-1" },
      events: [],
      warnings: [],
      completenessSummary: {
        totalEvents: 0,
        byStatus: { complete: 0, legacy_partial: 0, source_unavailable: 0 },
        caveats: [],
      },
    });
    mockGetMissionAuditBundle.mockReturnValue({
      target: { habitatId: "habitat-1" },
      directMissionEvidence: [],
      rolledUpTaskEvidence: [],
      warnings: [],
      completenessSummary: {
        totalEvents: 0,
        byStatus: { complete: 0, legacy_partial: 0, source_unavailable: 0 },
        caveats: [],
      },
    });
  });

  it("registers entity-scoped bundle routes with agent or human auth", async () => {
    const routes = await captureRoutes();

    expect(routes.map((route) => route.path)).toEqual([
      "/tasks/:taskId/audit/bundle",
      "/missions/:missionId/audit/bundle",
    ]);
    for (const route of routes) {
      // Authentication installs from the declared local_actor policy; the
      // captured route-level chain holds only the policy declaration.
      expect(route.authPolicy).toBe("local_actor");
    }
  });

  it("denies human users without team habitat membership", async () => {
    mockGetHabitatById.mockReturnValue({ id: "habitat-1", teamId: "team-1" });
    const routes = await captureRoutes();
    const route = routes.find((candidate) => candidate.path === "/tasks/:taskId/audit/bundle")!;

    try {
      await route.handler(
        { params: { taskId: "task-1" }, query: {}, user: { id: "stranger" } },
        {} as any,
      );
      throw new Error("Expected route to reject");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.statusCode).toBe(403);
    }
  });
});
