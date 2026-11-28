import { describe, expect, it, vi } from "vitest";
import { KanbanApiClient } from "../api.js";
import { ApiClientError } from "@orcy/shared";

function createClientWithRequestSpy() {
  const client = new KanbanApiClient("http://localhost:3000");
  const request = vi.fn(() => Promise.resolve({}));
  (client as unknown as { request: typeof request }).request = request;
  return { client, request };
}

describe("KanbanApiClient mission ID normalization", () => {
  it("normalizes mission IDs for mission code evidence writes", async () => {
    const { client, request } = createClientWithRequestSpy();

    await client.linkMissionCodeEvidence("feat-mission-1", {});
    await client.correctMissionEvidenceLink("feat-mission-1", "link-1", { reason: "wrong" });
    await client.markMissionEvidenceNotApplicable("feat-mission-1", { reasonCode: "no-code" });
    await client.reportMissionEvidenceGap("feat-mission-1", { reasonCode: "missing-ci" });
    await client.resolveMissionEvidenceGap("feat-mission-1", "gap-1", {
      resolutionReason: "fixed",
    });

    expect(request).toHaveBeenNthCalledWith(1, "POST", "/api/missions/mission-1/code-evidence", {});
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/api/missions/mission-1/code-evidence/link-1/correct",
      { reason: "wrong" },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "POST",
      "/api/missions/mission-1/code-evidence/not-applicable",
      { reasonCode: "no-code" },
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      "POST",
      "/api/missions/mission-1/code-evidence/gaps",
      { reasonCode: "missing-ci" },
    );
    expect(request).toHaveBeenNthCalledWith(
      5,
      "POST",
      "/api/missions/mission-1/code-evidence/gaps/gap-1/resolve",
      { resolutionReason: "fixed" },
    );
  });

  it("normalizes IDs for scoped audit bundle reads", async () => {
    const { client, request } = createClientWithRequestSpy();

    await client.getTaskAuditBundle("task-1", { includeHealthSnapshots: true });
    await client.getMissionAuditBundle("feat-mission-1", { includeHealthSnapshots: true });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "GET",
      "/api/tasks/task-1/audit/bundle?includeHealthSnapshots=true",
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET",
      "/api/missions/mission-1/audit/bundle?includeHealthSnapshots=true",
    );
  });
});

describe("KanbanApiClient audit provenance headers", () => {
  it("adds MCP tool context headers while a tool context is active", async () => {
    const client = new KanbanApiClient("http://localhost:3000");
    const request = vi.fn(() => Promise.resolve({ comment: {} }));
    (
      client as unknown as { getCredentials: () => { apiKey: string; agentId: string } }
    ).getCredentials = () => ({ apiKey: "api-key", agentId: "agent-1" });
    (client as unknown as { transport: { request: typeof request } }).transport = { request };

    await client.withAuditToolContext("orcy_habitat_task", "add-comment", () =>
      client.addComment("task-1", "Looks good"),
    );

    expect(request).toHaveBeenCalledWith("POST", "/api/tasks/task-1/comments", {
      body: { content: "Looks good" },
      headers: {
        "X-Agent-API-Key": "api-key",
        "X-Orcy-Audit-Source": "mcp_tool",
        "X-Orcy-MCP-Tool": "orcy_habitat_task",
        "X-Orcy-MCP-Action": "add-comment",
      },
    });
  });
});

describe("KanbanApiClient audit exports", () => {
  it("forwards canonical audit export filters", async () => {
    const { client, request } = createClientWithRequestSpy();

    await client.exportAuditLog("habitat-1", {
      format: "json",
      entityType: "pipeline_event",
      source: "webhook",
      provider: "github",
      preset: "failed_pipelines",
      includeProvenance: true,
      includeIntegrity: true,
      includeHealthSnapshots: true,
    });

    expect(request).toHaveBeenCalledWith(
      "GET",
      "/api/habitats/habitat-1/audit/export?format=json&entityType=pipeline_event&source=webhook&provider=github&preset=failed_pipelines&includeProvenance=true&includeIntegrity=true&includeHealthSnapshots=true",
    );
  });
});

describe("KanbanApiClient analytics endpoints", () => {
  it("calls habitat analytics endpoints with concise query params", async () => {
    const { client, request } = createClientWithRequestSpy();

    await client.getHabitatPredictions("habitat-1");
    await client.getHabitatBottlenecks("habitat-1", 14);
    await client.getHabitatAgentQuality("habitat-1");

    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/habitats/habitat-1/predictions");
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET",
      "/api/habitats/habitat-1/bottlenecks?days=14",
    );
    expect(request).toHaveBeenNthCalledWith(3, "GET", "/api/habitats/habitat-1/agent-quality");
  });

  it("calls sprint analytics endpoints", async () => {
    const { client, request } = createClientWithRequestSpy();

    await client.getSprintMetrics("sprint-1");
    await client.getSprintBurndown("sprint-1");
    await client.getSprintCarryOver("sprint-1");

    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/sprints/sprint-1/metrics");
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/api/sprints/sprint-1/burndown");
    expect(request).toHaveBeenNthCalledWith(3, "GET", "/api/sprints/sprint-1/carry-over");
  });
});

describe("KanbanApiClient.claimTask", () => {
  it("sends the object body the claim route validates and projects the served task", async () => {
    const { client, request } = createClientWithRequestSpy();
    request.mockResolvedValue({ task: { id: "task-1" } });

    await expect(client.claimTask("task-1")).resolves.toEqual({
      success: true,
      task: { id: "task-1" },
    });
    expect(request).toHaveBeenCalledWith("POST", "/api/tasks/task-1/claim", {});
  });

  it.each([
    [
      403,
      {
        error: "Capability mismatch",
        code: "FORBIDDEN",
        details: { missingCapabilities: ["postgresql"] },
      },
      "capability_mismatch",
      { message: "Missing capabilities: postgresql", missingCapabilities: ["postgresql"] },
    ],
    [403, { error: "Domain mismatch", code: "FORBIDDEN" }, "domain_mismatch", {}],
    [404, { error: "Task not found", code: "NOT_FOUND" }, "not_found", {}],
    [409, { error: "already_claimed", code: "CONFLICT" }, "already_claimed", {}],
    // No documented code for an interceptor veto: the served reason passes through.
    [
      403,
      { error: "Transition blocked by lifecycle interceptor", code: "INTERCEPTOR_VETO" },
      "Transition blocked by lifecycle interceptor",
      {},
    ],
  ])("types a served HTTP %s refusal", async (status, body, reason, rest) => {
    const { client, request } = createClientWithRequestSpy();
    const raw = JSON.stringify(body);
    request.mockRejectedValue(new ApiClientError(status, raw));

    const result = await client.claimTask("task-1");
    expect(result).toEqual({ success: false, reason, message: raw, ...rest });
  });

  it.each([
    "11111111-1111-4111-8111-111111111111/start?",
    "..",
    "%2e%2e%2fagents",
    "a b",
  ])("refuses a task ID that could retarget the request (%s) before sending it", async (taskId) => {
    const { client, request } = createClientWithRequestSpy();

    await expect(client.claimTask(taskId)).resolves.toMatchObject({
      success: false,
      reason: "not_found",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps an unreadable refusal as unknown", async () => {
    const { client, request } = createClientWithRequestSpy();
    request.mockRejectedValue(new ApiClientError(502, "Bad Gateway"));

    await expect(client.claimTask("task-1")).resolves.toEqual({
      success: false,
      reason: "unknown",
      message: "Bad Gateway",
    });
  });
});
