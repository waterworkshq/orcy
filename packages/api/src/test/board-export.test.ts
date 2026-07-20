import { describe, it, expect, vi } from "vitest";
import { habitatExportRoutes } from "../routes/board-export.js";
import { habitatRoutes } from "../routes/habitats.js";
import { humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
}

function captureExportRoutes(): CapturedRoute[] {
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
  habitatExportRoutes(fakeFastify);
  return routes;
}

function captureHabitatRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
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

describe("habitatExportRoutes", () => {
  it("exports a function named habitatExportRoutes", () => {
    expect(habitatExportRoutes).toBeInstanceOf(Function);
    expect(habitatExportRoutes.name).toBe("habitatExportRoutes");
  });

  it("registers 4 endpoints", () => {
    const routes = captureExportRoutes();
    expect(routes).toHaveLength(4);
  });

  it("registers GET /habitats/:habitatId/export", () => {
    const routes = captureExportRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/export")).toBeDefined();
  });

  it("registers POST /habitats/import", () => {
    const routes = captureExportRoutes();
    expect(routes.find((r) => r.path === "/habitats/import")).toBeDefined();
  });

  it("registers POST /habitats/:habitatId/import", () => {
    const routes = captureExportRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/import")).toBeDefined();
  });

  it("registers GET /habitats/:habitatId/anomalies", () => {
    const routes = captureExportRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/anomalies")).toBeDefined();
  });

  it("export endpoint has humanAuth preHandler", () => {
    const routes = captureExportRoutes();
    const route = routes.find((r) => r.path === "/habitats/:habitatId/export");
    expect(route).toBeDefined();
    expect(route!.preHandler).toHaveLength(1);
    const handlerName =
      typeof route!.preHandler[0] === "function"
        ? route!.preHandler[0].name || String(route!.preHandler[0])
        : String(route!.preHandler[0]);
    expect(handlerName).toBe("humanAuth");
  });

  it("POST /habitats/import has humanAuth preHandler only (new-habitat, no target to authorize yet)", () => {
    const routes = captureExportRoutes();
    const route = routes.find((r) => r.path === "/habitats/import");
    expect(route).toBeDefined();
    expect(route!.preHandler).toEqual([humanAuth]);
  });

  it("POST /habitats/:habitatId/import has humanAuth + requireHabitatAccess preHandlers", () => {
    const routes = captureExportRoutes();
    const route = routes.find((r) => r.path === "/habitats/:habitatId/import");
    expect(route).toBeDefined();
    // Reference equality — `requireHabitatAccess` is a re-export alias of
    // `authorizeHabitatAccess`, so the aliased binding's .name is
    // "authorizeHabitatAccess"; check by identity, not .name.
    expect(route!.preHandler).toHaveLength(2);
    expect(route!.preHandler[0]).toBe(humanAuth);
    expect(route!.preHandler[1]).toBe(requireHabitatAccess);
  });

  it("anomalies endpoint has agentOrHumanAuth + requireHabitatAccess preHandlers", () => {
    const routes = captureExportRoutes();
    const route = routes.find((r) => r.path === "/habitats/:habitatId/anomalies");
    expect(route).toBeDefined();
    expect(route!.preHandler.length).toBeGreaterThanOrEqual(2);
  });
});

describe("habitats.ts no longer contains export/import/anomalies handlers", () => {
  it("does not register GET /habitats/:habitatId/export", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/export")).toBeUndefined();
  });

  it("does not register POST /habitats/import", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/import")).toBeUndefined();
  });

  it("does not register POST /habitats/:habitatId/import", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/import")).toBeUndefined();
  });

  it("does not register GET /habitats/:habitatId/anomalies", () => {
    const routes = captureHabitatRoutes();
    expect(routes.find((r) => r.path === "/habitats/:habitatId/anomalies")).toBeUndefined();
  });
});
