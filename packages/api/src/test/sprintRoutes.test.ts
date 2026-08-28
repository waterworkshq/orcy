import { describe, expect, it, vi } from "vitest";
import { sprintRoutes } from "../routes/sprints.js";

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  authPolicy: any;
}

function captureSprintRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    addHook: vi.fn(),
    register: vi.fn(),
    withTypeProvider: vi.fn(() => fakeFastify),
    get: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "GET",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
        authPolicy: opts?.config?.authPolicy,
      });
    }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  sprintRoutes(fakeFastify);
  return routes;
}

describe("sprintRoutes", () => {
  it("registers sprint analytics endpoints", () => {
    const routes = captureSprintRoutes();

    expect(routes.find((route) => route.path === "/sprints/:id/metrics")).toBeDefined();
    expect(routes.find((route) => route.path === "/sprints/:id/burndown")).toBeDefined();
    expect(routes.find((route) => route.path === "/sprints/:id/carry-over")).toBeDefined();
  });

  it("protects sprint analytics endpoints with local_actor policy", () => {
    const routes = captureSprintRoutes().filter((route) =>
      ["/sprints/:id/metrics", "/sprints/:id/burndown", "/sprints/:id/carry-over"].includes(
        route.path,
      ),
    );

    expect(routes).toHaveLength(3);
    for (const route of routes) {
      expect(route.authPolicy).toBe("local_actor");
    }
  });
});
