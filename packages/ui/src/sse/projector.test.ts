import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { projectSSEServerEvent, applySSEEphemeralUpdate } from "./registry.js";
import { queryKeys } from "../lib/queryKeys.js";
import type { ServerProjectionContext, SSEStoreState } from "./types.js";
import type {
  SSEEvent,
  Mission,
  MissionWithProgress,
  Column,
  PublicHabitat,
} from "../types/index.js";

function makeState(overrides: Partial<SSEStoreState> = {}): SSEStoreState {
  return {
    presence: [],
    wipAlerts: {},
    selectedMissionIds: [],
    selectedMissionId: null,
    recentSSEEvents: [],
    ...overrides,
  } as SSEStoreState;
}

const baseMission = (overrides: Partial<Mission> = {}): Mission => ({
  id: "m1",
  habitatId: "h1",
  columnId: "col-1",
  title: "M",
  description: "",
  acceptanceCriteria: "",
  priority: "medium",
  labels: [],
  status: "not_started",
  displayOrder: 0,
  dependsOn: [],
  blocks: [],
  dueAt: null,
  slaMinutes: null,
  slaDeadlineAt: null,
  createdBy: "u",
  createdAt: "",
  updatedAt: "",
  version: 1,
  actualMinutes: null,
  plannedMinutes: null,
  planningAccuracy: null,
  completedAt: null,
  isArchived: false,
  sprintId: null,
  releaseGateType: null,
  releaseGateVersion: null,
  releaseDeadlineType: null,
  releaseDeadlineVersion: null,
  ...overrides,
});

const withProgress = (m: Mission): MissionWithProgress => ({
  ...m,
  progress: {
    total: 4,
    pending: 2,
    claimed: 0,
    inProgress: 1,
    submitted: 0,
    approved: 0,
    done: 1,
    failed: 0,
    rejected: 0,
    percentage: 25,
  },
});

const col = (id: string, order: number): Column => ({
  id,
  name: id,
  order,
  habitatId: "h1",
  wipLimit: null,
  autoAdvance: false,
  requiresClaim: false,
  nextColumnId: null,
  isTerminal: false,
});

function qcWithDetail(missions: MissionWithProgress[] = [], columns: Column[] = [col("col-1", 0)]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const habitat: PublicHabitat = {
    id: "h1",
    name: "H",
    description: "",
    columns,
    teamId: null,
    retrySettings: null,
    anomalySettings: null,
    autoAssignSettings: null,
    codeReviewSettings: null,
    ciCdSettings: null,
    gitWorktreeSettings: null,
    prioritizationSettings: null,
    automationSettings: null,
    wikiSettings: null,
    triageSettings: null,
    releaseSettings: null,
    roadmapSettings: null,
    eventRetentionDays: null,
    createdAt: "",
    updatedAt: "",
  };
  qc.setQueryData(queryKeys.habitats.detail("h1"), { habitat, columns, missions });
  return qc;
}

function ctx(
  event: SSEEvent,
  qc: QueryClient,
  overrides: Partial<ServerProjectionContext> = {},
): ServerProjectionContext {
  return {
    event,
    queryClient: qc,
    subscriptionHabitatId: "h1",
    routeHabitatId: "h1",
    isActive: () => true,
    navigateHome: vi.fn(),
    ...overrides,
  };
}

function detailData(qc: QueryClient) {
  return qc.getQueryData<{
    habitat: PublicHabitat;
    columns: Column[];
    missions: MissionWithProgress[];
  }>(queryKeys.habitats.detail("h1"));
}

describe("realtime projector — event-by-representation matrix", () => {
  it("mission.updated ordinary: guarded merge preserves cached progress, rejects older version, invalidates", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ version: 5 }))]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ version: 6, title: "Newer" }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    const patched = detailData(qc)!.missions.find((m) => m.id === "m1")!;
    expect(patched.title).toBe("Newer");
    expect(patched.version).toBe(6);
    expect(patched.progress.percentage).toBe(25);
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("mission.updated rejects an older version (does not regress cached data)", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ version: 5, title: "Current" }))]);
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ version: 2, title: "Stale" }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    const patched = detailData(qc)!.missions.find((m) => m.id === "m1")!;
    expect(patched.version).toBe(5);
    expect(patched.title).toBe("Current");
  });

  it("mission.updated archive: removes from active detail, resets archived, invalidates", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ id: "m1", version: 3 }))]);
    const resetSpy = vi.spyOn(qc, "resetQueries");
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ id: "m1", version: 4, isArchived: true }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(detailData(qc)!.missions.some((m) => m.id === "m1")).toBe(false);
    expect(resetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["archived"]) }),
    );
  });

  it("mission.updated unarchive: does not fabricate progress, invalidates + resets archived", async () => {
    const qc = qcWithDetail([]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const resetSpy = vi.spyOn(qc, "resetQueries");
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ id: "m-absent", version: 2, isArchived: false }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(detailData(qc)!.missions.some((m) => m.id === "m-absent")).toBe(false);
    expect(resetSpy).toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("mission.created: does not insert (lacks derived progress), invalidates", async () => {
    const qc = qcWithDetail([]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const event: SSEEvent = { type: "mission.created", data: baseMission({ id: "m-new" }) };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(detailData(qc)!.missions.some((m) => m.id === "m-new")).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.habitats.detail("h1") }),
    );
  });

  it("mission.deleted: removes by id, resets archived, invalidates", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ id: "m1", version: 3 }))]);
    const resetSpy = vi.spyOn(qc, "resetQueries");
    const event: SSEEvent = { type: "mission.deleted", data: { missionId: "m1" } };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(detailData(qc)!.missions.some((m) => m.id === "m1")).toBe(false);
    expect(resetSpy).toHaveBeenCalled();
  });

  it("mission.moved partial payload: no speculative move, invalidates", async () => {
    const qc = qcWithDetail([
      withProgress(baseMission({ id: "m1", columnId: "col-1", version: 1 })),
    ]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const event: SSEEvent = {
      type: "mission.moved",
      data: { missionId: "m1", fromColumnId: "col-1", toColumnId: "col-2" },
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(detailData(qc)!.missions[0].columnId).toBe("col-1");
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.habitats.detail("h1") }),
    );
  });

  it("task lifecycle invalidates Mission/Task/Habitat detail (progress may change)", async () => {
    const qc = qcWithDetail();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const event: SSEEvent = {
      type: "task.completed",
      data: { taskId: "t1" },
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.tasks.detail("t1") }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.habitats.detail("h1") }),
    );
  });

  it("column.updated invalidates habitat detail (no speculative single-column patch)", async () => {
    const qc = qcWithDetail();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const event: SSEEvent = { type: "column.updated", data: col("col-1", 0) };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.habitats.detail("h1") }),
    );
  });
});

describe("realtime projector — cancel-before-patch race proof", () => {
  it("cancels the affected in-flight HTTP query before patching", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ version: 1 }))]);
    const cancelSpy = vi.spyOn(qc, "cancelQueries").mockResolvedValue(undefined);
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ version: 2, title: "v2" }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(cancelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.habitats.detail("h1") }),
    );
    const patched = detailData(qc)!.missions[0];
    expect(patched.version).toBe(2);
  });

  it("older HTTP resolve cannot replace the newer event patch (cancel happened first)", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ version: 1 }))]);
    const cancelSpy = vi.spyOn(qc, "cancelQueries").mockResolvedValue(undefined);
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ version: 5, title: "event-v5" }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(cancelSpy).toHaveBeenCalled();
    expect(detailData(qc)!.missions[0].version).toBe(5);
    expect(detailData(qc)!.missions[0].title).toBe("event-v5");
  });

  it("a stale generation performs no patch after the await", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ version: 1, title: "original" }))]);
    vi.spyOn(qc, "cancelQueries").mockResolvedValue(undefined);
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ version: 9, title: "stale-gen" }),
    };

    await projectSSEServerEvent(event, ctx(event, qc, { isActive: () => false }));

    expect(detailData(qc)!.missions[0].version).toBe(1);
    expect(detailData(qc)!.missions[0].title).toBe("original");
  });
});

describe("realtime projector — habitat.deleted route safety", () => {
  it("removes cache regardless of route, navigates only when route matches", async () => {
    const qc = qcWithDetail();
    const removeSpy = vi.spyOn(qc, "removeQueries");
    const navigateHome = vi.fn();
    const event: SSEEvent = { type: "habitat.deleted", data: { habitatId: "h1" } };

    await projectSSEServerEvent(event, ctx(event, qc, { routeHabitatId: "h1", navigateHome }));

    expect(removeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.habitats.detail("h1") }),
    );
    expect(navigateHome).toHaveBeenCalled();
  });

  it("removes cache but does NOT navigate when route has moved to another habitat", async () => {
    const qc = qcWithDetail();
    const navigateHome = vi.fn();
    const event: SSEEvent = { type: "habitat.deleted", data: { habitatId: "h1" } };

    await projectSSEServerEvent(
      event,
      ctx(event, qc, { subscriptionHabitatId: "h1", routeHabitatId: "h2", navigateHome }),
    );

    expect(qc.getQueryData(queryKeys.habitats.detail("h1"))).toBeUndefined();
    expect(navigateHome).not.toHaveBeenCalled();
  });
});

describe("realtime projector — presence and WIP stay ephemeral", () => {
  it("presence.joined writes only to ephemeral state, never server Queries", () => {
    const state = makeState({ presence: [] });
    const set = vi.fn();
    const event: SSEEvent = {
      type: "presence.joined",
      data: { habitatId: "h1", presence: { sessionId: "s1", userId: "u1", joinedAt: "" } as never },
    };

    applySSEEphemeralUpdate(event, state, set);

    expect(set).toHaveBeenCalledWith({ presence: [expect.any(Object)] });
  });

  it("column.wip_limit_reached writes only to ephemeral wipAlerts", () => {
    const state = makeState({ wipAlerts: {} });
    const set = vi.fn();
    const event: SSEEvent = {
      type: "column.wip_limit_reached",
      data: { columnId: "col-1", limit: 3 },
    };

    applySSEEphemeralUpdate(event, state, set);

    expect(set).toHaveBeenCalledWith({
      wipAlerts: { "col-1": expect.objectContaining({ limit: 3 }) },
    });
  });

  it("mission.updated performs no Zustand write (server projection only)", () => {
    const state = makeState();
    const set = vi.fn();
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission(),
    };

    applySSEEphemeralUpdate(event, state, set);

    expect(set).not.toHaveBeenCalled();
  });
});

describe("M5 — version-guarded archive removal (real QueryClient)", () => {
  it("a delayed archive (older version) does NOT remove a newer active entry reinstalled by unarchive", async () => {
    // Unarchive refetch reinstalled v5 into the active collection. A delayed
    // archive event carrying v4 must not evict the newer active entry.
    const qc = qcWithDetail([withProgress(baseMission({ id: "m1", version: 5 }))]);
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ id: "m1", version: 4, isArchived: true }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    const missions = detailData(qc)!.missions;
    expect(missions.some((m) => m.id === "m1")).toBe(true);
    expect(missions.find((m) => m.id === "m1")!.version).toBe(5);
  });

  it("a current archive (newer-or-equal version) DOES remove the active entry", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ id: "m1", version: 4 }))]);
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ id: "m1", version: 6, isArchived: true }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(detailData(qc)!.missions.some((m) => m.id === "m1")).toBe(false);
  });

  it("equal version archive removes (cached.version <= archived.version)", async () => {
    const qc = qcWithDetail([withProgress(baseMission({ id: "m1", version: 4 }))]);
    const event: SSEEvent = {
      type: "mission.updated",
      data: baseMission({ id: "m1", version: 4, isArchived: true }),
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(detailData(qc)!.missions.some((m) => m.id === "m1")).toBe(false);
  });
});

describe("M6 — task lifecycle resets the events-infinite family (real QueryClient)", () => {
  it("a task.completed event resets (not invalidates) the eventsInfinite key", async () => {
    const qc = qcWithDetail();
    const infiniteKey = queryKeys.habitats.eventsInfinite("h1", undefined, 50);
    // Seed cached activity data so we can observe a reset clearing it. An
    // invalidate would leave the stale data in place (refetch in background);
    // only a reset clears it synchronously.
    qc.setQueryData(infiniteKey, {
      pages: [{ events: [{ id: "e1" } as never], total: 1 }],
      pageParams: [0],
    });
    expect(qc.getQueryData(infiniteKey)).toBeDefined();

    const event: SSEEvent = { type: "task.completed", data: { taskId: "t1" } };
    await projectSSEServerEvent(event, ctx(event, qc));

    // Reset clears the cached data — proving reset, not invalidate.
    expect(qc.getQueryData(infiniteKey)).toBeUndefined();
  });

  it("invalidateHabitatRepresentations resets the eventsInfinite family", async () => {
    const { invalidateHabitatRepresentations } = await import("../lib/habitatMutations.js");
    const qc = qcWithDetail();
    const infiniteKey = queryKeys.habitats.eventsInfinite("h1", undefined, 50);
    qc.setQueryData(infiniteKey, {
      pages: [{ events: [{ id: "e1" } as never], total: 1 }],
      pageParams: [0],
    });

    invalidateHabitatRepresentations(qc, "h1");

    expect(qc.getQueryData(infiniteKey)).toBeUndefined();
  });
});

describe("M7 — review_completed refreshes reviewers (real QueryClient)", () => {
  it("task.review_completed invalidates tasks.reviewers, matching review_assigned", async () => {
    const qc = qcWithDetail();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const event: SSEEvent = {
      type: "task.review_completed",
      data: { taskId: "t1", reviewerId: "u1", status: "approved" },
    };

    await projectSSEServerEvent(event, ctx(event, qc));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.tasks.reviewers("t1") }),
    );
  });
});
