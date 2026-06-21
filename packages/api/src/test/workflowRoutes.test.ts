import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";

vi.mock("../services/workflowService.js", () => ({
  manualUnblockGate: vi.fn(),
}));

import { workflowRoutes } from "../routes/workflow.js";
import { manualUnblockGate } from "../services/workflowService.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function buildApp(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await f.register(workflowRoutes);
  await f.ready();
  return f;
}

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
    const token = makeToken({ sub: "admin-1", username: "admin", role: "admin" });

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
    const token = makeToken({ sub: "viewer-1", username: "viewer", role: "viewer" });

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
    const token = makeToken({ sub: "admin-1", username: "admin", role: "admin" });

    const res = await app.inject({
      method: "POST",
      url: "/workflows/wf-1/gates/nonexistent/unblock",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 200 idempotently when the gate is already satisfied", async () => {
    vi.mocked(manualUnblockGate).mockReturnValue(true);
    const token = makeToken({ sub: "admin-1", username: "admin", role: "admin" });

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
