import { describe, expect, it, vi } from "vitest";
import { KanbanApiClient } from "../api.js";

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
