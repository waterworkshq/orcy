import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { releases as releasesTable, pulses } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as releaseRepo from "../repositories/release.js";
import * as agentRepo from "../repositories/agent.js";
import { batchOperateTasks } from "../services/tasks/index.js";
import { claimDelegatedTask } from "../services/tasks/task-delegation.js";
import type { ReleaseType } from "@orcy/shared";

let habitatId: string;
let columnId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Batch Claim Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const agent = agentRepo.createAgent({
    name: "batch-test-agent",
    type: "claude-code",
    domain: "fullstack",
  });
  agentId = agent.agent.id;
});

afterEach(() => closeDb());

function seedRelease(version: string, releaseType: ReleaseType) {
  return releaseRepo.create({
    habitatId,
    version,
    releaseType,
    detectedBy: "api",
  });
}

function seedMission(opts: {
  title: string;
  releaseGateType?: ReleaseType | null;
  releaseGateVersion?: string | null;
  dependsOn?: string[];
}) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: opts.title,
    createdBy: "user-1",
    releaseGateType: opts.releaseGateType ?? null,
    releaseGateVersion: opts.releaseGateVersion ?? null,
    dependsOn: opts.dependsOn ?? [],
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: `task-for-${mission.id}`,
    createdBy: "user-1",
  });
  return { mission, task };
}

/**
 * T4 — Batch assign must enforce claimability guards and produce coherent
 * `claimed` state. A blocked task fails per-task without aborting the batch.
 * The admin-only route gate is tested separately.
 */
describe("batchOperateTasks assign — claimability enforcement", () => {
  it("respects release-gate: gated task fails, non-gated task succeeds", () => {
    const { task: gatedTask } = seedMission({
      title: "gated-mission",
      releaseGateType: "minor",
    });
    const { task: plainTask } = seedMission({ title: "plain-mission" });

    const result = batchOperateTasks(
      habitatId,
      {
        taskIds: [gatedTask.id, plainTask.id],
        operation: "assign",
        payload: { assignedAgentId: agentId },
      },
      "user-1",
      "human",
    );

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);

    const gatedResult = result.results.find((r) => r.taskId === gatedTask.id);
    expect(gatedResult?.success).toBe(false);
    expect(gatedResult?.error).toBe("release_gate_unmet");

    const plainResult = result.results.find((r) => r.taskId === plainTask.id);
    expect(plainResult?.success).toBe(true);
    expect(plainResult?.task?.status).toBe("claimed");
    expect(plainResult?.task?.assignedAgentId).toBe(agentId);
  });

  it("produces coherent claimed state (not pending + assignedAgentId)", () => {
    const { task } = seedMission({ title: "coherent-state-test" });

    const result = batchOperateTasks(
      habitatId,
      {
        taskIds: [task.id],
        operation: "assign",
        payload: { assignedAgentId: agentId },
      },
      "user-1",
      "human",
    );

    expect(result.successCount).toBe(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].task?.status).toBe("claimed");
    expect(result.results[0].task?.assignedAgentId).toBe(agentId);

    const refreshed = taskRepo.getTaskById(task.id);
    expect(refreshed?.status).toBe("claimed");
    expect(refreshed?.assignedAgentId).toBe(agentId);
  });

  it("continues processing after a blocked task fails (per-task isolation)", () => {
    const { task: blockedTask } = seedMission({
      title: "gated-blocked",
      releaseGateType: "minor",
    });
    const { task: okTask1 } = seedMission({ title: "plain-1" });
    const { task: okTask2 } = seedMission({ title: "plain-2" });

    const result = batchOperateTasks(
      habitatId,
      {
        taskIds: [blockedTask.id, okTask1.id, okTask2.id],
        operation: "assign",
        payload: { assignedAgentId: agentId },
      },
      "user-1",
      "human",
    );

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);

    const ok1 = taskRepo.getTaskById(okTask1.id);
    const ok2 = taskRepo.getTaskById(okTask2.id);
    expect(ok1?.status).toBe("claimed");
    expect(ok2?.status).toBe("claimed");

    const blocked = taskRepo.getTaskById(blockedTask.id);
    expect(blocked?.status).toBe("pending");
    expect(blocked?.assignedAgentId).toBeNull();
  });

  it("mission-dep-blocked task fails with mission_dependencies_unmet", () => {
    const { mission: blocker } = seedMission({ title: "blocker-mission" });
    const { task } = seedMission({ title: "dep-blocked", dependsOn: [blocker.id] });

    const result = batchOperateTasks(
      habitatId,
      {
        taskIds: [task.id],
        operation: "assign",
        payload: { assignedAgentId: agentId },
      },
      "user-1",
      "human",
    );

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        taskId: task.id,
        success: false,
        error: "mission_dependencies_unmet",
      }),
    );
  });

  it("unblocks after release ships: same task retries successfully", () => {
    const { task } = seedMission({
      title: "gated-then-satisfied",
      releaseGateType: "minor",
    });

    const blocked = batchOperateTasks(
      habitatId,
      {
        taskIds: [task.id],
        operation: "assign",
        payload: { assignedAgentId: agentId },
      },
      "user-1",
      "human",
    );
    expect(blocked.results[0].success).toBe(false);
    expect(blocked.results[0].error).toBe("release_gate_unmet");

    seedRelease("0.2.0", "minor");

    const unblocked = batchOperateTasks(
      habitatId,
      {
        taskIds: [task.id],
        operation: "assign",
        payload: { assignedAgentId: agentId },
      },
      "user-1",
      "human",
    );
    expect(unblocked.successCount).toBe(1);
    expect(unblocked.results[0].task?.status).toBe("claimed");
  });
});

/**
 * Folded from T1 case 8 — prove `claimDelegatedTask` cannot reach a genuinely
 * pending task. Its own preconditions require `claimed` or `in_progress`
 * status, so a pending task is rejected with `invalid_status`.
 */
describe("claimDelegatedTask cannot reach a genuinely pending task", () => {
  it("rejects a pending (not claimed/in_progress) task with invalid_status", () => {
    const { task } = seedMission({ title: "pending-delegated-test" });

    taskRepo.updateTask(task.id, { delegatedToAgentId: agentId });

    const result = claimDelegatedTask(task.id, agentId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("invalid_status");
    }

    const refreshed = taskRepo.getTaskById(task.id);
    expect(refreshed?.status).toBe("pending");
    expect(refreshed?.assignedAgentId).toBeNull();
  });
});
