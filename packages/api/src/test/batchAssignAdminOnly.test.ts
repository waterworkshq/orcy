import { describe, it, expect, vi } from "vitest";

vi.mock("../services/tasks/index.js", () => ({
  batchOperateTasks: vi.fn().mockReturnValue({
    successCount: 0,
    failureCount: 0,
    results: [],
  }),
}));

import { taskBatchRoutes } from "../routes/tasks/batch.js";
import { isAppError } from "../errors.js";
import type { BatchTaskInput } from "../models/schemas.js";

type RouteHandler = (req: any, reply: any) => Promise<void>;
interface CapturedRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

function captureBatchRoute(): RouteHandler {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    post: vi.fn((path: string, _opts: any, handler: any) => {
      routes.push({ method: "POST", path, handler });
    }),
  };
  taskBatchRoutes(fakeFastify);
  if (routes.length !== 1) throw new Error(`Expected 1 route, got ${routes.length}`);
  return routes[0].handler;
}

async function callHandler(
  handler: RouteHandler,
  request: any,
): Promise<{ code: number | null; body: any; error: AppErrorLike | null }> {
  const reply: any = {};
  try {
    await handler(request, reply);
    return { code: null, body: reply, error: null };
  } catch (err) {
    if (isAppError(err)) {
      return { code: err.statusCode, body: null, error: { message: err.message, code: err.code } };
    }
    throw err;
  }
}

interface AppErrorLike {
  message: string;
  code: string;
}

/**
 * T4 — Batch assign must be admin-only. Agents must use the canonical
 * `POST /tasks/:id/claim` path. Other operations (priority, delete) remain
 * agent-accessible via `agentOrHumanAuth`.
 */
describe("batch route — admin-only assign gate", () => {
  const handler = captureBatchRoute();
  const habitatId = "habitat-1";

  it("forbids agent caller for assign operation", async () => {
    const body: BatchTaskInput = {
      taskIds: ["task-1"],
      operation: "assign",
      payload: { assignedAgentId: "agent-1" },
    } as BatchTaskInput;

    const result = await callHandler(handler, {
      params: { habitatId },
      body,
      agent: { id: "agent-1" },
      user: undefined,
    });

    expect(result.code).toBe(403);
    expect(result.error?.message).toContain("admin-only");
  });

  it("allows human caller for assign operation", async () => {
    const body: BatchTaskInput = {
      taskIds: ["task-1"],
      operation: "assign",
      payload: { assignedAgentId: "agent-1" },
    } as BatchTaskInput;

    const result = await callHandler(handler, {
      params: { habitatId },
      body,
      agent: undefined,
      user: { id: "user-1", username: "admin", role: "admin", type: "human" },
    });

    expect(result.code).toBeNull();
  });

  it("allows agent caller for priority operation (non-assign unaffected)", async () => {
    const body: BatchTaskInput = {
      taskIds: ["task-1"],
      operation: "priority",
      payload: { priority: "critical" },
    } as BatchTaskInput;

    const result = await callHandler(handler, {
      params: { habitatId },
      body,
      agent: { id: "agent-1" },
      user: undefined,
    });

    expect(result.code).toBeNull();
  });

  it("allows agent caller for delete operation (non-assign unaffected)", async () => {
    const body: BatchTaskInput = {
      taskIds: ["task-1"],
      operation: "delete",
      payload: {},
    } as BatchTaskInput;

    const result = await callHandler(handler, {
      params: { habitatId },
      body,
      agent: { id: "agent-1" },
      user: undefined,
    });

    expect(result.code).toBeNull();
  });
});
