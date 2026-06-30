import { describe, it, expect } from "vitest";
import { KanbanApiClient } from "../api.js";
import { triageInvestigate, triageTopIssues, triageResolutionLookup } from "../tools/triage.js";
import { TRIAGE_ACTIONS, TRIAGE_DISPATCH_TOOL } from "../tools/triage-dispatch.js";

function createMockClient(overrides?: Partial<KanbanApiClient>): KanbanApiClient {
  return {
    getTopTriageClusters: async () => ({ clusters: [] }),
    listTriageFindings: async () => ({ findings: [] }),
    getTriageResolutions: async () => ({ resolutions: [] }),
    ...overrides,
  } as unknown as KanbanApiClient;
}

describe("orcy_triage dispatch", () => {
  it("registers the three documented actions on the tool surface", () => {
    expect(TRIAGE_DISPATCH_TOOL.name).toBe("orcy_triage");
    expect(TRIAGE_ACTIONS.investigate).toBe(triageInvestigate);
    expect(TRIAGE_ACTIONS.top_issues).toBe(triageTopIssues);
    expect(TRIAGE_ACTIONS.resolution_lookup).toBe(triageResolutionLookup);
  });

  it("AC-FINDING-8: top_issues returns ranked cluster summaries", async () => {
    const client = createMockClient({
      getTopTriageClusters: async () => ({
        clusters: [
          {
            clusterKey: "flaky-test#abc",
            signalCount: 8,
            statuses: ["under_investigation"],
            findingKinds: ["bug"],
            status: "under_investigation",
          },
          {
            clusterKey: "slow-build#def",
            signalCount: 3,
            statuses: ["awaiting_triage"],
            findingKinds: [],
            status: "awaiting_triage",
          },
        ],
      }),
    });

    const result = await triageTopIssues(client, { habitatId: "hab-1", limit: 10 });

    expect(result.habitatId).toBe("hab-1");
    expect(result.clusters).toHaveLength(2);
    // Ranked: highest signal volume first (as returned by the API).
    expect(result.clusters[0].signalCount).toBeGreaterThanOrEqual(result.clusters[1].signalCount);
    expect(result.hint).toContain("investigate");
  });

  it("AC-FINDING-9: investigate returns cluster context for a specified clusterKey", async () => {
    const client = createMockClient({
      getTopTriageClusters: async () => ({
        clusters: [
          {
            clusterKey: "target-cluster#1",
            signalCount: 5,
            statuses: ["under_investigation"],
            findingKinds: ["bug"],
            status: "under_investigation",
          },
        ],
      }),
      listTriageFindings: async () => ({
        findings: [
          {
            id: "f-1",
            clusterKey: "target-cluster#1",
            findingKind: "bug",
            status: "open",
            bucket: null,
            targetRelease: null,
            triageMissionId: "m-1",
            createdAt: "2026-07-01T00:00:00.000Z",
            metadata: {
              affectedTaskIds: ["t-1"],
              affectedMissionIds: ["m-1"],
              agentIds: ["a-1"],
            },
          },
        ],
      }),
      getTriageResolutions: async () => ({
        resolutions: [
          {
            id: "r-1",
            resolutionKind: "code_fix",
            rootCause: "race",
            resolution: "locked",
            resolvedAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      }),
    });

    const result = await triageInvestigate(client, {
      habitatId: "hab-1",
      clusterKey: "target-cluster#1",
    });

    expect(result.clusterKey).toBe("target-cluster#1");
    expect(result.signalCount).toBe(5);
    expect(result.status).toBe("under_investigation");
    expect(result.openFindings).toHaveLength(1);
    expect(result.affectedTaskIds).toContain("t-1");
    expect(result.agentIds).toContain("a-1");
    expect(result.historicalResolutions).toHaveLength(1);
    expect(result.investigationNote).toContain("triage mission already exists");
  });

  it("AC-FINDING-9: investigate notes awaiting_triage when no active mission", async () => {
    const client = createMockClient({
      getTopTriageClusters: async () => ({
        clusters: [
          {
            clusterKey: "no-mission#2",
            signalCount: 2,
            statuses: [],
            findingKinds: [],
            status: "awaiting_triage",
          },
        ],
      }),
    });

    const result = await triageInvestigate(client, {
      habitatId: "hab-1",
      clusterKey: "no-mission#2",
    });

    expect(result.status).toBe("awaiting_triage");
    expect(result.investigationNote).toContain("No active triage mission");
  });

  it("AC-PROACTIVE-4: resolution_lookup returns historical resolutions", async () => {
    const client = createMockClient({
      getTriageResolutions: async () => ({
        resolutions: [
          {
            id: "r-1",
            resolutionKind: "config_change",
            rootCause: "bad default",
            resolution: "updated default",
            resolvedAt: "2026-06-15T00:00:00.000Z",
          },
        ],
      }),
    });

    const result = await triageResolutionLookup(client, {
      habitatId: "hab-1",
      clusterKey: "known-pain#9",
    });

    expect(result.habitatId).toBe("hab-1");
    expect(result.clusterKey).toBe("known-pain#9");
    expect(result.count).toBe(1);
    expect(result.resolutions[0].resolutionKind).toBe("config_change");
  });

  it("AC-PROACTIVE-4: resolution_lookup returns empty when none exist", async () => {
    const client = createMockClient({
      getTriageResolutions: async () => ({ resolutions: [] }),
    });

    const result = await triageResolutionLookup(client, {
      habitatId: "hab-1",
      clusterKey: "never-seen#0",
    });

    expect(result.count).toBe(0);
    expect(result.resolutions).toEqual([]);
  });

  it("requires habitatId on every action", async () => {
    await expect(triageTopIssues(client_noArgs_check(), {})).rejects.toThrow("habitatId");
  });

  it("requires clusterKey for investigate and resolution_lookup", async () => {
    await expect(triageInvestigate(createMockClient(), { habitatId: "hab-1" })).rejects.toThrow(
      "clusterKey",
    );
    await expect(
      triageResolutionLookup(createMockClient(), { habitatId: "hab-1" }),
    ).rejects.toThrow("clusterKey");
  });
});

function client_noArgs_check(): KanbanApiClient {
  return createMockClient();
}
