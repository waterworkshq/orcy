import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  taskCodeEvidenceRoutes,
  missionCodeEvidenceRoutes,
  repositorySettingsRoutes,
} from "../routes/codeEvidence.js";

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  handler: any;
}

function captureRoutes(...registerFns: Array<(fastify: any) => Promise<void>>): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: () => fakeFastify,
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
    put: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "PUT",
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
  for (const fn of registerFns) fn(fakeFastify);
  return routes;
}

function createMockRequest(overrides: Record<string, any> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    agent: { id: "agent-1" },
    user: null,
    ...overrides,
  };
}

function createMockReply() {
  const reply: any = { statusCode: 200 };
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((data: any) => {
    reply.data = data;
    return reply;
  });
  reply.code = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  return reply;
}

const mockTask = { id: "task-1", missionId: "mission-1", title: "Test Task" };
const mockMission = { id: "mission-1", habitatId: "habitat-1", title: "Test Mission" };
const mockHabitat = { id: "habitat-1", name: "Test Habitat" };
const mockEvidenceResult = {
  links: [{ linkId: "link-1", status: "active" }],
  completeness: { percentage: 80 },
};
const mockCorrectedLink = { linkId: "link-1", status: "corrected" };
const mockCompleteness = { percentage: 0, hasNotApplicable: true, reasonCode: "no-code" };
const mockGap = { id: "gap-1", taskId: "task-1", reasonCode: "missing-tests", status: "open" };
const mockResolvedGap = { id: "gap-1", taskId: "task-1", status: "resolved" };
const mockRepository = {
  id: "repo-1",
  habitatId: "habitat-1",
  provider: "github",
  repoSlug: "org/repo",
};

const {
  mockGetTaskCodeEvidence,
  mockLinkTaskCodeEvidence,
  mockGetMissionCodeEvidence,
  mockLinkMissionCodeEvidence,
  mockCorrectEvidenceLink,
  mockMarkCodeEvidenceNotApplicable,
  mockClearCodeEvidenceNotApplicable,
  mockReportCodeEvidenceGap,
  mockResolveCodeEvidenceGap,
} = vi.hoisted(() => ({
  mockGetTaskCodeEvidence: vi.fn(),
  mockLinkTaskCodeEvidence: vi.fn(),
  mockGetMissionCodeEvidence: vi.fn(),
  mockLinkMissionCodeEvidence: vi.fn(),
  mockCorrectEvidenceLink: vi.fn(),
  mockMarkCodeEvidenceNotApplicable: vi.fn(),
  mockClearCodeEvidenceNotApplicable: vi.fn(),
  mockReportCodeEvidenceGap: vi.fn(),
  mockResolveCodeEvidenceGap: vi.fn(),
}));

const { mockGetTaskById, mockGetHabitatIdForTask } = vi.hoisted(() => ({
  mockGetTaskById: vi.fn(),
  mockGetHabitatIdForTask: vi.fn(),
}));

const { mockGetMissionById } = vi.hoisted(() => ({
  mockGetMissionById: vi.fn(),
}));

const { mockGetHabitatById } = vi.hoisted(() => ({
  mockGetHabitatById: vi.fn(),
}));

const { mockGetByHabitatId, mockCreateRepo, mockUpdateByHabitatId } = vi.hoisted(() => ({
  mockGetByHabitatId: vi.fn(),
  mockCreateRepo: vi.fn(),
  mockUpdateByHabitatId: vi.fn(),
}));

const { mockListByHabitat } = vi.hoisted(() => ({
  mockListByHabitat: vi.fn(),
}));

const { mockAgentOrHumanAuth, mockHumanAuth, mockAgentAuth } = vi.hoisted(() => ({
  mockAgentOrHumanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
  mockHumanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
  mockAgentAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
}));

const { mockSsePublish } = vi.hoisted(() => ({
  mockSsePublish: vi.fn(),
}));

const { mockCreateEvent } = vi.hoisted(() => ({
  mockCreateEvent: vi.fn(),
}));

const { mockCreateMissionEvent } = vi.hoisted(() => ({
  mockCreateMissionEvent: vi.fn(),
}));

vi.mock("../services/codeEvidenceService.js", () => ({
  getTaskCodeEvidence: mockGetTaskCodeEvidence,
  linkTaskCodeEvidence: mockLinkTaskCodeEvidence,
  getMissionCodeEvidence: mockGetMissionCodeEvidence,
  linkMissionCodeEvidence: mockLinkMissionCodeEvidence,
  correctEvidenceLink: mockCorrectEvidenceLink,
  markCodeEvidenceNotApplicable: mockMarkCodeEvidenceNotApplicable,
  clearCodeEvidenceNotApplicable: mockClearCodeEvidenceNotApplicable,
  reportCodeEvidenceGap: mockReportCodeEvidenceGap,
  resolveCodeEvidenceGap: mockResolveCodeEvidenceGap,
}));

vi.mock("../repositories/task.js", () => ({
  getTaskById: mockGetTaskById,
  getHabitatIdForTask: mockGetHabitatIdForTask,
}));

vi.mock("../repositories/feature.js", () => ({
  getMissionById: mockGetMissionById,
}));

vi.mock("../repositories/habitat.js", () => ({
  getHabitatById: mockGetHabitatById,
}));

vi.mock("../repositories/codeEvidenceRepository.js", () => ({
  getByHabitatId: mockGetByHabitatId,
  create: mockCreateRepo,
  updateByHabitatId: mockUpdateByHabitatId,
}));

vi.mock("../repositories/integrationConnection.js", () => ({
  listByHabitat: mockListByHabitat,
}));

vi.mock("../middleware/auth.js", () => ({
  agentOrHumanAuth: mockAgentOrHumanAuth,
  humanAuth: mockHumanAuth,
  agentAuth: mockAgentAuth,
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: mockSsePublish },
}));

vi.mock("../repositories/events/event-crud.js", () => ({
  createEvent: mockCreateEvent,
}));

vi.mock("../repositories/events/event-feature.js", () => ({
  createMissionEvent: mockCreateMissionEvent,
}));

vi.mock("../errors.js", () => ({
  notFound: (msg: string) => new Error(msg),
  badRequest: (msg: string) => new Error(msg),
  forbidden: (msg: string) => new Error(msg),
}));

function resetMocks() {
  vi.clearAllMocks();
  mockGetTaskById.mockReturnValue(mockTask);
  mockGetMissionById.mockReturnValue(mockMission);
  mockGetHabitatById.mockReturnValue(mockHabitat);
  mockGetTaskCodeEvidence.mockReturnValue(mockEvidenceResult);
  mockLinkTaskCodeEvidence.mockReturnValue(mockEvidenceResult);
  mockGetMissionCodeEvidence.mockReturnValue(mockEvidenceResult);
  mockLinkMissionCodeEvidence.mockReturnValue(mockEvidenceResult);
  mockCorrectEvidenceLink.mockReturnValue(mockCorrectedLink);
  mockMarkCodeEvidenceNotApplicable.mockReturnValue(mockCompleteness);
  mockReportCodeEvidenceGap.mockReturnValue(mockGap);
  mockResolveCodeEvidenceGap.mockReturnValue(mockResolvedGap);
  mockGetByHabitatId.mockReturnValue(mockRepository);
  mockCreateRepo.mockReturnValue(mockRepository);
  mockUpdateByHabitatId.mockReturnValue(mockRepository);
}

describe("codeEvidence route registration", () => {
  it("registers all 18 endpoints across three route groups", () => {
    const routes = captureRoutes(
      taskCodeEvidenceRoutes,
      missionCodeEvidenceRoutes,
      repositorySettingsRoutes,
    );
    expect(routes).toHaveLength(18);
  });

  it("registers 7 task evidence routes", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    expect(routes).toHaveLength(7);
  });

  it("registers 7 mission evidence routes", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    expect(routes).toHaveLength(7);
  });

  it("registers 4 repository settings routes", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    expect(routes).toHaveLength(4);
  });

  it("registers GET /tasks/:taskId/code-evidence", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/tasks/:taskId/code-evidence",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /tasks/:taskId/code-evidence", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /tasks/:taskId/code-evidence/:linkId/correct", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/:linkId/correct",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /tasks/:taskId/code-evidence/not-applicable", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    expect(route).toBeDefined();
  });

  it("registers DELETE /tasks/:taskId/code-evidence/not-applicable", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "DELETE" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /tasks/:taskId/code-evidence/gaps", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /tasks/:taskId/code-evidence/gaps/:gapId/resolve", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    );
    expect(route).toBeDefined();
  });

  it("registers GET /missions/:missionId/code-evidence", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/missions/:missionId/code-evidence",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /missions/:missionId/code-evidence", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /missions/:missionId/code-evidence/:linkId/correct", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/:linkId/correct",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /missions/:missionId/code-evidence/not-applicable", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    expect(route).toBeDefined();
  });

  it("registers DELETE /missions/:missionId/code-evidence/not-applicable", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "DELETE" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /missions/:missionId/code-evidence/gaps", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /missions/:missionId/code-evidence/gaps/:gapId/resolve", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    );
    expect(route).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/repository", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/habitats/:habitatId/repository",
    );
    expect(route).toBeDefined();
  });

  it("registers PUT /habitats/:habitatId/repository", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "PUT" && r.path === "/habitats/:habitatId/repository",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /habitats/:habitatId/repository/infer-from-worktree", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    expect(route).toBeDefined();
  });

  it("registers POST /habitats/:habitatId/repository/infer-from-integration", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    expect(route).toBeDefined();
  });
});

describe("codeEvidence route preHandler (auth)", () => {
  it("task GET evidence uses agentOrHumanAuth", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/tasks/:taskId/code-evidence",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("task POST link evidence uses agentOrHumanAuth", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("task POST correct uses agentOrHumanAuth", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/:linkId/correct",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("task POST not-applicable uses agentOrHumanAuth", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("task DELETE not-applicable uses agentOrHumanAuth", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "DELETE" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("task POST gap uses agentOrHumanAuth", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("task POST resolve gap uses agentOrHumanAuth", () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("mission GET evidence uses agentOrHumanAuth", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/missions/:missionId/code-evidence",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("mission POST link evidence uses agentOrHumanAuth", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("mission POST correct uses agentOrHumanAuth", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/:linkId/correct",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("mission POST not-applicable uses agentOrHumanAuth", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("mission DELETE not-applicable uses agentOrHumanAuth", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "DELETE" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("mission POST gap uses agentOrHumanAuth", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("mission POST resolve gap uses agentOrHumanAuth", () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("repository GET uses agentOrHumanAuth", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/habitats/:habitatId/repository",
    );
    expect(route!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it("repository PUT uses humanAuth", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "PUT" && r.path === "/habitats/:habitatId/repository",
    );
    expect(route!.preHandler).toContain(mockHumanAuth);
  });

  it("repository infer-from-worktree uses humanAuth", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    expect(route!.preHandler).toContain(mockHumanAuth);
  });

  it("repository infer-from-integration uses humanAuth", () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    expect(route!.preHandler).toContain(mockHumanAuth);
  });
});

describe("GET /tasks/:taskId/code-evidence handler", () => {
  beforeEach(resetMocks);

  it("returns evidence for an existing task", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      query: { includeHistory: false },
    });
    const result = await route!.handler(req, createMockReply());
    expect(mockGetTaskById).toHaveBeenCalledWith("task-1");
    expect(mockGetTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ includeHistory: false }),
    );
    expect(result).toEqual(mockEvidenceResult);
  });

  it("passes includeHistory=true when requested", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      query: { includeHistory: true },
    });
    await route!.handler(req, createMockReply());
    expect(mockGetTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ includeHistory: true }),
    );
  });

  it("throws not found for missing task", async () => {
    mockGetTaskById.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({ params: { taskId: "missing" }, query: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Task not found");
  });

  it("passes includeHistory as undefined when not provided", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      query: {},
    });
    await route!.handler(req, createMockReply());
    expect(mockGetTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ includeHistory: undefined }),
    );
  });
});

describe("POST /tasks/:taskId/code-evidence handler", () => {
  beforeEach(resetMocks);

  it("links code evidence and returns result", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const body = {
      branch: { name: "feature/test", headSha: "abc123" },
      commits: [{ sha: "def456", message: "test commit" }],
      changedFiles: [{ path: "src/index.ts", changeType: "modified" }],
    };
    const req = createMockRequest({ params: { taskId: "task-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockGetTaskById).toHaveBeenCalledWith("task-1");
    expect(mockLinkTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      body,
      {
        type: "agent",
        id: "agent-1",
      },
      { habitatId: "habitat-1" },
    );
    expect(result).toEqual(mockEvidenceResult);
  });

  it("emits SSE events for each linked evidence", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({ params: { taskId: "task-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockGetMissionById).toHaveBeenCalledWith("mission-1");
    expect(mockCreateEvent).toHaveBeenCalled();
    expect(mockSsePublish).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({ type: "code_evidence.updated" }),
    );
  });

  it("emits SSE task.updated event", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({ params: { taskId: "task-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).toHaveBeenCalledWith("habitat-1", {
      type: "task.updated",
      data: expect.objectContaining({ id: "task-1" }),
    });
  });

  it("uses human actor when user is set", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      body: {},
      agent: null,
      user: { id: "user-1", role: "admin" },
    });
    await route!.handler(req, createMockReply());
    expect(mockLinkTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      {},
      { type: "human", id: "user-1" },
      { habitatId: "habitat-1" },
    );
  });

  it("uses system actor when neither agent nor user is set", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      body: {},
      agent: null,
      user: null,
    });
    await route!.handler(req, createMockReply());
    expect(mockLinkTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      {},
      { type: "system", id: "system" },
      { habitatId: "habitat-1" },
    );
  });

  it("skips SSE events when no links are returned", async () => {
    mockLinkTaskCodeEvidence.mockReturnValue({ links: [], completeness: { percentage: 0 } });
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({ params: { taskId: "task-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).not.toHaveBeenCalled();
  });

  it("skips SSE events when habitatId cannot be resolved", async () => {
    mockGetMissionById.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({ params: { taskId: "task-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).not.toHaveBeenCalled();
  });

  it("throws not found for missing task", async () => {
    mockGetTaskById.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({ params: { taskId: "missing" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Task not found");
  });
});

describe("POST /tasks/:taskId/code-evidence/:linkId/correct handler", () => {
  beforeEach(resetMocks);

  it("corrects an evidence link", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/:linkId/correct",
    );
    const body = { status: "incorrect", reason: "wrong commit" };
    const req = createMockRequest({ params: { taskId: "task-1", linkId: "link-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockCorrectEvidenceLink).toHaveBeenCalledWith("link-1", body, {
      type: "agent",
      id: "agent-1",
    });
    expect(result).toEqual({ link: mockCorrectedLink });
  });

  it("emits corrected event", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/:linkId/correct",
    );
    const req = createMockRequest({
      params: { taskId: "task-1", linkId: "link-1" },
      body: { status: "incorrect", reason: "test" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_corrected",
        metadata: { evidenceLinkId: "link-1", changeKind: "corrected" },
      }),
    );
  });

  it("throws not found for missing task", async () => {
    mockGetTaskById.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/:linkId/correct",
    );
    const req = createMockRequest({
      params: { taskId: "missing", linkId: "link-1" },
      body: { status: "incorrect", reason: "x" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Task not found");
  });

  it("throws not found when correctEvidenceLink returns null", async () => {
    mockCorrectEvidenceLink.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/:linkId/correct",
    );
    const req = createMockRequest({
      params: { taskId: "task-1", linkId: "link-1" },
      body: { status: "incorrect", reason: "x" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Evidence link not found");
  });

  it("accepts superseded status with replacementLinkId", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/:linkId/correct",
    );
    const body = { status: "superseded", reason: "replaced", replacementLinkId: "link-2" };
    const req = createMockRequest({ params: { taskId: "task-1", linkId: "link-1" }, body });
    await route!.handler(req, createMockReply());
    expect(mockCorrectEvidenceLink).toHaveBeenCalledWith("link-1", body, {
      type: "agent",
      id: "agent-1",
    });
  });
});

describe("POST /tasks/:taskId/code-evidence/not-applicable handler", () => {
  beforeEach(resetMocks);

  it("marks evidence as not applicable", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    const body = { reasonCode: "no-code", reasonNote: "Config-only task" };
    const req = createMockRequest({ params: { taskId: "task-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockMarkCodeEvidenceNotApplicable).toHaveBeenCalledWith("task", "task-1", body, {
      type: "agent",
      id: "agent-1",
    });
    expect(result).toEqual({ completeness: mockCompleteness });
  });

  it("emits not_applicable event", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      body: { reasonCode: "no-code" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_marked_not_applicable",
      }),
    );
  });

  it("throws not found for missing task", async () => {
    mockGetTaskById.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { taskId: "missing" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Task not found");
  });
});

describe("DELETE /tasks/:taskId/code-evidence/not-applicable handler", () => {
  beforeEach(resetMocks);

  it("clears not-applicable and returns success", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "DELETE" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { taskId: "task-1" } });
    const result = await route!.handler(req, createMockReply());
    expect(mockClearCodeEvidenceNotApplicable).toHaveBeenCalledWith("task", "task-1");
    expect(result).toEqual({ success: true });
  });

  it("emits cleared_not_applicable event", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "DELETE" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { taskId: "task-1" } });
    await route!.handler(req, createMockReply());
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_cleared_not_applicable",
        taskId: "task-1",
      }),
    );
  });

  it("emits SSE code_evidence.updated event", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "DELETE" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { taskId: "task-1" } });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({
        type: "code_evidence.updated",
        data: expect.objectContaining({ targetType: "task", changeKind: "not_applicable" }),
      }),
    );
  });

  it("throws not found for missing task", async () => {
    mockGetTaskById.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "DELETE" && r.path === "/tasks/:taskId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { taskId: "missing" } });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Task not found");
  });
});

describe("POST /tasks/:taskId/code-evidence/gaps handler", () => {
  beforeEach(resetMocks);

  it("reports an evidence gap", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps",
    );
    const body = { reasonCode: "missing-tests", reasonNote: "No unit tests" };
    const req = createMockRequest({ params: { taskId: "task-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockReportCodeEvidenceGap).toHaveBeenCalledWith("task", "task-1", body, {
      type: "agent",
      id: "agent-1",
    });
    expect(result).toEqual({ gap: mockGap });
  });

  it("emits gap_reported event", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      body: { reasonCode: "missing-tests" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_gap_reported",
        metadata: { evidenceLinkId: "gap-1", changeKind: "gap_reported" },
      }),
    );
  });

  it("throws bad request when service returns null", async () => {
    mockReportCodeEvidenceGap.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps",
    );
    const req = createMockRequest({ params: { taskId: "task-1" }, body: { reasonCode: "test" } });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "Failed to create evidence gap",
    );
  });

  it("throws not found for missing task", async () => {
    mockGetTaskById.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps",
    );
    const req = createMockRequest({ params: { taskId: "missing" }, body: { reasonCode: "test" } });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Task not found");
  });
});

describe("POST /tasks/:taskId/code-evidence/gaps/:gapId/resolve handler", () => {
  beforeEach(resetMocks);

  it("resolves an evidence gap", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    );
    const body = { resolutionReason: "Tests added in PR #42" };
    const req = createMockRequest({ params: { taskId: "task-1", gapId: "gap-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockResolveCodeEvidenceGap).toHaveBeenCalledWith("gap-1", body, {
      type: "agent",
      id: "agent-1",
    });
    expect(result).toEqual({ gap: mockResolvedGap });
  });

  it("emits gap_resolved event", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    );
    const req = createMockRequest({
      params: { taskId: "task-1", gapId: "gap-1" },
      body: { resolutionReason: "done" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_gap_resolved",
        metadata: { gapId: "gap-1" },
      }),
    );
  });

  it("emits SSE verified event", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    );
    const req = createMockRequest({
      params: { taskId: "task-1", gapId: "gap-1" },
      body: { resolutionReason: "done" },
    });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({
        type: "code_evidence.updated",
        data: expect.objectContaining({ changeKind: "verified" }),
      }),
    );
  });

  it("throws not found for missing task", async () => {
    mockGetTaskById.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    );
    const req = createMockRequest({
      params: { taskId: "missing", gapId: "gap-1" },
      body: { resolutionReason: "done" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Task not found");
  });

  it("throws not found when resolveCodeEvidenceGap returns null", async () => {
    mockResolveCodeEvidenceGap.mockReturnValue(null);
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    );
    const req = createMockRequest({
      params: { taskId: "task-1", gapId: "missing" },
      body: { resolutionReason: "done" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Evidence gap not found");
  });
});

describe("GET /missions/:missionId/code-evidence handler", () => {
  beforeEach(resetMocks);

  it("returns evidence for an existing mission", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/missions/:missionId/code-evidence",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1" },
      query: { includeHistory: false },
    });
    const result = await route!.handler(req, createMockReply());
    expect(mockGetMissionById).toHaveBeenCalledWith("mission-1");
    expect(mockGetMissionCodeEvidence).toHaveBeenCalledWith(
      "mission-1",
      expect.objectContaining({ includeHistory: false }),
    );
    expect(result).toEqual(mockEvidenceResult);
  });

  it("passes includeHistory=true when requested", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/missions/:missionId/code-evidence",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1" },
      query: { includeHistory: true },
    });
    await route!.handler(req, createMockReply());
    expect(mockGetMissionCodeEvidence).toHaveBeenCalledWith(
      "mission-1",
      expect.objectContaining({ includeHistory: true }),
    );
  });

  it("throws not found for missing mission", async () => {
    mockGetMissionById.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/missions/:missionId/code-evidence",
    );
    const req = createMockRequest({ params: { missionId: "missing" }, query: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Mission not found");
  });
});

describe("POST /missions/:missionId/code-evidence handler", () => {
  beforeEach(resetMocks);

  it("links code evidence and returns result", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence",
    );
    const body = {
      branch: { name: "feature/test" },
      pullRequestUrl: "https://github.com/org/repo/pull/1",
    };
    const req = createMockRequest({ params: { missionId: "mission-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockGetMissionById).toHaveBeenCalledWith("mission-1");
    expect(mockLinkMissionCodeEvidence).toHaveBeenCalledWith(
      "mission-1",
      body,
      {
        type: "agent",
        id: "agent-1",
      },
      { habitatId: "habitat-1" },
    );
    expect(result).toEqual(mockEvidenceResult);
  });

  it("emits SSE events for each linked evidence", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence",
    );
    const req = createMockRequest({ params: { missionId: "mission-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockCreateMissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_linked",
      }),
    );
  });

  it("uses mission habitatId directly for SSE", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence",
    );
    const req = createMockRequest({ params: { missionId: "mission-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({ type: "code_evidence.updated" }),
    );
  });

  it("skips SSE events when no links are returned", async () => {
    mockLinkMissionCodeEvidence.mockReturnValue({ links: [], completeness: { percentage: 0 } });
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence",
    );
    const req = createMockRequest({ params: { missionId: "mission-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).not.toHaveBeenCalled();
  });

  it("throws not found for missing mission", async () => {
    mockGetMissionById.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence",
    );
    const req = createMockRequest({ params: { missionId: "missing" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Mission not found");
  });
});

describe("POST /missions/:missionId/code-evidence/:linkId/correct handler", () => {
  beforeEach(resetMocks);

  it("corrects a mission evidence link", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/:linkId/correct",
    );
    const body = { status: "removed", reason: "stale" };
    const req = createMockRequest({ params: { missionId: "mission-1", linkId: "link-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockCorrectEvidenceLink).toHaveBeenCalledWith("link-1", body, {
      type: "agent",
      id: "agent-1",
    });
    expect(result).toEqual({ link: mockCorrectedLink });
  });

  it("emits corrected mission event", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/:linkId/correct",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1", linkId: "link-1" },
      body: { status: "removed", reason: "x" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateMissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_corrected",
      }),
    );
  });

  it("throws not found for missing mission", async () => {
    mockGetMissionById.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/:linkId/correct",
    );
    const req = createMockRequest({
      params: { missionId: "missing", linkId: "link-1" },
      body: { status: "removed", reason: "x" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Mission not found");
  });

  it("throws not found when correctEvidenceLink returns null", async () => {
    mockCorrectEvidenceLink.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/:linkId/correct",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1", linkId: "link-1" },
      body: { status: "removed", reason: "x" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Evidence link not found");
  });
});

describe("POST /missions/:missionId/code-evidence/not-applicable handler", () => {
  beforeEach(resetMocks);

  it("marks mission evidence as not applicable", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    const body = { reasonCode: "infra-only", reasonNote: "Infrastructure change" };
    const req = createMockRequest({ params: { missionId: "mission-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockMarkCodeEvidenceNotApplicable).toHaveBeenCalledWith("mission", "mission-1", body, {
      type: "agent",
      id: "agent-1",
    });
    expect(result).toEqual({ completeness: mockCompleteness });
  });

  it("emits not_applicable mission event", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1" },
      body: { reasonCode: "test" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateMissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_marked_not_applicable",
      }),
    );
  });

  it("throws not found for missing mission", async () => {
    mockGetMissionById.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { missionId: "missing" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Mission not found");
  });
});

describe("DELETE /missions/:missionId/code-evidence/not-applicable handler", () => {
  beforeEach(resetMocks);

  it("clears mission not-applicable and returns success", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "DELETE" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { missionId: "mission-1" } });
    const result = await route!.handler(req, createMockReply());
    expect(mockClearCodeEvidenceNotApplicable).toHaveBeenCalledWith("mission", "mission-1");
    expect(result).toEqual({ success: true });
  });

  it("emits cleared_not_applicable mission event", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "DELETE" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { missionId: "mission-1" } });
    await route!.handler(req, createMockReply());
    expect(mockCreateMissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_cleared_not_applicable",
        missionId: "mission-1",
      }),
    );
  });

  it("emits SSE code_evidence.updated event", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "DELETE" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { missionId: "mission-1" } });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({
        type: "code_evidence.updated",
        data: expect.objectContaining({ targetType: "mission", changeKind: "not_applicable" }),
      }),
    );
  });

  it("throws not found for missing mission", async () => {
    mockGetMissionById.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "DELETE" && r.path === "/missions/:missionId/code-evidence/not-applicable",
    );
    const req = createMockRequest({ params: { missionId: "missing" } });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Mission not found");
  });
});

describe("POST /missions/:missionId/code-evidence/gaps handler", () => {
  beforeEach(resetMocks);

  it("reports a mission evidence gap", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps",
    );
    const body = { reasonCode: "missing-ci", reasonNote: "No CI pipeline configured" };
    const req = createMockRequest({ params: { missionId: "mission-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockReportCodeEvidenceGap).toHaveBeenCalledWith("mission", "mission-1", body, {
      type: "agent",
      id: "agent-1",
    });
    expect(result).toEqual({ gap: mockGap });
  });

  it("emits gap_reported mission event", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1" },
      body: { reasonCode: "missing-ci" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateMissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_gap_reported",
      }),
    );
  });

  it("throws bad request when service returns null", async () => {
    mockReportCodeEvidenceGap.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1" },
      body: { reasonCode: "test" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "Failed to create evidence gap",
    );
  });

  it("throws not found for missing mission", async () => {
    mockGetMissionById.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps",
    );
    const req = createMockRequest({
      params: { missionId: "missing" },
      body: { reasonCode: "test" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Mission not found");
  });
});

describe("POST /missions/:missionId/code-evidence/gaps/:gapId/resolve handler", () => {
  beforeEach(resetMocks);

  it("resolves a mission evidence gap", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    );
    const body = { resolutionReason: "CI pipeline configured" };
    const req = createMockRequest({ params: { missionId: "mission-1", gapId: "gap-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockResolveCodeEvidenceGap).toHaveBeenCalledWith("gap-1", body, {
      type: "agent",
      id: "agent-1",
    });
    expect(result).toEqual({ gap: mockResolvedGap });
  });

  it("emits gap_resolved mission event", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1", gapId: "gap-1" },
      body: { resolutionReason: "done" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateMissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code_evidence_gap_resolved",
        metadata: { gapId: "gap-1" },
      }),
    );
  });

  it("emits SSE verified event for mission", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1", gapId: "gap-1" },
      body: { resolutionReason: "done" },
    });
    await route!.handler(req, createMockReply());
    expect(mockSsePublish).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({
        type: "code_evidence.updated",
        data: expect.objectContaining({ targetType: "mission", changeKind: "verified" }),
      }),
    );
  });

  it("throws not found for missing mission", async () => {
    mockGetMissionById.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    );
    const req = createMockRequest({
      params: { missionId: "missing", gapId: "gap-1" },
      body: { resolutionReason: "done" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Mission not found");
  });

  it("throws not found when resolveCodeEvidenceGap returns null", async () => {
    mockResolveCodeEvidenceGap.mockReturnValue(null);
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    );
    const req = createMockRequest({
      params: { missionId: "mission-1", gapId: "missing" },
      body: { resolutionReason: "done" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Evidence gap not found");
  });
});

describe("GET /habitats/:habitatId/repository handler", () => {
  beforeEach(resetMocks);

  it("returns repository settings for a habitat", async () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/habitats/:habitatId/repository",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" } });
    const result = await route!.handler(req, createMockReply());
    expect(mockGetHabitatById).toHaveBeenCalledWith("habitat-1");
    expect(mockGetByHabitatId).toHaveBeenCalledWith("habitat-1");
    expect(result).toEqual({ repository: mockRepository });
  });

  it("throws not found for missing habitat", async () => {
    mockGetHabitatById.mockReturnValue(null);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "GET" && r.path === "/habitats/:habitatId/repository",
    );
    const req = createMockRequest({ params: { habitatId: "missing" } });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Habitat not found");
  });
});

describe("PUT /habitats/:habitatId/repository handler", () => {
  beforeEach(resetMocks);

  it("creates new repository when none exists", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "PUT" && r.path === "/habitats/:habitatId/repository",
    );
    const body = { provider: "github", repoSlug: "org/repo", displayName: "My Repo" };
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        habitatId: "habitat-1",
        provider: "github",
        repoSlug: "org/repo",
      }),
    );
    expect(result).toEqual({ repository: mockRepository });
  });

  it("throws bad request when creating without provider", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "PUT" && r.path === "/habitats/:habitatId/repository",
    );
    const body = { repoSlug: "org/repo" };
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "provider and repoSlug are required when creating a repository identity",
    );
  });

  it("throws bad request when creating without repoSlug", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "PUT" && r.path === "/habitats/:habitatId/repository",
    );
    const body = { provider: "github" };
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "provider and repoSlug are required when creating a repository identity",
    );
  });

  it("updates existing repository", async () => {
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "PUT" && r.path === "/habitats/:habitatId/repository",
    );
    const body = { provider: "gitlab", repoSlug: "org/new-repo", displayName: "Updated Repo" };
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body });
    const result = await route!.handler(req, createMockReply());
    expect(mockUpdateByHabitatId).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({
        provider: "gitlab",
        repoSlug: "org/new-repo",
        displayName: "Updated Repo",
      }),
    );
    expect(result).toEqual({ repository: mockRepository });
  });

  it("throws not found for missing habitat", async () => {
    mockGetHabitatById.mockReturnValue(null);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "PUT" && r.path === "/habitats/:habitatId/repository",
    );
    const req = createMockRequest({
      params: { habitatId: "missing" },
      body: { provider: "github", repoSlug: "org/repo" },
    });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Habitat not found");
  });

  it("passes optional fields when creating", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) => r.method === "PUT" && r.path === "/habitats/:habitatId/repository",
    );
    const body = {
      provider: "github",
      repoSlug: "org/repo",
      providerBaseUrl: "https://github.enterprise.com",
      externalId: "ext-123",
      localPath: "/home/user/project",
    };
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body });
    await route!.handler(req, createMockReply());
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        providerBaseUrl: "https://github.enterprise.com",
        externalId: "ext-123",
        localPath: "/home/user/project",
      }),
    );
  });
});

describe("POST /habitats/:habitatId/repository/infer-from-worktree handler", () => {
  beforeEach(resetMocks);

  it("creates repo from worktree settings when none exists", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    mockGetHabitatById.mockReturnValue({
      id: "habitat-1",
      gitWorktreeSettings: { path: "/home/user/project", repoSlug: "org/repo", provider: "github" },
    });
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    const result = await route!.handler(req, createMockReply());
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        habitatId: "habitat-1",
        provider: "github",
        repoSlug: "org/repo",
        localPath: "/home/user/project",
      }),
    );
    expect(result).toEqual({ repository: mockRepository });
  });

  it('defaults provider to "local" when not in worktree settings', async () => {
    mockGetByHabitatId.mockReturnValue(null);
    mockGetHabitatById.mockReturnValue({
      id: "habitat-1",
      gitWorktreeSettings: { path: "/home/user/project", repoSlug: "org/repo" },
    });
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local",
      }),
    );
  });

  it("updates existing repo with worktree settings", async () => {
    mockGetHabitatById.mockReturnValue({
      id: "habitat-1",
      gitWorktreeSettings: { path: "/home/user/project", repoSlug: "org/repo", provider: "github" },
    });
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    const result = await route!.handler(req, createMockReply());
    expect(mockUpdateByHabitatId).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({
        provider: "github",
        localPath: "/home/user/project",
      }),
    );
    expect(result).toEqual({ repository: mockRepository });
  });

  it("uses body worktreePath when provided", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    mockGetHabitatById.mockReturnValue({
      id: "habitat-1",
      gitWorktreeSettings: { path: "/default/path", repoSlug: "org/repo", provider: "github" },
    });
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    const req = createMockRequest({
      params: { habitatId: "habitat-1" },
      body: { worktreePath: "/custom/path" },
    });
    await route!.handler(req, createMockReply());
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        localPath: "/custom/path",
      }),
    );
  });

  it("throws bad request when no worktree settings on habitat", async () => {
    mockGetHabitatById.mockReturnValue({ id: "habitat-1", gitWorktreeSettings: null });
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "No worktree path configured for this habitat",
    );
  });

  it("throws bad request when worktree settings have no path", async () => {
    mockGetHabitatById.mockReturnValue({ id: "habitat-1", gitWorktreeSettings: {} });
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "No worktree path configured for this habitat",
    );
  });

  it("throws bad request when creating without repoSlug in worktree settings", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    mockGetHabitatById.mockReturnValue({
      id: "habitat-1",
      gitWorktreeSettings: { path: "/home/user/project" },
    });
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "Cannot infer repository identity: no repoSlug in worktree settings",
    );
  });

  it("throws not found for missing habitat", async () => {
    mockGetHabitatById.mockReturnValue(null);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-worktree",
    );
    const req = createMockRequest({ params: { habitatId: "missing" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Habitat not found");
  });
});

describe("POST /habitats/:habitatId/repository/infer-from-integration handler", () => {
  beforeEach(resetMocks);

  it("creates repo from GitHub integration when none exists", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    mockListByHabitat.mockReturnValue([
      {
        provider: "github",
        enabled: true,
        repositoryOwner: "myorg",
        repositoryName: "myrepo",
        externalAccountId: "ext-acc-1",
        externalBaseUrl: "https://api.github.com",
      },
    ]);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    const result = await route!.handler(req, createMockReply());
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        habitatId: "habitat-1",
        provider: "github",
        repoSlug: "myorg/myrepo",
        externalId: "ext-acc-1",
        providerBaseUrl: "https://api.github.com",
      }),
    );
    expect(result).toEqual({ repository: mockRepository });
  });

  it("updates existing repo from GitHub integration", async () => {
    mockListByHabitat.mockReturnValue([
      {
        provider: "github",
        enabled: true,
        repositoryOwner: "myorg",
        repositoryName: "myrepo",
        externalAccountId: "ext-acc-1",
        externalBaseUrl: "https://api.github.com",
      },
    ]);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    const result = await route!.handler(req, createMockReply());
    expect(mockUpdateByHabitatId).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({
        provider: "github",
        repoSlug: "myorg/myrepo",
      }),
    );
    expect(result).toEqual({ repository: mockRepository });
  });

  it("throws bad request when no GitHub integration exists", async () => {
    mockListByHabitat.mockReturnValue([]);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "No GitHub integration with repository configured for this habitat",
    );
  });

  it("throws bad request when GitHub integration is disabled", async () => {
    mockListByHabitat.mockReturnValue([
      {
        provider: "github",
        enabled: false,
        repositoryOwner: "myorg",
        repositoryName: "myrepo",
      },
    ]);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "No GitHub integration with repository configured for this habitat",
    );
  });

  it("throws bad request when GitHub integration has no repository configured", async () => {
    mockListByHabitat.mockReturnValue([
      {
        provider: "github",
        enabled: true,
        repositoryOwner: null,
        repositoryName: null,
      },
    ]);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow(
      "No GitHub integration with repository configured for this habitat",
    );
  });

  it("ignores non-GitHub enabled connections", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    mockListByHabitat.mockReturnValue([
      { provider: "gitlab", enabled: true, repositoryOwner: "org", repositoryName: "repo" },
      {
        provider: "github",
        enabled: true,
        repositoryOwner: "myorg",
        repositoryName: "myrepo",
        externalAccountId: "ext-1",
      },
    ]);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        repoSlug: "myorg/myrepo",
      }),
    );
  });

  it("handles undefined externalAccountId gracefully", async () => {
    mockGetByHabitatId.mockReturnValue(null);
    mockListByHabitat.mockReturnValue([
      {
        provider: "github",
        enabled: true,
        repositoryOwner: "myorg",
        repositoryName: "myrepo",
        externalAccountId: undefined,
        externalBaseUrl: undefined,
      },
    ]);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    const req = createMockRequest({ params: { habitatId: "habitat-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: undefined,
        providerBaseUrl: undefined,
      }),
    );
  });

  it("throws not found for missing habitat", async () => {
    mockGetHabitatById.mockReturnValue(null);
    const routes = captureRoutes(repositorySettingsRoutes);
    const route = routes.find(
      (r) =>
        r.method === "POST" && r.path === "/habitats/:habitatId/repository/infer-from-integration",
    );
    const req = createMockRequest({ params: { habitatId: "missing" }, body: {} });
    await expect(route!.handler(req, createMockReply())).rejects.toThrow("Habitat not found");
  });
});

describe("emitEvidenceEvent integration (task side effects)", () => {
  beforeEach(resetMocks);

  it("task link emits code_evidence_linked event and task.updated SSE", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({ params: { taskId: "task-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "code_evidence_linked",
        metadata: { evidenceLinkId: "link-1", changeKind: "linked" },
      }),
    );
    expect(mockSsePublish).toHaveBeenCalledWith("habitat-1", {
      type: "task.updated",
      data: expect.objectContaining({ id: "task-1" }),
    });
  });

  it("mission link emits code_evidence_linked mission event and mission.updated SSE", async () => {
    const routes = captureRoutes(missionCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/missions/:missionId/code-evidence",
    );
    const req = createMockRequest({ params: { missionId: "mission-1" }, body: {} });
    await route!.handler(req, createMockReply());
    expect(mockCreateMissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "code_evidence_linked",
        metadata: { evidenceLinkId: "link-1", changeKind: "linked" },
      }),
    );
    expect(mockSsePublish).toHaveBeenCalledWith("habitat-1", {
      type: "mission.updated",
      data: expect.objectContaining({ id: "mission-1" }),
    });
  });
});

describe("getActor integration", () => {
  beforeEach(resetMocks);

  it("uses agent actor when request has agent", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      body: {},
      agent: { id: "agent-42" },
      user: { id: "user-1", role: "admin" },
    });
    await route!.handler(req, createMockReply());
    expect(mockLinkTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      {},
      { type: "agent", id: "agent-42" },
      { habitatId: "habitat-1" },
    );
  });

  it("uses human actor when request has user but no agent", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      body: {},
      agent: null,
      user: { id: "user-99", role: "member" },
    });
    await route!.handler(req, createMockReply());
    expect(mockLinkTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      {},
      { type: "human", id: "user-99" },
      { habitatId: "habitat-1" },
    );
  });

  it("uses system actor when request has neither agent nor user", async () => {
    const routes = captureRoutes(taskCodeEvidenceRoutes);
    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/tasks/:taskId/code-evidence",
    );
    const req = createMockRequest({
      params: { taskId: "task-1" },
      body: {},
      agent: null,
      user: null,
    });
    await route!.handler(req, createMockReply());
    expect(mockLinkTaskCodeEvidence).toHaveBeenCalledWith(
      "task-1",
      {},
      { type: "system", id: "system" },
      { habitatId: "habitat-1" },
    );
  });
});
