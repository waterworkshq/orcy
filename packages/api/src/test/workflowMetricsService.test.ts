import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import {
  workflows,
  taskWorkflowGates,
  failureContexts,
  tasks,
  agents,
  missions,
  columns,
  habitats,
} from "../db/schema/index.js";
import type { FailureBundle } from "@orcy/shared";
import { getWorkflowMetrics } from "../services/workflowMetricsService.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Workflow Metrics Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

function setupMission(habitatId: string, colId: string) {
  return missionRepo.createMission({
    habitatId,
    columnId: colId,
    title: "Metrics Mission",
    createdBy: "human-1",
  });
}

function setupTask(missionId: string) {
  return taskCrudRepo.createTask({
    missionId,
    title: "Task",
    createdBy: "human-1",
  });
}

function insertGate(opts: {
  workflowId: string;
  missionId: string;
  habitatId: string;
  upstreamTaskId: string;
  downstreamTaskId: string;
  gateType?: string;
  satisfied?: boolean;
  recoveryDepth?: number;
}) {
  const db = getDb();
  const id = `gate-${Math.random().toString(36).slice(2)}`;
  db.insert(taskWorkflowGates)
    .values({
      id,
      workflowId: opts.workflowId,
      missionId: opts.missionId,
      habitatId: opts.habitatId,
      upstreamTaskId: opts.upstreamTaskId,
      downstreamTaskId: opts.downstreamTaskId,
      gateType: (opts.gateType ?? "on_complete") as "on_complete",
      satisfied: opts.satisfied ?? false,
      recoveryDepth: opts.recoveryDepth ?? 0,
    })
    .run();
  return id;
}

function insertFailureContext(opts: {
  taskId: string;
  workflowId: string | null;
  habitatId: string;
  failureKind?: string;
  resolvedAt?: string | null;
  resolutionKind?: string | null;
  recoveryDepth?: number;
}) {
  const db = getDb();
  const id = `ctx-${Math.random().toString(36).slice(2)}`;
  const bundle: FailureBundle = {
    artifacts: [],
    recentLifecycleEvents: [],
    experienceSignals: [],
    retryHistory: [],
    experienceCategorySummary: {},
  };
  db.insert(failureContexts)
    .values({
      id,
      failedTaskId: opts.taskId,
      workflowId: opts.workflowId,
      habitatId: opts.habitatId,
      failureKind: (opts.failureKind ?? "lifecycle_failed") as "lifecycle_failed",
      bundle,
      resolvedAt: opts.resolvedAt ?? null,
      resolutionKind: (opts.resolutionKind ?? null) as "redeemed" | null,
      recoveryDepth: opts.recoveryDepth ?? 0,
    })
    .run();
  return id;
}

describe("workflowMetricsService", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(failureContexts).run();
    db.delete(taskWorkflowGates).run();
    db.delete(workflows).run();
    db.delete(tasks).run();
    db.delete(agents).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  afterEach(() => {
    closeDb();
  });

  describe("getWorkflowMetrics", () => {
    it("returns zeroed metrics for a habitat with no workflows", () => {
      const { habitat } = setupHabitat();
      const result = getWorkflowMetrics(habitat.id, 30);
      expect(result.activeWorkflowsCount).toBe(0);
      expect(result.failureRate).toBe(0);
      expect(result.recoverySuccessRate).toBe(0);
      expect(result.recoveryAttemptsByDepth).toHaveLength(0);
      expect(result.generatedAt).toBeTruthy();
    });

    it("counts active workflows", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);

      const db = getDb();
      db.insert(workflows)
        .values({
          id: `wf-${Math.random().toString(36).slice(2)}`,
          missionId: mission.id,
          habitatId: habitat.id,
          status: "active",
          createdBy: "admin-1",
        })
        .run();

      const result = getWorkflowMetrics(habitat.id, 30);
      expect(result.activeWorkflowsCount).toBe(1);
    });

    it("excludes detached workflows from the active count", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);

      const db = getDb();
      db.insert(workflows)
        .values({
          id: `wf-${Math.random().toString(36).slice(2)}`,
          missionId: mission.id,
          habitatId: habitat.id,
          status: "detached",
          createdBy: "admin-1",
        })
        .run();

      const result = getWorkflowMetrics(habitat.id, 30);
      expect(result.activeWorkflowsCount).toBe(0);
    });

    it("computes failure rate from satisfied on_fail gates", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const taskA = setupTask(mission.id);
      const taskB = setupTask(mission.id);
      const taskC = setupTask(mission.id);

      const db = getDb();
      const wfId = `wf-${Math.random().toString(36).slice(2)}`;
      db.insert(workflows)
        .values({
          id: wfId,
          missionId: mission.id,
          habitatId: habitat.id,
          status: "active",
          createdBy: "admin-1",
        })
        .run();

      // taskB has an on_fail gate that fired (satisfied=true)
      insertGate({
        workflowId: wfId,
        missionId: mission.id,
        habitatId: habitat.id,
        upstreamTaskId: taskA.id,
        downstreamTaskId: taskB.id,
        gateType: "on_fail",
        satisfied: true,
      });
      // taskC has an on_complete gate (not a failure)
      insertGate({
        workflowId: wfId,
        missionId: mission.id,
        habitatId: habitat.id,
        upstreamTaskId: taskA.id,
        downstreamTaskId: taskC.id,
        gateType: "on_complete",
        satisfied: false,
      });

      const result = getWorkflowMetrics(habitat.id, 30);
      // 1 failed task / 2 total tasks in workflows = 0.5
      expect(result.failureRate).toBe(0.5);
    });

    it("computes recovery success rate from resolved failure contexts", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const taskA = setupTask(mission.id);
      const taskB = setupTask(mission.id);

      const db = getDb();
      const wfId = `wf-${Math.random().toString(36).slice(2)}`;
      db.insert(workflows)
        .values({
          id: wfId,
          missionId: mission.id,
          habitatId: habitat.id,
          status: "active",
          createdBy: "admin-1",
        })
        .run();

      // 2 redeemed, 1 unrecoverable → 2/3 = 0.67
      insertFailureContext({
        taskId: taskA.id,
        workflowId: wfId,
        habitatId: habitat.id,
        resolvedAt: new Date().toISOString(),
        resolutionKind: "redeemed",
      });
      insertFailureContext({
        taskId: taskA.id,
        workflowId: wfId,
        habitatId: habitat.id,
        resolvedAt: new Date().toISOString(),
        resolutionKind: "redeemed",
      });
      insertFailureContext({
        taskId: taskB.id,
        workflowId: wfId,
        habitatId: habitat.id,
        resolvedAt: new Date().toISOString(),
        resolutionKind: "unrecoverable",
      });
      // Unresolved — excluded from the denominator
      insertFailureContext({
        taskId: taskB.id,
        workflowId: wfId,
        habitatId: habitat.id,
        resolvedAt: null,
      });

      const result = getWorkflowMetrics(habitat.id, 30);
      expect(result.recoverySuccessRate).toBe(0.67);
    });

    it("groups recovery attempts by depth", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const taskA = setupTask(mission.id);

      const db = getDb();
      const wfId = `wf-${Math.random().toString(36).slice(2)}`;
      db.insert(workflows)
        .values({
          id: wfId,
          missionId: mission.id,
          habitatId: habitat.id,
          status: "active",
          createdBy: "admin-1",
        })
        .run();

      insertFailureContext({
        taskId: taskA.id,
        workflowId: wfId,
        habitatId: habitat.id,
        recoveryDepth: 0,
      });
      insertFailureContext({
        taskId: taskA.id,
        workflowId: wfId,
        habitatId: habitat.id,
        recoveryDepth: 0,
      });
      insertFailureContext({
        taskId: taskA.id,
        workflowId: wfId,
        habitatId: habitat.id,
        recoveryDepth: 1,
      });

      const result = getWorkflowMetrics(habitat.id, 30);
      const byDepth = new Map(
        result.recoveryAttemptsByDepth.map((r) => [r.recoveryDepth, r.total]),
      );
      expect(byDepth.get(0)).toBe(2);
      expect(byDepth.get(1)).toBe(1);
    });

    it("respects the time range filter on failure contexts", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const taskA = setupTask(mission.id);

      const db = getDb();
      const wfId = `wf-${Math.random().toString(36).slice(2)}`;
      db.insert(workflows)
        .values({
          id: wfId,
          missionId: mission.id,
          habitatId: habitat.id,
          status: "active",
          createdBy: "admin-1",
        })
        .run();

      // Recent context (resolved + redeemed)
      const recentCtx = insertFailureContext({
        taskId: taskA.id,
        workflowId: wfId,
        habitatId: habitat.id,
        resolvedAt: new Date().toISOString(),
        resolutionKind: "redeemed",
      });
      // Make it recent
      db.update(failureContexts)
        .set({ failedAt: new Date().toISOString() })
        .where(eq(failureContexts.id, recentCtx))
        .run();

      // Old context (60 days ago)
      const oldCtx = insertFailureContext({
        taskId: taskA.id,
        workflowId: wfId,
        habitatId: habitat.id,
        resolvedAt: new Date().toISOString(),
        resolutionKind: "unrecoverable",
      });
      const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString();
      db.update(failureContexts)
        .set({ failedAt: oldDate })
        .where(eq(failureContexts.id, oldCtx))
        .run();

      // 30-day window: only 1 resolved (redeemed) → 1/1 = 1.0
      const result30 = getWorkflowMetrics(habitat.id, 30);
      expect(result30.recoverySuccessRate).toBe(1);

      // All-time: 2 resolved (1 redeemed, 1 unrecoverable) → 1/2 = 0.5
      const resultAll = getWorkflowMetrics(habitat.id, 0);
      expect(resultAll.recoverySuccessRate).toBe(0.5);
    });

    it("returns recoverySuccessRate 0 when no contexts are resolved", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const taskA = setupTask(mission.id);

      const db = getDb();
      const wfId = `wf-${Math.random().toString(36).slice(2)}`;
      db.insert(workflows)
        .values({
          id: wfId,
          missionId: mission.id,
          habitatId: habitat.id,
          status: "active",
          createdBy: "admin-1",
        })
        .run();

      insertFailureContext({
        taskId: taskA.id,
        workflowId: wfId,
        habitatId: habitat.id,
        resolvedAt: null,
      });

      const result = getWorkflowMetrics(habitat.id, 30);
      expect(result.recoverySuccessRate).toBe(0);
    });
  });
});
