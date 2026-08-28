import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SSE contract test for habitat write paths that bypass the main
 * PATCH /habitats/:id route.
 *
 * Verifies that PATCH /habitats/:id/roadmap-focus and
 * PUT /habitats/:id/rules each publish a `habitat.updated` SSE event.
 *
 * Provable: if the SSE broadcast is removed from either path, the
 * `publishCalls` assertion fails.
 */

// --- SSE capture ---
const publishCalls: { type: string; data: unknown }[] = [];

// --- Mock habitat data (raw shape — server-side, pre-mask) ---
const mockHabitat = {
  id: "h-1",
  name: "Test Habitat",
  description: "",
  teamId: null,
  retrySettings: null,
  anomalySettings: null,
  autoAssignSettings: null,
  codeReviewSettings: {
    autoApproveOnMerge: false,
    githubSecret: "ghs_secret",
    gitlabSecret: null,
    taskPattern: "",
  },
  ciCdSettings: { githubSecret: null, gitlabSecret: null, taskPattern: "" },
  gitWorktreeSettings: null,
  prioritizationSettings: null,
  automationSettings: null,
  remoteGovernanceSettings: null,
  wikiSettings: null,
  triageSettings: null,
  releaseSettings: null,
  roadmapSettings: null,
  eventRetentionDays: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const mockUpdated = { ...mockHabitat, updatedAt: "2024-01-02T00:00:00Z" };

// --- Module mocks ---
vi.mock("../repositories/habitat.js", () => ({
  getHabitatById: vi.fn(() => mockHabitat),
  updateHabitat: vi.fn(() => mockUpdated),
  listHabitats: vi.fn(() => []),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: {
    publish: (_habitatId: string, evt: { type: string; data: unknown }) => publishCalls.push(evt),
  },
}));

vi.mock("../services/habitatSecretCache.js", () => ({ rebuildCache: vi.fn() }));
vi.mock("../middleware/auth.js", () => ({
  humanAuth: vi.fn(),
  agentOrHumanAuth: vi.fn(),
  agentAuth: vi.fn(),
  registrationAuth: vi.fn(),
}));
vi.mock("../middleware/team.js", () => ({ requireHabitatAccess: vi.fn() }));
vi.mock("../repositories/teamMember.js", () => ({
  isTeamMemberByHabitatId: vi.fn(() => true),
}));

// Mock prioritizationService so the rules PUT handler can resolve defaults.
vi.mock("../services/prioritizationService.js", () => ({
  getDefaultPrioritizationSettings: vi.fn(() => ({
    enabled: false,
    evaluateIntervalMinutes: 60,
    rules: [],
    fallbackToManual: true,
  })),
  getPrioritizationRules: vi.fn(() => null),
  applyPrioritization: vi.fn(() => ({ applied: 0 })),
}));

// Mock repos that habitatService transitively imports (so it loads cleanly).
vi.mock("../repositories/column.js", () => ({
  createColumn: vi.fn(),
  getColumnsByHabitatId: vi.fn(() => []),
  reorderColumns: vi.fn(),
}));
vi.mock("../repositories/task.js", () => ({
  getTasksByHabitatId: vi.fn(() => ({ tasks: [], total: 0 })),
}));
vi.mock("../repositories/mission.js", () => ({
  getMissionsByHabitatId: vi.fn(() => []),
}));
vi.mock("../repositories/comment.js", () => ({ getTaskComments: vi.fn(() => []) }));
vi.mock("../repositories/template.js", () => ({
  seedGlobalTemplates: vi.fn(),
  getTemplates: vi.fn(() => []),
}));
vi.mock("../repositories/event.js", () => ({ createEvent: vi.fn() }));
vi.mock("../repositories/savedFilter.js", () => ({ createSavedFilter: vi.fn() }));
vi.mock("../repositories/release.js", () => ({ getRecentReleases: vi.fn(() => []) }));
vi.mock("../repositories/habitatSkill.js", () => ({ getHabitatSkill: vi.fn() }));

// --- Route capture ---
interface CapturedRoute {
  method: string;
  path: string;
  handler: (
    req: { params: unknown; body: unknown; query: unknown; agent?: unknown; user?: unknown },
    reply: unknown,
  ) => unknown;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fake: any = {
    addHook: vi.fn(),
    withTypeProvider: () => routes,
    register: vi.fn(),
    get: (path: string, _opts: unknown, handler: CapturedRoute["handler"]) =>
      routes.push({ method: "GET", path, handler }),
    post: (path: string, _opts: unknown, handler: CapturedRoute["handler"]) =>
      routes.push({ method: "POST", path, handler }),
    put: (path: string, _opts: unknown, handler: CapturedRoute["handler"]) =>
      routes.push({ method: "PUT", path, handler }),
    patch: (path: string, _opts: unknown, handler: CapturedRoute["handler"]) =>
      routes.push({ method: "PATCH", path, handler }),
    delete: (path: string, _opts: unknown, handler: CapturedRoute["handler"]) =>
      routes.push({ method: "DELETE", path, handler }),
  };
  // Augment the array with Fastify methods so route modules can call them directly.
  Object.assign(routes, fake);
  return routes;
}

beforeEach(() => {
  publishCalls.length = 0;
});

describe("SSE contract — habitat.updated on bypassed write paths", () => {
  it("PATCH /habitats/:habitatId/roadmap-focus publishes habitat.updated", async () => {
    const routes = captureRoutes();
    const { roadmapRoutes } = await import("../routes/roadmap.js");
    await roadmapRoutes(routes as unknown as Parameters<typeof roadmapRoutes>[0]);

    const route = routes.find(
      (r) => r.method === "PATCH" && r.path === "/habitats/:habitatId/roadmap-focus",
    );
    expect(route).toBeDefined();

    await route!.handler(
      {
        params: { habitatId: "h-1" },
        body: { focusMissionId: "m-1" },
        query: {},
        agent: { id: "agent-1" },
      },
      {},
    );

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].type).toBe("habitat.updated");
    expect(publishCalls[0].data).toHaveProperty(["codeReviewSettings", "hasGithubSecret"]);
    expect(publishCalls[0].data).not.toHaveProperty(["codeReviewSettings", "githubSecret"]);
  });

  it("PUT /habitats/:habitatId/rules publishes habitat.updated", async () => {
    const routes = captureRoutes();
    const { prioritizationRoutes } = await import("../routes/prioritization.js");
    await prioritizationRoutes(routes as unknown as Parameters<typeof prioritizationRoutes>[0]);

    const route = routes.find((r) => r.method === "PUT" && r.path === "/habitats/:habitatId/rules");
    expect(route).toBeDefined();

    const reply = {
      status: vi.fn(() => ({ send: vi.fn() })),
    };

    await route!.handler(
      {
        params: { habitatId: "h-1" },
        body: { enabled: true, fallbackToManual: true },
        query: {},
      },
      reply,
    );

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].type).toBe("habitat.updated");
    expect(publishCalls[0].data).toHaveProperty(["codeReviewSettings", "hasGithubSecret"]);
    expect(publishCalls[0].data).not.toHaveProperty(["codeReviewSettings", "githubSecret"]);
  });
});
