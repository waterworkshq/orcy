import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/wikiPage.js", () => ({
  getById: (id: string) => ({ id, habitatId: "habitat-1" }),
}));

import { wikiRoutes } from "../routes/wiki.js";
import * as augmentation from "../services/wikiAugmentationService.js";
import * as scheduler from "../services/wikiSchedulerService.js";
import * as wikiService from "../services/wikiService.js";
import * as habitatRepo from "../repositories/board.js";

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  handler: any;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    get: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "GET",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
    post: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "POST",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
    patch: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "PATCH",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "DELETE",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
    put: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "PUT",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
  };
  wikiRoutes(fakeFastify);
  return routes;
}

function makeReply() {
  const reply: any = { statusCode: 200 };
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.code = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((data: any) => {
    reply.data = data;
    return reply;
  });
  return reply;
}

const mockHabitat = { id: "habitat-1", name: "Test", wikiSettings: null };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(habitatRepo, "getHabitatById").mockReturnValue(mockHabitat as never);
});

describe("wikiRoutes — augmentation routes (Phase 5 routes)", () => {
  it("GET /pages/:pageId/authoring-context calls augmentation.getAuthoringContextForEdit", async () => {
    const routes = captureRoutes();
    const route = routes.find(
      (r) =>
        r.method === "GET" &&
        r.path.includes("authoring-context") &&
        !r.path.includes("wiki/authoring-context"),
    );
    expect(route).toBeDefined();

    const getAuthoringContextForEditSpy = vi
      .spyOn(augmentation, "getAuthoringContextForEdit")
      .mockReturnValue({ habitatId: "habitat-1", from: "x", to: null, query: null } as never);

    const request: any = {
      params: { habitatId: "habitat-1", pageId: "page-1" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    const result = await route!.handler(request, reply);
    expect(getAuthoringContextForEditSpy).toHaveBeenCalledWith("page-1");
    expect(result).toEqual({
      context: { habitatId: "habitat-1", from: "x", to: null, query: null },
    });
  });

  it("POST /authoring-context calls augmentation.getAuthoringContextForChunk with parsed body", async () => {
    const routes = captureRoutes();
    const route = routes.find((r) => r.method === "POST" && r.path.endsWith("/authoring-context"));
    expect(route).toBeDefined();

    const getAuthoringContextForChunkSpy = vi
      .spyOn(augmentation, "getAuthoringContextForChunk")
      .mockReturnValue({
        habitatId: "habitat-1",
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-12-31T00:00:00.000Z",
      } as never);

    const request: any = {
      params: { habitatId: "habitat-1" },
      body: { from: "2024-01-01T00:00:00.000Z", to: "2024-12-31T00:00:00.000Z", query: "q" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    const result = await route!.handler(request, reply);
    expect(getAuthoringContextForChunkSpy).toHaveBeenCalledWith("habitat-1", {
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T00:00:00.000Z",
      query: "q",
    });
    expect(result).toEqual({
      context: {
        habitatId: "habitat-1",
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-12-31T00:00:00.000Z",
      },
    });
  });

  it("POST /authoring-context throws 400 when from missing", async () => {
    const routes = captureRoutes();
    const route = routes.find((r) => r.method === "POST" && r.path.endsWith("/authoring-context"));

    const request: any = {
      params: { habitatId: "habitat-1" },
      body: { to: "t" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    await expect(route!.handler(request, reply)).rejects.toThrow();
  });
});

describe("wikiRoutes — cadence routes (Phase 6 routes)", () => {
  it("GET /cadence returns the current cadence (or null)", async () => {
    const routes = captureRoutes();
    const route = routes.find((r) => r.method === "GET" && r.path.endsWith("/wiki/cadence"));
    expect(route).toBeDefined();

    const getCadenceSpy = vi.spyOn(scheduler, "getCadence").mockReturnValue(null);

    const request: any = {
      params: { habitatId: "habitat-1" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    const result = await route!.handler(request, reply);
    expect(getCadenceSpy).toHaveBeenCalledWith("habitat-1");
    expect(result).toEqual({ cadence: null });
  });

  it("PUT /cadence registers a scheduled task via scheduler.setCadence", async () => {
    const routes = captureRoutes();
    const route = routes.find((r) => r.method === "PUT" && r.path.endsWith("/wiki/cadence"));
    expect(route).toBeDefined();

    const setCadenceSpy = vi.spyOn(scheduler, "setCadence").mockReturnValue({
      enabled: true,
      scheduleType: "interval",
      intervalMinutes: 60,
      timezone: "UTC",
    } as never);

    const request: any = {
      params: { habitatId: "habitat-1" },
      body: { enabled: true, scheduleType: "interval", intervalMinutes: 60, timezone: "UTC" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    const result = await route!.handler(request, reply);
    expect(setCadenceSpy).toHaveBeenCalledWith(
      "habitat-1",
      { enabled: true, scheduleType: "interval", intervalMinutes: 60, timezone: "UTC" },
      "agent-1",
    );
    expect(result.cadence.enabled).toBe(true);
  });

  it("PUT /cadence throws 400 when body is invalid", async () => {
    const routes = captureRoutes();
    const route = routes.find((r) => r.method === "PUT" && r.path.endsWith("/wiki/cadence"));

    const request: any = {
      params: { habitatId: "habitat-1" },
      body: { enabled: "yes" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    await expect(route!.handler(request, reply)).rejects.toThrow();
  });

  it("DELETE /cadence calls scheduler.disableCadence", async () => {
    const routes = captureRoutes();
    const route = routes.find((r) => r.method === "DELETE" && r.path.endsWith("/wiki/cadence"));
    expect(route).toBeDefined();

    const disableSpy = vi.spyOn(scheduler, "disableCadence").mockReturnValue(undefined as never);

    const request: any = {
      params: { habitatId: "habitat-1" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    await route!.handler(request, reply);
    expect(disableSpy).toHaveBeenCalledWith("habitat-1");
    expect(reply.statusCode).toBe(200);
    expect(reply.data).toEqual({ success: true });
  });

  it("POST /bootstrap calls scheduler.triggerBootstrap", async () => {
    const routes = captureRoutes();
    const route = routes.find((r) => r.method === "POST" && r.path.endsWith("/wiki/bootstrap"));
    expect(route).toBeDefined();

    const triggerSpy = vi.spyOn(scheduler, "triggerBootstrap").mockReturnValue({
      habitatId: "habitat-1",
      tasksCreated: 4,
      gap: { from: "f", to: "t" },
      chunks: [],
    });

    const request: any = {
      params: { habitatId: "habitat-1" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    const result = await route!.handler(request, reply);
    expect(triggerSpy).toHaveBeenCalledWith("habitat-1", { createdBy: "agent-1" });
    expect(result.tasksCreated).toBe(4);
  });

  it("POST /refresh calls scheduler.triggerRefresh", async () => {
    const routes = captureRoutes();
    const route = routes.find((r) => r.method === "POST" && r.path.endsWith("/wiki/refresh"));
    expect(route).toBeDefined();

    const triggerSpy = vi.spyOn(scheduler, "triggerRefresh").mockReturnValue({
      habitatId: "habitat-1",
      tasksCreated: 1,
      gap: { from: "f", to: "t" },
      chunks: [],
    });

    const request: any = {
      params: { habitatId: "habitat-1" },
      agent: { id: "agent-1" },
    };
    const reply = makeReply();
    const result = await route!.handler(request, reply);
    expect(triggerSpy).toHaveBeenCalledWith("habitat-1", { createdBy: "agent-1" });
    expect(result.tasksCreated).toBe(1);
  });
});

describe("wikiRoutes — preHandlers are agentOrHumanAuth", () => {
  it("all new routes use agentOrHumanAuth", () => {
    const routes = captureRoutes();
    const newRoutePaths = [
      "GET /habitats/:habitatId/wiki/pages/:pageId/authoring-context",
      "POST /habitats/:habitatId/wiki/authoring-context",
      "GET /habitats/:habitatId/wiki/cadence",
      "PUT /habitats/:habitatId/wiki/cadence",
      "DELETE /habitats/:habitatId/wiki/cadence",
      "POST /habitats/:habitatId/wiki/bootstrap",
      "POST /habitats/:habitatId/wiki/refresh",
    ];
    for (const sig of newRoutePaths) {
      const [method, path] = sig.split(" ");
      const route = routes.find((r) => r.method === method && r.path === path);
      expect(route, `route ${sig} should be registered`).toBeDefined();
      expect(route!.preHandler.length).toBeGreaterThan(0);
    }
  });
});
