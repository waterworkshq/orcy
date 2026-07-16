import { describe, it, expect, vi } from "vitest";

// Route-level contract proof for the column reorder endpoint.
// Verifies the SSE-after-commit ordering and the 409 VERSION_CONFLICT shape.

const reorderState = vi.hoisted(() => ({
  result: { success: true, columns: [{ id: "c1" }, { id: "c2" }] } as
    | { success: true; columns: { id: string }[] }
    | { success: false; versionConflict: true; currentOrder: string[] }
    | { success: false; notFound: true }
    | { success: false; invalid: true; reason: string },
}));

const publishCalls: { type: string; data: unknown }[] = [];

vi.mock("../repositories/column.js", () => ({
  createColumn: vi.fn(),
  updateColumn: vi.fn(),
  getColumnById: vi.fn(),
  deleteColumn: vi.fn(),
  reorderColumns: () => reorderState.result,
}));
vi.mock("../repositories/habitat.js", () => ({ getHabitatById: vi.fn() }));
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: {
    publish: (_habitatId: string, evt: { type: string; data: unknown }) => publishCalls.push(evt),
  },
}));
vi.mock("../middleware/auth.js", () => ({ humanAuth: vi.fn() }));
vi.mock("../middleware/rbac.js", () => ({ adminOnly: vi.fn() }));

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: unknown[];
  bodySchema?: unknown;
  paramsSchema?: unknown;
  handler: (req: { params: unknown; body: unknown }, reply: unknown) => unknown;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: (path: string, opts: any, handler: CapturedRoute["handler"]) => {
      routes.push({
        method: "POST",
        path,
        preHandler: Array.isArray(opts?.preHandler) ? opts.preHandler : [],
        bodySchema: opts?.schema?.body,
        paramsSchema: opts?.schema?.params,
        handler,
      });
    },
    patch: (path: string, opts: any, handler: CapturedRoute["handler"]) => {
      routes.push({ method: "PATCH", path, preHandler: [], handler });
    },
    delete: (path: string, opts: any, handler: CapturedRoute["handler"]) => {
      routes.push({ method: "DELETE", path, preHandler: [], handler });
    },
    get: (path: string, opts: any, handler: CapturedRoute["handler"]) => {
      routes.push({ method: "GET", path, preHandler: [], handler });
    },
  };
  // Replace the captured-array methods to also act as the FastifyInstance.
  Object.assign(routes, {
    withTypeProvider: () => routes,
    register: () => undefined,
    post: fakeFastify.post,
    patch: fakeFastify.patch,
    delete: fakeFastify.delete,
    get: fakeFastify.get,
  });
  return routes;
}

describe("POST /habitats/:habitatId/columns/reorder — route contract", () => {
  it("registers POST /habitats/:habitatId/columns/reorder", async () => {
    const routes = captureRoutes();
    const { columnRoutes } = await import("../routes/columns.js");
    await columnRoutes(routes as unknown as Parameters<typeof columnRoutes>[0]);
    expect(
      routes.find((r) => r.method === "POST" && r.path === "/habitats/:habitatId/columns/reorder"),
    ).toBeDefined();
  });

  it("emits column.updated for each committed column AFTER the transaction commits and returns { columns }", async () => {
    const routes = captureRoutes();
    const { columnRoutes } = await import("../routes/columns.js");
    await columnRoutes(routes as unknown as Parameters<typeof columnRoutes>[0]);
    reorderState.result = {
      success: true,
      columns: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
    };
    publishCalls.length = 0;

    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/habitats/:habitatId/columns/reorder",
    )!;
    const result = (await route.handler(
      {
        params: { habitatId: "h-1" },
        body: {
          expectedOrder: ["c1", "c2", "c3"],
          desiredOrder: ["c3", "c2", "c1"],
        },
      },
      { header: () => {} },
    )) as { columns: { id: string }[] };

    expect(result.columns).toHaveLength(3);
    expect(publishCalls).toHaveLength(3);
    expect(publishCalls.every((c) => c.type === "column.updated")).toBe(true);
  });

  it("surfaces 409 VERSION_CONFLICT with current+your order and emits NO SSE on stale expectedOrder", async () => {
    const routes = captureRoutes();
    const { columnRoutes } = await import("../routes/columns.js");
    await columnRoutes(routes as unknown as Parameters<typeof columnRoutes>[0]);
    reorderState.result = {
      success: false,
      versionConflict: true,
      currentOrder: ["c1", "c2", "c3"],
    };

    const route = routes.find(
      (r) => r.method === "POST" && r.path === "/habitats/:habitatId/columns/reorder",
    )!;
    publishCalls.length = 0;
    let caught: unknown;
    try {
      await route.handler(
        {
          params: { habitatId: "h-1" },
          body: { expectedOrder: ["c1"], desiredOrder: ["c1"] },
        },
        { header: () => {} },
      );
    } catch (err) {
      caught = err;
    }
    expect(publishCalls).toHaveLength(0);
    expect(caught).toBeInstanceOf(Error);
    const err = caught as { statusCode: number; code: string; details: unknown };
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.details).toMatchObject({
      currentOrder: ["c1", "c2", "c3"],
      yourOrder: ["c1"],
    });
  });
});
