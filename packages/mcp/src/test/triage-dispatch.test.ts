import { describe, it, expect, vi } from "vitest";
import { KanbanApiClient } from "../api.js";
import {
  triageInvestigate,
  triageTopIssues,
  triageResolutionLookup,
  triageMapOrphanMission,
  triageInsertDeferredMission,
} from "../tools/triage.js";
import { TRIAGE_ACTIONS, TRIAGE_DISPATCH_TOOL } from "../tools/triage-dispatch.js";

function createMockClient(overrides?: Partial<KanbanApiClient>): KanbanApiClient {
  return {
    getTopTriageClusters: async () => ({ clusters: [] }),
    listTriageFindings: async () => ({ findings: [] }),
    getTriageResolutions: async () => ({ resolutions: [] }),
    // v0.25.0 Phase 3 added getRoadmapContext to triageInvestigate's Promise.all;
    // the mock returns an empty roadmap so the roadmpa field serialises cleanly.
    getRoadmapContext: async () => ({
      missions: [],
      dependencies: [],
      nextInLine: [],
      recentReleases: [],
    }),
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
            correctiveMissionId: "m-1",
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
    // Canonical corrective-Mission read (ADR-0048).
    expect(result.openFindings?.[0]?.correctiveMissionId).toBe("m-1");
    expect(result.clusterMissionId).toBe("m-1");
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

  it("RM-7: registers the map_orphan_mission action", () => {
    expect(TRIAGE_ACTIONS.map_orphan_mission).toBe(triageMapOrphanMission);
  });

  it("RM-14: signal-cluster investigate fetches the roadmap in summary mode (bounds payload)", async () => {
    let summaryArg: unknown;
    const client = createMockClient({
      getRoadmapContext: async (_habitatId: string, summary?: boolean) => {
        summaryArg = summary;
        // Summary-mode shape: counts + nextInLine + recentReleases, no raw arrays.
        return {
          summary: true as const,
          missionCount: 42,
          dependencyCount: 7,
          nextInLine: ["m-1"],
          recentReleases: [],
        } as never;
      },
    });

    const result = (await triageInvestigate(client, {
      habitatId: "hab-1",
      clusterKey: "some-cluster",
    })) as {
      roadmap: {
        summary?: boolean;
        missionCount?: number;
        nextInLine: string[];
        missions?: unknown[];
      };
    };

    expect(summaryArg).toBe(true);
    expect(result.roadmap.summary).toBe(true);
    expect(result.roadmap.missionCount).toBe(42);
    expect(result.roadmap.nextInLine).toEqual(["m-1"]);
    // Raw arrays are omitted in summary mode.
    expect(result.roadmap.missions).toBeUndefined();
  });

  it("RM-14: orphan-mission investigate fetches the roadmap in FULL mode (needs edges for positioning)", async () => {
    let summaryArg: unknown;
    const client = createMockClient({
      getRoadmapContext: async (_habitatId: string, summary?: boolean) => {
        summaryArg = summary;
        return {
          missions: [],
          dependencies: [{ missionId: "m-y", dependsOnId: "m-x" }],
          nextInLine: ["m-x"],
          recentReleases: [],
        } as never;
      },
    });

    await triageInvestigate(client, {
      habitatId: "hab-1",
      clusterKey: "orphan-mission:m-orphan-1",
    });

    // Full mode — the agent needs the dependency edges to position the orphan.
    expect(summaryArg).toBeFalsy();
  });

  it("RM-7: investigate branches on orphan-mission:{id} and returns orphan + roadmap context", async () => {
    const client = createMockClient({
      getRoadmapContext: async () => ({
        missions: [
          {
            id: "m-x",
            title: "X",
            status: "not_started",
            releaseGateType: null,
            releaseGateVersion: null,
            priority: "medium",
            displayOrder: 0,
          },
        ],
        dependencies: [],
        nextInLine: ["m-x"],
        recentReleases: [],
      }),
    });

    const result = await triageInvestigate(client, {
      habitatId: "hab-1",
      clusterKey: "orphan-mission:m-orphan-1",
    });

    expect(result.orphanMissionId).toBe("m-orphan-1");
    expect(result.roadmap.nextInLine).toEqual(["m-x"]);
    expect(result.investigationNote).toContain("map_orphan_mission");
    // The signal-cluster fields are absent for the orphan branch.
    expect(result.openFindings).toBeUndefined();
  });

  it("RM-7: map_orphan_mission PATCHes the existing mission's deps and returns a placement note", async () => {
    let patched: { missionId?: string; dependsOn?: string[] } = {};
    const client = createMockClient({
      updateMission: async (missionId: string, input: { dependsOn?: string[] }) => {
        patched = { missionId, dependsOn: input.dependsOn };
        return { mission: { id: missionId } } as never;
      },
    });

    const result = await triageMapOrphanMission(client, {
      habitatId: "hab-1",
      missionId: "m-orphan-1",
      dependsOn: ["m-x"],
    });

    expect(patched.missionId).toBe("m-orphan-1");
    expect(patched.dependsOn).toEqual(["m-x"]);
    expect(result.placementNote).toContain("1 dependency edge");
    expect(result.mission.id).toBe("m-orphan-1");
  });
});

describe("orcy_triage insert_deferred_mission — single-command deferral cutover (T8)", () => {
  function createRouteClient(opts?: {
    routeResponse?: Record<string, unknown>;
    routeError?: Error;
  }) {
    const calls: string[] = [];
    const routePayloads: Record<string, unknown>[] = [];
    const client = createMockClient({
      routeTriageFinding: async (id: string, route: Record<string, unknown>) => {
        calls.push(`route:${id}`);
        routePayloads.push(route);
        if (opts?.routeError) throw opts.routeError;
        return {
          finding: {
            id,
            status: "triaged",
            bucket: route.bucket,
            correctiveMissionId: "m-new",
          },
        };
      },
      createMission: async () => {
        calls.push("createMission");
        throw new Error("createMission must not be called by the cutover flow");
      },
    } as unknown as Partial<KanbanApiClient>);
    return { client, calls, routePayloads };
  }

  const WIRE_ARGS = {
    habitatId: "hab-1",
    findingId: "f-1",
    missionTitle: "Corrective: flaky tests",
    missionDescription: "Stabilize the flaky integration suite.",
    dependsOn: ["m-inflight"],
    releaseGateType: "patch" as const,
    releaseGateVersion: "v0.40.0",
  };

  it("performs EXACTLY ONE command request — the old create-Mission-then-PATCH-link flow is gone", async () => {
    const { client, calls } = createRouteClient();

    const result = await triageInsertDeferredMission(client, WIRE_ARGS);

    expect(calls).toEqual(["route:f-1"]);
    expect(result.placementNote).toContain("atomically");
    expect(result.correctiveMissionId).toBe("m-new");
  });

  it("maps WIRE names to BACKEND names explicitly (dependsOn → dependencies; patch gate → defer_to_patch)", async () => {
    const { client, routePayloads } = createRouteClient();

    await triageInsertDeferredMission(client, WIRE_ARGS);

    const payload = routePayloads[0];
    // Backend Zod schema names — a rest-spread of `args` would ship `dependsOn`
    // and 400 on the missing `dependencies` field.
    expect(payload).toEqual({
      bucket: "defer_to_patch",
      missionTitle: "Corrective: flaky tests",
      missionDescription: "Stabilize the flaky integration suite.",
      dependencies: ["m-inflight"],
      releaseGateType: "patch",
      releaseGateVersion: "v0.40.0",
    });
  });

  it("minor/major gates route to defer_to_release", async () => {
    const { client, routePayloads } = createRouteClient();

    await triageInsertDeferredMission(client, {
      ...WIRE_ARGS,
      releaseGateType: "minor",
    });

    expect(routePayloads[0].bucket).toBe("defer_to_release");
  });

  it("a command failure leaves NO partial state — no second call, no compensation attempt", async () => {
    const { client, calls } = createRouteClient({
      routeError: new Error("409 Conflict: FINDING_TERMINAL"),
    });

    await expect(triageInsertDeferredMission(client, WIRE_ARGS)).rejects.toThrow(
      "FINDING_TERMINAL",
    );

    // The old flow's failure window (Mission created, link PATCH never sent)
    // cannot recur: exactly one call was made and it failed — nothing was
    // committed, and the handler performs no follow-up writes.
    expect(calls).toEqual(["route:f-1"]);
  });

  it("validates required placement fields before any client call (handler backstop)", async () => {
    const { client, calls } = createRouteClient();

    await expect(
      triageInsertDeferredMission(client, { ...WIRE_ARGS, missionDescription: undefined }),
    ).rejects.toThrow("missionDescription is required");
    await expect(
      triageInsertDeferredMission(client, { ...WIRE_ARGS, releaseGateVersion: undefined }),
    ).rejects.toThrow("releaseGateVersion is required");
    expect(calls).toEqual([]);
  });
});

function client_noArgs_check(): KanbanApiClient {
  return createMockClient();
}
