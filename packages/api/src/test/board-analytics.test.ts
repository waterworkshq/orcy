import { describe, it, expect, vi } from "vitest";
import { habitatAnalyticsRoutes } from "../routes/board-analytics.js";
import { habitatRoutes } from "../routes/habitats.js";

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
}

function captureAnalyticsRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    get: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "GET",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
      });
    }),
  };
  habitatAnalyticsRoutes(fakeFastify);
  return routes;
}

function captureHabitatRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    get: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "GET",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
      });
    }),
  };
  habitatRoutes(fakeFastify);
  return routes;
}

describe("habitatAnalyticsRoutes", () => {
  it("exports a function named habitatAnalyticsRoutes", () => {
    expect(habitatAnalyticsRoutes).toBeInstanceOf(Function);
    expect(habitatAnalyticsRoutes.name).toBe("habitatAnalyticsRoutes");
  });

  it("registers 9 analytics endpoints", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes).toHaveLength(9);
  });

  it("registers GET /habitats/:habitatId/stats", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/stats")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/summary", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/summary")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/events", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/events")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/capacity", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/capacity")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/predictions", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/predictions")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/burndown", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/burndown")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/cumulative-flow", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/cumulative-flow")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/bottlenecks", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/bottlenecks")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/agent-quality", () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/agent-quality")).toBeDefined();
  });

  it("all analytics endpoints have auth + habitat access preHandlers", () => {
    const routes = captureAnalyticsRoutes();
    for (const route of routes) {
      expect(route.preHandler.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("habitats.ts no longer contains analytics handlers", () => {
  it("does not register /habitats/:habitatId/stats", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/stats")).toBeUndefined();
  });

  it("does not register /habitats/:habitatId/summary", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/summary")).toBeUndefined();
  });

  it("does not register /habitats/:habitatId/events", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/events")).toBeUndefined();
  });

  it("does not register /habitats/:habitatId/capacity", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/capacity")).toBeUndefined();
  });

  it("does not register /habitats/:habitatId/predictions", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/predictions")).toBeUndefined();
  });

  it("does not register /habitats/:habitatId/burndown", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/burndown")).toBeUndefined();
  });

  it("does not register /habitats/:habitatId/cumulative-flow", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/cumulative-flow")).toBeUndefined();
  });

  it("does not register /habitats/:habitatId/bottlenecks", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/bottlenecks")).toBeUndefined();
  });

  it("does not register /habitats/:habitatId/agent-quality", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/agent-quality")).toBeUndefined();
  });
});
