import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { registerErrorHandler } from "../errors/plugin.js";

vi.mock("../services/workflowService.js", () => ({
  manualUnblockGate: vi.fn(),
  attachWorkflow: vi.fn(),
  getWorkflowById: vi.fn(),
  getWorkflowForMission: vi.fn(),
  getWorkflowShape: vi.fn(),
  updateWorkflow: vi.fn(),
  detachWorkflow: vi.fn(),
  getFailureContextsForWorkflow: vi.fn(),
  getTaskWorkflowContext: vi.fn(),
}));

vi.mock("../services/failureContextService.js", () => ({
  getFailureContext: vi.fn(),
}));

vi.mock("../repositories/feature.js", () => ({
  getMissionById: vi.fn(),
}));

import { workflowRoutes } from "../routes/workflow.js";
import {
  manualUnblockGate,
  attachWorkflow,
  getWorkflowById,
  getWorkflowForMission,
  getWorkflowShape,
  updateWorkflow,
  detachWorkflow,
  getFailureContextsForWorkflow,
  getTaskWorkflowContext,
} from "../services/workflowService.js";
import { getFailureContext } from "../services/failureContextService.js";
import { getMissionById } from "../repositories/feature.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function adminToken(): string {
  return makeToken({ sub: "admin-1", username: "admin", role: "admin" });
}

function viewerToken(): string {
  return makeToken({ sub: "viewer-1", username: "viewer", role: "viewer" });
}

async function buildApp(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(f);
  await f.register(workflowRoutes);
  await f.ready();
  return f;
}

const VALID_DEFINITION = {
  gates: [
    {
      upstreamTaskKey: "task_a",
      downstreamTaskKey: "task_b",
      gateType: "on_complete" as const,
    },
  ],
};

describe("workflowRoutes — POST /workflows/:id/gates/:gateId/unblock", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("satisfies the gate when an admin requests unblock", async () => {
    vi.mocked(manualUnblockGate).mockReturnValue(true);
    const token = adminToken();

    const res = await app.inject({
      method: "POST",
      url: "/workflows/wf-1/gates/gate-1/unblock",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ satisfied: true });
    expect(manualUnblockGate).toHaveBeenCalledWith("gate-1", "admin-1");
  });

  it("returns 403 when a non-admin requests unblock", async () => {
    const token = viewerToken();

    const res = await app.inject({
      method: "POST",
      url: "/workflows/wf-1/gates/gate-1/unblock",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(manualUnblockGate).not.toHaveBeenCalled();
  });

  it("returns 401 when no auth token is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workflows/wf-1/gates/gate-1/unblock",
    });

    expect(res.statusCode).toBe(401);
    expect(manualUnblockGate).not.toHaveBeenCalled();
  });

  it("returns 404 when the gate does not exist", async () => {
    vi.mocked(manualUnblockGate).mockReturnValue(false);
    const token = adminToken();

    const res = await app.inject({
      method: "POST",
      url: "/workflows/wf-1/gates/nonexistent/unblock",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 idempotently when the gate is already satisfied", async () => {
    vi.mocked(manualUnblockGate).mockReturnValue(true);
    const token = adminToken();

    const res1 = await app.inject({
      method: "POST",
      url: "/workflows/wf-1/gates/gate-1/unblock",
      headers: { authorization: `Bearer ${token}` },
    });
    const res2 = await app.inject({
      method: "POST",
      url: "/workflows/wf-1/gates/gate-1/unblock",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(manualUnblockGate).toHaveBeenCalledTimes(2);
  });
});

describe("workflowRoutes — POST /missions/:id/workflow (attach)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("attaches a workflow and returns 201 with the workflow row", async () => {
    vi.mocked(getMissionById).mockReturnValue({
      id: "mission-1",
      habitatId: "hab-1",
      title: "M",
    } as unknown as never);
    vi.mocked(attachWorkflow).mockReturnValue("wf-new");
    vi.mocked(getWorkflowById).mockReturnValue({
      id: "wf-new",
      missionId: "mission-1",
      habitatId: "hab-1",
      status: "active",
      version: 1,
    } as unknown as never);

    const res = await app.inject({
      method: "POST",
      url: "/missions/mission-1/workflow",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { definition: VALID_DEFINITION },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.workflow.id).toBe("wf-new");
    expect(attachWorkflow).toHaveBeenCalledWith(
      "mission-1",
      "hab-1",
      expect.objectContaining({ gates: expect.any(Array) }),
      {},
      "admin-1",
    );
  });

  it("returns 404 when the mission does not exist", async () => {
    vi.mocked(getMissionById).mockReturnValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/missions/nope/workflow",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { definition: VALID_DEFINITION },
    });

    expect(res.statusCode).toBe(404);
    expect(attachWorkflow).not.toHaveBeenCalled();
  });

  it("returns 400 when the definition has no gates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/missions/mission-1/workflow",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { definition: { gates: [] } },
    });

    expect(res.statusCode).toBe(400);
    expect(attachWorkflow).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/missions/mission-1/workflow",
      headers: { authorization: `Bearer ${viewerToken()}` },
      payload: { definition: VALID_DEFINITION },
    });

    expect(res.statusCode).toBe(403);
    expect(attachWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflowRoutes — GET /missions/:id/workflow (shape)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the workflow + gates for a mission with an active workflow", async () => {
    vi.mocked(getMissionById).mockReturnValue({
      id: "m1",
      habitatId: "h1",
    } as unknown as never);
    vi.mocked(getWorkflowForMission).mockReturnValue({
      id: "wf-1",
      missionId: "m1",
      status: "active",
      version: 3,
    } as unknown as never);
    vi.mocked(getWorkflowShape).mockReturnValue([
      { id: "gate-1", satisfied: false },
    ] as unknown as never);

    const res = await app.inject({
      method: "GET",
      url: "/missions/m1/workflow",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workflow.id).toBe("wf-1");
    expect(body.gates).toHaveLength(1);
  });

  it("returns 404 when no workflow is attached", async () => {
    vi.mocked(getMissionById).mockReturnValue({
      id: "m1",
      habitatId: "h1",
    } as unknown as never);
    vi.mocked(getWorkflowForMission).mockReturnValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/missions/m1/workflow",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for a non-admin viewer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/missions/m1/workflow",
      headers: { authorization: `Bearer ${viewerToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(getWorkflowForMission).not.toHaveBeenCalled();
  });
});

describe("workflowRoutes — PATCH /workflows/:id (OCC update)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("updates the workflow when expectedVersion matches", async () => {
    vi.mocked(updateWorkflow).mockReturnValue({
      ok: true,
      workflow: { id: "wf-1", version: 2, failureHandler: null },
    } as unknown as never);

    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf-1",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { expectedVersion: 1, failureHandler: null },
    });

    expect(res.statusCode).toBe(200);
    expect(updateWorkflow).toHaveBeenCalledWith(
      "wf-1",
      { failureHandler: null, joinSpecs: undefined },
      1,
    );
  });

  it("returns 409 with currentVersion on version mismatch", async () => {
    vi.mocked(updateWorkflow).mockReturnValue({
      ok: false,
      reason: "version_mismatch",
      currentVersion: 5,
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf-1",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { expectedVersion: 1 },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.details).toEqual({ currentVersion: 5 });
  });

  it("returns 404 when the workflow does not exist", async () => {
    vi.mocked(updateWorkflow).mockReturnValue({ ok: false, reason: "not_found" });

    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/nope",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { expectedVersion: 1 },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when expectedVersion is missing", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf-1",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { failureHandler: null },
    });

    expect(res.statusCode).toBe(400);
    expect(updateWorkflow).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin viewer", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf-1",
      headers: { authorization: `Bearer ${viewerToken()}` },
      payload: { expectedVersion: 1 },
    });

    expect(res.statusCode).toBe(403);
    expect(updateWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflowRoutes — DELETE /workflows/:id (detach)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("detaches the workflow and returns 200", async () => {
    vi.mocked(getWorkflowById).mockReturnValue({
      id: "wf-1",
      status: "active",
      version: 1,
    } as unknown as never);

    const res = await app.inject({
      method: "DELETE",
      url: "/workflows/wf-1",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ detached: true });
    expect(detachWorkflow).toHaveBeenCalledWith("wf-1", "admin-1");
  });

  it("returns 404 when the workflow does not exist", async () => {
    vi.mocked(getWorkflowById).mockReturnValue(null);

    const res = await app.inject({
      method: "DELETE",
      url: "/workflows/nope",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(404);
    expect(detachWorkflow).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin viewer", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/workflows/wf-1",
      headers: { authorization: `Bearer ${viewerToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(detachWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflowRoutes — GET /workflows/:id/failure-contexts", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the list of failure contexts for the workflow", async () => {
    vi.mocked(getWorkflowById).mockReturnValue({
      id: "wf-1",
      status: "active",
    } as unknown as never);
    vi.mocked(getFailureContextsForWorkflow).mockReturnValue([
      { id: "ctx-1", failedTaskId: "t1", failureKind: "lifecycle_failed" },
    ] as unknown as never);

    const res = await app.inject({
      method: "GET",
      url: "/workflows/wf-1/failure-contexts",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.failureContexts).toHaveLength(1);
    expect(body.failureContexts[0].id).toBe("ctx-1");
  });

  it("returns an empty list when the workflow has no failure contexts", async () => {
    vi.mocked(getWorkflowById).mockReturnValue({
      id: "wf-1",
      status: "active",
    } as unknown as never);
    vi.mocked(getFailureContextsForWorkflow).mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: "/workflows/wf-1/failure-contexts",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).failureContexts).toEqual([]);
  });

  it("returns 404 when the workflow does not exist", async () => {
    vi.mocked(getWorkflowById).mockReturnValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/workflows/nope/failure-contexts",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(404);
    expect(getFailureContextsForWorkflow).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin viewer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/workflows/wf-1/failure-contexts",
      headers: { authorization: `Bearer ${viewerToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(getFailureContextsForWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflowRoutes — GET /tasks/:id/failure-context", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the failure context when one exists (agent auth)", async () => {
    const mockCtx = { id: "ctx-1", failedTaskId: "task-1", failureKind: "lifecycle_failed" };
    vi.mocked(getFailureContext).mockReturnValue(mockCtx as any);

    const res = await app.inject({
      method: "GET",
      url: "/tasks/task-1/failure-context",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(getFailureContext).toHaveBeenCalledWith("task-1");
    expect(JSON.parse(res.body).failureContext).toEqual(mockCtx);
  });

  it("returns 404 when no failure context exists", async () => {
    vi.mocked(getFailureContext).mockReturnValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/tasks/no-ctx/failure-context",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/no failure context/i);
  });

  it("returns 401 when no auth header is provided", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/tasks/task-1/failure-context",
    });

    expect(res.statusCode).toBe(401);
    expect(getFailureContext).not.toHaveBeenCalled();
  });
});

describe("workflowRoutes — GET /tasks/:id/workflow-context", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns upstream and downstream gates when task is in a workflow", async () => {
    vi.mocked(getTaskWorkflowContext).mockReturnValue({
      upstream: [{ id: "gate-1", gateType: "on_complete", satisfied: true }],
      downstream: [{ id: "gate-2", gateType: "on_approve", satisfied: false }],
    } as any);

    const res = await app.inject({
      method: "GET",
      url: "/tasks/task-1/workflow-context",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(getTaskWorkflowContext).toHaveBeenCalledWith("task-1");
    const body = JSON.parse(res.body);
    expect(body.upstream).toHaveLength(1);
    expect(body.downstream).toHaveLength(1);
  });

  it("returns 404 when task is not part of any workflow", async () => {
    vi.mocked(getTaskWorkflowContext).mockReturnValue({ upstream: [], downstream: [] } as any);

    const res = await app.inject({
      method: "GET",
      url: "/tasks/orphan/workflow-context",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/not part of any workflow/i);
  });

  it("returns 401 when no auth header is provided", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/tasks/task-1/workflow-context",
    });

    expect(res.statusCode).toBe(401);
    expect(getTaskWorkflowContext).not.toHaveBeenCalled();
  });
});
