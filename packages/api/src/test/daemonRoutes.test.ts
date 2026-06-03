import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mocks = vi.hoisted(() => ({
  agentService: { createAgent: vi.fn() },
  taskService: { claimTask: vi.fn() },
  taskRepo: { getTaskById: vi.fn() },
  habitatRepo: { getHabitatById: vi.fn() },
  daemonRepo: {
    createDaemon: vi.fn(),
    createDaemonAgent: vi.fn(),
    updateDaemonHeartbeat: vi.fn(),
    getDaemonAgentByAgentId: vi.fn(),
    updateDaemonAgentStatus: vi.fn(),
    isAgentOwnedByDaemon: vi.fn(),
    createDaemonSession: vi.fn(),
    getSessionById: vi.fn(),
    updateSessionStatus: vi.fn(),
    updateSessionProgress: vi.fn(),
    getActiveSessionsByDaemonId: vi.fn(),
  },
  suggestionService: { getSuggestionsForAgent: vi.fn() },
}));

vi.mock("../services/agentService.js", () => mocks.agentService);
vi.mock("../services/tasks/index.js", () => mocks.taskService);
vi.mock("../repositories/task.js", () => mocks.taskRepo);
vi.mock("../repositories/board.js", () => mocks.habitatRepo);
vi.mock("../repositories/daemon.js", () => mocks.daemonRepo);
vi.mock("../services/taskSuggestion.js", () => mocks.suggestionService);
vi.mock("../lib/daemonToken.js", () => ({
  generateDaemonToken: () => "daemon-test-token-1234",
}));
vi.mock("../middleware/daemonAuth.js", () => ({
  daemonAuth: async (req: any) => {
    req.daemon = {
      id: "00000000-0000-0000-0000-000000000001",
      name: "ws",
      hostname: "host",
      status: "online",
      maxConcurrent: 4,
    };
  },
}));
vi.mock("../middleware/auth.js", () => ({
  registrationAuth: async () => {},
}));
vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => Object.assign(new Error(msg), { statusCode: 400 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { statusCode: 404 }),
  forbidden: (msg: string) => Object.assign(new Error(msg), { statusCode: 403 }),
  conflict: (msg: string) => Object.assign(new Error(msg), { statusCode: 409 }),
  unauthorized: (msg: string) => Object.assign(new Error(msg), { statusCode: 401 }),
}));

import { daemonRoutes } from "../routes/daemon.js";
import type { FastifyInstance } from "fastify";

const D1 = "00000000-0000-0000-0000-000000000001";
const HAB = "00000000-0000-0000-0000-000000000010";
const AG1 = "00000000-0000-0000-0000-000000000011";
const AG2 = "00000000-0000-0000-0000-000000000012";
const T1 = "00000000-0000-0000-0000-000000000020";
const T2 = "00000000-0000-0000-0000-000000000021";
const SESS = "00000000-0000-0000-0000-000000000030";
const BAD_HAB = "99999999-9999-9999-9999-999999999999";

function captureRoutes(): Map<string, { handler: Function; preHandler?: any[] }> {
  const routes = new Map<string, { handler: Function; preHandler?: any[] }>();
  const fake = {
    post: vi.fn((path: string, opts: any, handler?: Function) => {
      routes.set(`POST ${path}`, { handler: handler ?? opts, preHandler: opts?.preHandler });
    }),
    patch: vi.fn((path: string, opts: any, handler?: Function) => {
      routes.set(`PATCH ${path}`, { handler: handler ?? opts, preHandler: opts?.preHandler });
    }),
    get: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  } as unknown as FastifyInstance;
  daemonRoutes(fake);
  return routes;
}

function mockReply() {
  const reply: any = { code: vi.fn(() => reply), send: vi.fn(() => reply) };
  return reply;
}

describe("daemonRoutes", () => {
  let routes: Map<string, { handler: Function; preHandler?: any[] }>;

  beforeAll(() => {
    routes = captureRoutes();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.daemonRepo.createDaemonSession.mockReturnValue({ id: SESS });
    mocks.daemonRepo.getActiveSessionsByDaemonId.mockReturnValue([]);
  });

  describe("POST /daemon/register", () => {
    it("registers a daemon with managed agents", async () => {
      mocks.habitatRepo.getHabitatById.mockReturnValue({ id: HAB, name: "Test" });
      mocks.daemonRepo.createDaemon.mockReturnValue({ id: D1, name: "ws" });
      mocks.agentService.createAgent
        .mockReturnValueOnce({
          agent: { id: AG1, name: "daemon-ws-claude-code" },
          plainApiKey: "key-1",
        })
        .mockReturnValueOnce({
          agent: { id: AG2, name: "daemon-ws-cursor" },
          plainApiKey: "key-2",
        });

      const reply = mockReply();
      const result = await routes.get("POST /daemon/register")!.handler(
        {
          body: {
            name: "ws",
            hostname: "workstation.local",
            maxConcurrent: 4,
            daemonVersion: "0.14.0",
            detectedClis: [
              { type: "claude-code", version: "1.0", path: "/usr/local/bin/claude" },
              { type: "cursor", version: "0.1", path: "/usr/local/bin/cursor-agent" },
            ],
            habitatIds: [HAB],
          },
        } as any,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(201);
      expect(result.daemonId).toBe(D1);
      expect(result.daemonToken).toBe("daemon-test-token-1234");
      expect(result.heartbeatIntervalSeconds).toBe(30);
      expect(result.agents).toHaveLength(2);
      expect(result.agents[0].apiKey).toBe("key-1");
      expect(result.agents[1].apiKey).toBe("key-2");
      expect(mocks.daemonRepo.createDaemonAgent).toHaveBeenCalledTimes(2);
    });

    it("rejects invalid habitat", async () => {
      mocks.habitatRepo.getHabitatById.mockReturnValue(null);
      const reply = mockReply();

      await expect(
        routes.get("POST /daemon/register")!.handler(
          {
            body: {
              name: "ws",
              hostname: "h",
              maxConcurrent: 4,
              daemonVersion: "0.14",
              detectedClis: [{ type: "claude-code", path: "/bin/claude" }],
              habitatIds: [BAD_HAB],
            },
          } as any,
          reply,
        ),
      ).rejects.toThrow(`Habitat ${BAD_HAB} not found`);
    });
  });

  describe("POST /daemon/heartbeat", () => {
    it("updates daemon heartbeat", async () => {
      const reply = mockReply();
      const result = await routes.get("POST /daemon/heartbeat")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          body: {},
        } as any,
        reply,
      );

      expect(mocks.daemonRepo.updateDaemonHeartbeat).toHaveBeenCalledWith(D1);
      expect(result.nextCheckInSeconds).toBe(30);
    });

    it("updates agent statuses for owned agents", async () => {
      mocks.daemonRepo.getDaemonAgentByAgentId.mockReturnValue({ id: "da-1", daemonId: D1 });
      const reply = mockReply();
      await routes.get("POST /daemon/heartbeat")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          body: { agentStatuses: [{ agentId: AG1, status: "working" }] },
        } as any,
        reply,
      );

      expect(mocks.daemonRepo.updateDaemonAgentStatus).toHaveBeenCalledWith("da-1", "working");
    });

    it("skips agent statuses for non-owned agents", async () => {
      mocks.daemonRepo.getDaemonAgentByAgentId.mockReturnValue({ id: "da-1", daemonId: "other" });
      const reply = mockReply();
      await routes.get("POST /daemon/heartbeat")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          body: { agentStatuses: [{ agentId: AG1, status: "working" }] },
        } as any,
        reply,
      );

      expect(mocks.daemonRepo.updateDaemonAgentStatus).not.toHaveBeenCalled();
    });
  });

  describe("POST /daemon/tasks/claim-next", () => {
    it("claims a task and returns it with worktree settings", async () => {
      mocks.daemonRepo.isAgentOwnedByDaemon.mockReturnValue(true);
      mocks.habitatRepo.getHabitatById.mockReturnValue({
        id: HAB,
        gitWorktreeSettings: { repoPath: "/repo", branchPrefix: "task/", autoCleanup: true },
      });
      mocks.suggestionService.getSuggestionsForAgent.mockReturnValue({
        suggestions: [{ taskId: T1, taskTitle: "Do thing" }],
      });
      mocks.taskService.claimTask.mockReturnValue({ success: true, task: { id: T1 } });
      mocks.taskRepo.getTaskById.mockReturnValue({
        id: T1,
        title: "Do thing",
        description: "desc",
        missionId: "m1",
        priority: "high",
        requiredDomain: "backend",
        requiredCapabilities: ["ts"],
      });

      const reply = mockReply();
      const result = await routes.get("POST /daemon/tasks/claim-next")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          body: { agentId: AG1, habitatId: HAB },
        } as any,
        reply,
      );

      expect(mocks.daemonRepo.createDaemonSession).toHaveBeenCalledWith(
        expect.objectContaining({ daemonId: D1, agentId: AG1, taskId: T1, workdir: "pending" }),
      );
      expect(result.daemonSessionId).toBe(SESS);
      expect(result.task.id).toBe(T1);
      expect(result.worktreeSettings.repoPath).toBe("/repo");
    });

    it("returns 204 when no task can be claimed", async () => {
      mocks.daemonRepo.isAgentOwnedByDaemon.mockReturnValue(true);
      mocks.habitatRepo.getHabitatById.mockReturnValue({ id: HAB });
      mocks.suggestionService.getSuggestionsForAgent.mockReturnValue({
        suggestions: [{ taskId: T1 }],
      });
      mocks.taskService.claimTask.mockReturnValue({ success: false, reason: "already_claimed" });

      const reply = mockReply();
      await routes.get("POST /daemon/tasks/claim-next")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          body: { agentId: AG1, habitatId: HAB },
        } as any,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(204);
      expect(mocks.daemonRepo.createDaemonSession).not.toHaveBeenCalled();
    });

    it("tries second suggestion when first fails", async () => {
      mocks.daemonRepo.isAgentOwnedByDaemon.mockReturnValue(true);
      mocks.habitatRepo.getHabitatById.mockReturnValue({ id: HAB });
      mocks.suggestionService.getSuggestionsForAgent.mockReturnValue({
        suggestions: [{ taskId: T1 }, { taskId: T2 }],
      });
      mocks.taskService.claimTask
        .mockReturnValueOnce({ success: false, reason: "already_claimed" })
        .mockReturnValueOnce({ success: true, task: { id: T2 } });
      mocks.taskRepo.getTaskById.mockReturnValue({
        id: T2,
        title: "T2",
        description: "",
        missionId: "m1",
        priority: "low",
        requiredDomain: null,
        requiredCapabilities: [],
      });

      const reply = mockReply();
      await routes.get("POST /daemon/tasks/claim-next")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          body: { agentId: AG1, habitatId: HAB },
        } as any,
        reply,
      );

      expect(mocks.taskService.claimTask).toHaveBeenCalledTimes(2);
      expect(mocks.daemonRepo.createDaemonSession).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: T2 }),
      );
    });

    it("rejects non-owned agent", async () => {
      mocks.daemonRepo.isAgentOwnedByDaemon.mockReturnValue(false);
      const reply = mockReply();

      await expect(
        routes.get("POST /daemon/tasks/claim-next")!.handler(
          {
            daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
            body: { agentId: "99999999-9999-9999-9999-999999999998", habitatId: HAB },
          } as any,
          reply,
        ),
      ).rejects.toThrow("Agent does not belong to this daemon");
    });

    it("rejects invalid habitat", async () => {
      mocks.daemonRepo.isAgentOwnedByDaemon.mockReturnValue(true);
      mocks.habitatRepo.getHabitatById.mockReturnValue(null);
      const reply = mockReply();

      await expect(
        routes.get("POST /daemon/tasks/claim-next")!.handler(
          {
            daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
            body: { agentId: AG1, habitatId: BAD_HAB },
          } as any,
          reply,
        ),
      ).rejects.toThrow(`Habitat ${BAD_HAB} not found`);
    });

    it("returns 204 when no suggestions available", async () => {
      mocks.daemonRepo.isAgentOwnedByDaemon.mockReturnValue(true);
      mocks.habitatRepo.getHabitatById.mockReturnValue({ id: HAB });
      mocks.suggestionService.getSuggestionsForAgent.mockReturnValue({ suggestions: [] });

      const reply = mockReply();
      await routes.get("POST /daemon/tasks/claim-next")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          body: { agentId: AG1, habitatId: HAB },
        } as any,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(204);
    });

    it("returns 204 when daemon is at max concurrency", async () => {
      mocks.daemonRepo.isAgentOwnedByDaemon.mockReturnValue(true);
      mocks.habitatRepo.getHabitatById.mockReturnValue({ id: HAB });
      mocks.daemonRepo.getActiveSessionsByDaemonId.mockReturnValue([
        { id: "s1", agentId: AG2 },
        { id: "s2", agentId: "agent-3" },
      ]);

      const reply = mockReply();
      await routes.get("POST /daemon/tasks/claim-next")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 2 },
          body: { agentId: AG1, habitatId: HAB },
        } as any,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(204);
      expect(mocks.suggestionService.getSuggestionsForAgent).not.toHaveBeenCalled();
    });

    it("returns 204 when the daemon agent already has an active session", async () => {
      mocks.daemonRepo.isAgentOwnedByDaemon.mockReturnValue(true);
      mocks.habitatRepo.getHabitatById.mockReturnValue({ id: HAB });
      mocks.daemonRepo.getActiveSessionsByDaemonId.mockReturnValue([{ id: "s1", agentId: AG1 }]);

      const reply = mockReply();
      await routes.get("POST /daemon/tasks/claim-next")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          body: { agentId: AG1, habitatId: HAB },
        } as any,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(204);
      expect(mocks.suggestionService.getSuggestionsForAgent).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /daemon/sessions/:id", () => {
    it("updates session status", async () => {
      mocks.daemonRepo.getSessionById.mockReturnValue({ id: SESS, daemonId: D1 });
      mocks.daemonRepo.updateSessionStatus.mockReturnValue({ id: SESS, status: "running" });

      const reply = mockReply();
      const result = await routes.get("PATCH /daemon/sessions/:id")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          params: { id: SESS },
          body: { status: "running", lastProgress: "halfway done" },
        } as any,
        reply,
      );

      expect(mocks.daemonRepo.updateSessionStatus).toHaveBeenCalledWith(
        SESS,
        "running",
        "halfway done",
      );
      expect(result.session.status).toBe("running");
    });

    it("persists progress fields alongside status updates", async () => {
      mocks.daemonRepo.getSessionById.mockReturnValue({ id: SESS, daemonId: D1 });
      mocks.daemonRepo.updateSessionStatus.mockReturnValue({ id: SESS, status: "running" });
      mocks.daemonRepo.updateSessionProgress.mockReturnValue({
        id: SESS,
        status: "running",
        pid: 123,
        workdir: "/tmp/workdir",
        cliSessionId: "cli-1",
      });

      const result = await routes.get("PATCH /daemon/sessions/:id")!.handler(
        {
          daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
          params: { id: SESS },
          body: {
            status: "running",
            pid: 123,
            workdir: "/tmp/workdir",
            cliSessionId: "cli-1",
          },
        } as any,
        mockReply(),
      );

      expect(mocks.daemonRepo.updateSessionStatus).toHaveBeenCalledWith(SESS, "running", undefined);
      expect(mocks.daemonRepo.updateSessionProgress).toHaveBeenCalledWith(
        SESS,
        expect.objectContaining({ pid: 123, workdir: "/tmp/workdir", cliSessionId: "cli-1" }),
      );
      expect(result.session.workdir).toBe("/tmp/workdir");
    });

    it("returns 404 for missing session", async () => {
      mocks.daemonRepo.getSessionById.mockReturnValue(null);
      const reply = mockReply();

      await expect(
        routes.get("PATCH /daemon/sessions/:id")!.handler(
          {
            daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
            params: { id: "missing" },
            body: { status: "running" },
          } as any,
          reply,
        ),
      ).rejects.toThrow("Session not found");
    });

    it("rejects session belonging to another daemon", async () => {
      mocks.daemonRepo.getSessionById.mockReturnValue({ id: SESS, daemonId: "other-daemon" });
      const reply = mockReply();

      await expect(
        routes.get("PATCH /daemon/sessions/:id")!.handler(
          {
            daemon: { id: D1, name: "ws", hostname: "h", status: "online", maxConcurrent: 4 },
            params: { id: SESS },
            body: { status: "running" },
          } as any,
          reply,
        ),
      ).rejects.toThrow("Session does not belong to this daemon");
    });
  });
});
