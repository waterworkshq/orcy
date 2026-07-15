import { describe, it, expect } from "vitest";
import { computeMissionSummary } from "../services/boardService.js";
import type { Mission } from "../models/index.js";

function mk(overrides: Partial<Mission> & Pick<Mission, "id">): Mission {
  return {
    habitatId: "h1",
    columnId: "c1",
    title: overrides.id,
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
    createdBy: "agent-1",
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
  } as Mission;
}

describe("computeMissionSummary", () => {
  it("counts only active missions and zero-fills every status key", () => {
    const missions = [
      mk({ id: "a1", status: "not_started" }),
      mk({ id: "a2", status: "in_progress" }),
      mk({ id: "a3", status: "done" }),
      mk({ id: "archived", status: "done", isArchived: true }),
    ];
    const summary = computeMissionSummary(missions);
    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(1);
    expect(summary.blocked).toBe(0);
    expect(summary.byStatus).toEqual({
      not_started: 1,
      in_progress: 1,
      review: 0,
      done: 1,
      failed: 0,
    });
  });

  it("remains correct beyond 20 missions", () => {
    const missions: Mission[] = [];
    for (let i = 0; i < 25; i++) missions.push(mk({ id: `m${i}`, status: "in_progress" }));
    for (let i = 25; i < 40; i++) missions.push(mk({ id: `m${i}`, status: "done" }));
    const summary = computeMissionSummary(missions);
    expect(summary.total).toBe(40);
    expect(summary.completed).toBe(15);
    expect(summary.byStatus.in_progress).toBe(25);
  });

  it("marks a mission blocked when any dependency status is not done", () => {
    const missions = [
      mk({ id: "dep", status: "in_progress" }),
      mk({ id: "blocked", status: "not_started", dependsOn: ["dep"] }),
      mk({ id: "free", status: "not_started", dependsOn: [] }),
    ];
    const edges = [{ missionId: "blocked", dependsOnId: "dep" }];
    const summary = computeMissionSummary(missions, edges);
    expect(summary.blocked).toBe(1);
  });

  it("does not block when the only dependency is done", () => {
    const missions = [
      mk({ id: "dep", status: "done" }),
      mk({ id: "ready", status: "not_started", dependsOn: ["dep"] }),
    ];
    const edges = [{ missionId: "ready", dependsOnId: "dep" }];
    expect(computeMissionSummary(missions, edges).blocked).toBe(0);
  });

  it("counts archived dependencies as blockers when they are not done", () => {
    const missions = [
      mk({ id: "archived-dep", status: "in_progress", isArchived: true }),
      mk({ id: "active", status: "not_started", dependsOn: ["archived-dep"] }),
    ];
    const edges = [{ missionId: "active", dependsOnId: "archived-dep" }];
    const summary = computeMissionSummary(missions, edges);
    expect(summary.total).toBe(1);
    expect(summary.blocked).toBe(1);
  });

  it("does not treat a deleted dependency target as a synthetic blocker", () => {
    const missions = [mk({ id: "dangling", status: "not_started", dependsOn: ["deleted-dep"] })];
    const edges = [{ missionId: "dangling", dependsOnId: "deleted-dep" }];
    expect(computeMissionSummary(missions, edges).blocked).toBe(0);
  });

  it("is unaffected by task completeness (tasks are not part of the predicate)", () => {
    const missions = [
      mk({ id: "dep", status: "done" }),
      mk({ id: "consumer", status: "not_started", dependsOn: ["dep"] }),
    ];
    const edges = [{ missionId: "consumer", dependsOnId: "dep" }];
    expect(computeMissionSummary(missions, edges).blocked).toBe(0);
  });

  it("returns all-zero summary for an empty habitat", () => {
    const summary = computeMissionSummary([]);
    expect(summary).toEqual({
      total: 0,
      completed: 0,
      blocked: 0,
      byStatus: { not_started: 0, in_progress: 0, review: 0, done: 0, failed: 0 },
    });
  });
});
