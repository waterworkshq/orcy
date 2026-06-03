import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  daemonRepo: {
    listDaemons: vi.fn(),
    getDaemonById: vi.fn(),
    getDaemonAgentsByDaemonId: vi.fn(),
    getActiveSessionsByDaemonId: vi.fn(),
  },
  daemonEngine: {
    register: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    detectClisOnHost: vi.fn(),
    isRunning: vi.fn(),
  },
  habitatRepo: {
    listHabitats: vi.fn(),
  },
}));

vi.mock("../repositories/daemon.js", () => mocks.daemonRepo);
vi.mock("../repositories/board.js", () => mocks.habitatRepo);
vi.mock("../services/daemonEngine.js", () => mocks.daemonEngine);
vi.mock("../services/agentService.js", () => ({ createAgent: vi.fn() }));
vi.mock("../services/tasks/index.js", () => ({ claimTask: vi.fn() }));
vi.mock("../services/taskSuggestion.js", () => ({ getSuggestionsForAgent: vi.fn() }));
vi.mock("../lib/daemonToken.js", () => ({
  generateDaemonToken: () => "daemon-test-token-1234",
}));
vi.mock("../middleware/daemonAuth.js", () => ({
  daemonAuth: async () => {},
}));
vi.mock("../middleware/auth.js", () => ({
  registrationAuth: async () => {},
  humanAuth: async (req: any) => {
    req.user = { id: "user-1", role: "admin" };
  },
}));
vi.mock("../middleware/rbac.js", () => ({
  adminOnly: async (req: any) => {
    if (req.user?.role !== "admin") {
      throw Object.assign(new Error("Insufficient permissions"), { statusCode: 403 });
    }
  },
}));
vi.mock("../errors.js", () => ({
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = "AppError";
    }
  },
  badRequest: (msg: string) => Object.assign(new Error(msg), { statusCode: 400 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { statusCode: 404 }),
  forbidden: (msg: string) => Object.assign(new Error(msg), { statusCode: 403 }),
  conflict: (msg: string) => Object.assign(new Error(msg), { statusCode: 409 }),
  unauthorized: (msg: string) => Object.assign(new Error(msg), { statusCode: 401 }),
}));

import { daemonAdminRoutes } from "../routes/daemon.js";
import type { FastifyInstance } from "fastify";

const D1 = "00000000-0000-0000-0000-000000000001";
const HAB = "00000000-0000-0000-0000-000000000010";

function captureAdminRoutes(): Map<string, { handler: Function; preHandler?: any[] }> {
  const routes = new Map<string, { handler: Function; preHandler?: any[] }>();
  const fake = {
    get: vi.fn((path: string, opts: any, handler?: Function) => {
      routes.set(`GET ${path}`, { handler: handler ?? opts, preHandler: opts?.preHandler });
    }),
    post: vi.fn((path: string, opts: any, handler?: Function) => {
      routes.set(`POST ${path}`, { handler: handler ?? opts, preHandler: opts?.preHandler });
    }),
    patch: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  } as unknown as FastifyInstance;
  daemonAdminRoutes(fake);
  return routes;
}

function mockReply() {
  const reply: any = { code: vi.fn(() => reply), send: vi.fn(() => reply) };
  return reply;
}

describe("daemonAdminRoutes", () => {
  let routes: Map<string, { handler: Function; preHandler?: any[] }>;

  beforeEach(() => {
    vi.clearAllMocks();
    routes = captureAdminRoutes();
  });

  it("protects every human daemon route with admin authorization", async () => {
    for (const route of routes.values()) {
      expect(route.preHandler).toHaveLength(2);
      const req: any = {};
      await route.preHandler![0](req);
      expect(req.user.role).toBe("admin");

      await expect(
        route.preHandler![1]({ user: { id: "viewer-1", role: "viewer" } }),
      ).rejects.toThrow("Insufficient permissions");
    }
  });

  describe("GET /daemons", () => {
    it("returns empty list when no daemons", async () => {
      mocks.daemonRepo.listDaemons.mockReturnValue([]);
      const handler = routes.get("GET /daemons")!.handler;
      const result = await handler({});
      expect(result.daemons).toEqual([]);
    });

    it("returns daemons with derived status", async () => {
      mocks.daemonRepo.listDaemons.mockReturnValue([
        {
          id: D1,
          name: "test-daemon",
          hostname: "localhost",
          status: "online",
          maxConcurrent: 4,
          lastHeartbeatAt: new Date().toISOString(),
          createdAt: "2026-01-01T00:00:00Z",
        },
      ]);
      mocks.daemonRepo.getDaemonAgentsByDaemonId.mockReturnValue([
        { agentId: "agent-1", cliType: "claude-code" },
      ]);
      mocks.daemonRepo.getActiveSessionsByDaemonId.mockReturnValue([]);
      mocks.daemonEngine.isRunning.mockReturnValue(true);

      const handler = routes.get("GET /daemons")!.handler;
      const result = await handler({});

      expect(result.daemons).toHaveLength(1);
      expect(result.daemons[0].name).toBe("test-daemon");
      expect(result.daemons[0].status).toBe("online");
      expect(result.daemons[0].agentCount).toBe(1);
      expect(result.daemons[0].activeSessionCount).toBe(0);
    });
  });

  describe("GET /daemons/:id", () => {
    it("returns 404 for missing daemon", async () => {
      mocks.daemonRepo.getDaemonById.mockReturnValue(null);
      const handler = routes.get("GET /daemons/:id")!.handler;

      await expect(handler({ params: { id: "missing" } })).rejects.toThrow("Daemon not found");
    });

    it("returns daemon detail with agents and sessions", async () => {
      mocks.daemonRepo.getDaemonById.mockReturnValue({
        id: D1,
        name: "test-daemon",
        hostname: "localhost",
        status: "online",
        maxConcurrent: 4,
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      mocks.daemonRepo.getDaemonAgentsByDaemonId.mockReturnValue([
        {
          agentId: "agent-1",
          cliType: "claude-code",
          cliVersion: "1.0",
          cliPath: "/usr/bin/claude",
          status: "idle",
        },
      ]);
      mocks.daemonRepo.getActiveSessionsByDaemonId.mockReturnValue([]);
      mocks.daemonEngine.isRunning.mockReturnValue(false);

      const handler = routes.get("GET /daemons/:id")!.handler;
      const result = await handler({ params: { id: D1 } });

      expect(result.daemon.id).toBe(D1);
      expect(result.agents).toHaveLength(1);
      expect(result.activeSessions).toHaveLength(0);
    });
  });

  describe("POST /daemons/register", () => {
    it("returns 400 when name is missing", async () => {
      const handler = routes.get("POST /daemons/register")!.handler;
      await expect(handler({ body: { habitatIds: [HAB] } })).rejects.toThrow(
        "name and habitatIds are required",
      );
    });

    it("returns 400 when habitatIds is empty", async () => {
      const handler = routes.get("POST /daemons/register")!.handler;
      await expect(handler({ body: { name: "test", habitatIds: [] } })).rejects.toThrow(
        "name and habitatIds are required",
      );
    });

    it("registers a daemon and returns agents", async () => {
      mocks.daemonEngine.register.mockReturnValue({
        daemonId: D1,
        agents: [
          { id: "agent-1", name: "daemon-test-claude-code", type: "claude-code", apiKey: "key-1" },
        ],
      });

      const handler = routes.get("POST /daemons/register")!.handler;
      const reply = mockReply();
      const result = await handler({ body: { name: "test", habitatIds: [HAB] } }, reply);

      expect(mocks.daemonEngine.register).toHaveBeenCalledWith("test", [HAB], undefined, undefined);
      expect(reply.code).toHaveBeenCalledWith(201);
      expect(result.daemonId).toBe(D1);
      expect(result.agents).toHaveLength(1);
    });
  });

  describe("POST /daemons/:id/start", () => {
    it("returns 404 for missing daemon", async () => {
      mocks.daemonRepo.getDaemonById.mockReturnValue(null);
      const handler = routes.get("POST /daemons/:id/start")!.handler;
      await expect(handler({ params: { id: "missing" } })).rejects.toThrow("Daemon not found");
    });

    it("starts a daemon engine", async () => {
      mocks.daemonRepo.getDaemonById.mockReturnValue({ id: D1 });
      mocks.daemonEngine.isRunning.mockReturnValue(false);

      const handler = routes.get("POST /daemons/:id/start")!.handler;
      const result = await handler({ params: { id: D1 }, body: {} });

      expect(mocks.daemonEngine.start).toHaveBeenCalledWith(D1, undefined);
      expect(result.status).toBe("started");
    });

    it("returns already_running if daemon is running", async () => {
      mocks.daemonRepo.getDaemonById.mockReturnValue({ id: D1 });
      mocks.daemonEngine.isRunning.mockReturnValue(true);

      const handler = routes.get("POST /daemons/:id/start")!.handler;
      const result = await handler({ params: { id: D1 }, body: {} });

      expect(mocks.daemonEngine.start).not.toHaveBeenCalled();
      expect(result.status).toBe("already_running");
    });
  });

  describe("POST /daemons/:id/stop", () => {
    it("returns 404 for missing daemon", async () => {
      mocks.daemonRepo.getDaemonById.mockReturnValue(null);
      const handler = routes.get("POST /daemons/:id/stop")!.handler;
      await expect(handler({ params: { id: "missing" } })).rejects.toThrow("Daemon not found");
    });

    it("stops a daemon engine", async () => {
      mocks.daemonRepo.getDaemonById.mockReturnValue({ id: D1 });

      const handler = routes.get("POST /daemons/:id/stop")!.handler;
      const result = await handler({ params: { id: D1 } });

      expect(mocks.daemonEngine.stop).toHaveBeenCalledWith(D1);
      expect(result.status).toBe("stopped");
    });
  });

  describe("GET /daemons/detect-clis", () => {
    it("returns detected CLIs", async () => {
      mocks.daemonEngine.detectClisOnHost.mockReturnValue([
        { type: "claude-code", version: "1.0.0", path: "/usr/bin/claude" },
      ]);

      const handler = routes.get("GET /daemons/detect-clis")!.handler;
      const result = await handler({});

      expect(result.clis).toHaveLength(1);
      expect(result.clis[0].type).toBe("claude-code");
    });

    it("returns empty array when no CLIs found", async () => {
      mocks.daemonEngine.detectClisOnHost.mockReturnValue([]);

      const handler = routes.get("GET /daemons/detect-clis")!.handler;
      const result = await handler({});

      expect(result.clis).toEqual([]);
    });
  });
});
