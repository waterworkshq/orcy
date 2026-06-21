import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KanbanApiClient } from "../api.js";
import { RemoteMcpClient } from "../remote-client.js";
import { resetConfig } from "@orcy/shared";

/**
 * v0.19 Phase D — RemoteMcpClient integration test.
 *
 * Verifies the wrapper sends:
 * - X-Orcy-Remote-Key header (NOT X-Agent-API-Key)
 * - Idempotency-Key on write actions
 * - The correct HTTP method and path
 *
 * We override the private transport on a KanbanApiClient instance so we
 * can assert on what the wrapper passes to the transport. This is the
 * lowest-level seam that doesn't require a live HTTP server.
 */

function mockTransport(
  client: KanbanApiClient,
  fn: (method: string, path: string, options?: unknown) => Promise<unknown>,
) {
  (client as unknown as { transport: { request: typeof fn } }).transport = { request: fn };
}

describe("RemoteMcpClient — request shape", () => {
  const ORIGINAL_ENV = { ...process.env };
  let captured: Array<{ method: string; path: string; options: unknown }>;
  let client: KanbanApiClient;
  let remote: RemoteMcpClient;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.ORCY_REMOTE_KEY = "orcy_remote_test_abc";
    process.env.ORCY_API_URL = "https://orcy.example.com";
    resetConfig();
    captured = [];
    client = new KanbanApiClient("https://orcy.example.com");
    mockTransport(client, async (method, path, options) => {
      captured.push({ method, path, options });
      return { ok: true, captured: true };
    });
    remote = new RemoteMcpClient(client);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    resetConfig();
  });

  it("uses X-Orcy-Remote-Key and not X-Agent-API-Key", async () => {
    await remote.executeAllowed("habitats.get", { habitatId: "h-1" });
    expect(captured).toHaveLength(1);
    const opts = captured[0].options as { headers?: Record<string, string> } | undefined;
    expect(opts?.headers?.["X-Orcy-Remote-Key"]).toBe("orcy_remote_test_abc");
    expect(opts?.headers?.["X-Agent-API-Key"]).toBeUndefined();
  });

  it("does NOT add Idempotency-Key for GET", async () => {
    await remote.executeAllowed("habitats.get", { habitatId: "h-1" });
    const opts = captured[0].options as { headers?: Record<string, string> } | undefined;
    expect(opts?.headers?.["Idempotency-Key"]).toBeUndefined();
  });

  it("adds Idempotency-Key for POST write actions", async () => {
    await remote.executeAllowed("tasks.claim", { taskId: "t-1" });
    const opts = captured[0].options as { headers?: Record<string, string> } | undefined;
    expect(opts?.headers?.["Idempotency-Key"]).toMatch(/^mcp-/);
  });

  it("builds the correct path", async () => {
    await remote.executeAllowed("tasks.claim", { taskId: "abc-123" });
    expect(captured[0].path).toBe("/api/shared/tasks/abc-123/claim");
    expect(captured[0].method).toBe("POST");
  });

  it("sends the body for POST actions", async () => {
    await remote.executeAllowed(
      "tasks.submit",
      { taskId: "t-1" },
      {
        result: "Done",
        artifacts: [{ kind: "pr" }],
      },
    );
    const opts = captured[0].options as { body?: unknown } | undefined;
    expect(opts?.body).toEqual({
      result: "Done",
      artifacts: [{ kind: "pr" }],
    });
  });

  it("rejects unknown actions", async () => {
    await expect(remote.execute("nonexistent.action")).rejects.toThrow(/Unknown remote MCP action/);
    expect(captured).toHaveLength(0);
  });

  it("routes missions.getWorkflow to the correct /api/shared/ path", async () => {
    await remote.executeAllowed("missions.getWorkflow", { missionId: "m-wf" });
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].path).toBe("/api/shared/missions/m-wf/workflow");
    const opts = captured[0].options as { headers?: Record<string, string> } | undefined;
    expect(opts?.headers?.["X-Orcy-Remote-Key"]).toBe("orcy_remote_test_abc");
    // GET must not include Idempotency-Key
    expect(opts?.headers?.["Idempotency-Key"]).toBeUndefined();
  });

  it("routes tasks.getWorkflowContext to the correct /api/shared/ path", async () => {
    await remote.executeAllowed("tasks.getWorkflowContext", { taskId: "t-wf" });
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].path).toBe("/api/shared/tasks/t-wf/workflow-context");
  });

  it("accepts the new workflow actions via execute() (not just executeAllowed)", async () => {
    await remote.execute("missions.getWorkflow", { missionId: "m-2" });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/api/shared/missions/m-2/workflow");
  });
});
