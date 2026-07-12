import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  releases as releasesTable,
  pulses,
  taskDependencies,
  taskWorkflowGates,
  workflows,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as releaseRepo from "../repositories/release.js";
import * as agentRepo from "../repositories/agent.js";
import { claimTask, claimTaskByRemoteParticipant } from "../repositories/taskStateMachine.js";
import {
  areAllMissionDependenciesMet,
  isReleaseGateSatisfiedForTask,
} from "../repositories/taskQueries.js";
import type { ReleaseType } from "@orcy/shared";

let habitatId: string;
let columnId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Claim Guard Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const agent = agentRepo.createAgent({
    name: "guard-test-agent",
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
 * Release-gate guard on the canonical claim path. Mirrors the read-path gate
 * enforcement (AC-GATE-2/3) but at mutation time so a direct `claimTask` call
 * cannot bypass an unsatisfied gate.
 */
describe("claimTask release-gate guard", () => {
  it("blocks claimTask when gate is unsatisfied (no matching release)", () => {
    const { task } = seedMission({ title: "gated-no-release", releaseGateType: "minor" });

    const result = claimTask(task.id, agentId);
    expect(result.success).toBe(false);
    expect(result).toEqual({ success: false, reason: "release_gate_unmet" });
  });

  it("unblocks claimTask after a matching release ships", () => {
    const { task } = seedMission({ title: "gated-then-satisfied", releaseGateType: "minor" });

    expect(claimTask(task.id, agentId).success).toBe(false);
    seedRelease("0.2.0", "minor");

    const result = claimTask(task.id, agentId);
    expect(result.success).toBe(true);
  });
});

/**
 * Mission-dependency guard on the canonical claim path. Mirrors the read-path
 * mission-dep filter so a direct `claimTask` call cannot bypass an unmet
 * mission dependency.
 */
describe("claimTask mission-dependency guard", () => {
  it("blocks claimTask when a depended-on mission is not done", () => {
    const { mission: blocker } = seedMission({ title: "blocker-mission" });
    const { task } = seedMission({ title: "blocked-mission", dependsOn: [blocker.id] });

    const result = claimTask(task.id, agentId);
    expect(result.success).toBe(false);
    expect(result).toEqual({ success: false, reason: "mission_dependencies_unmet" });
  });

  it("unblocks claimTask after the blocker mission reaches done", () => {
    const { mission: blocker } = seedMission({ title: "blocker-mission" });
    const { task } = seedMission({ title: "blocked-mission", dependsOn: [blocker.id] });

    expect(claimTask(task.id, agentId).success).toBe(false);
    missionRepo.updateMission(blocker.id, { status: "done" }, undefined);

    const result = claimTask(task.id, agentId);
    expect(result.success).toBe(true);
  });
});

/**
 * Ordering pin: mission-dependency is checked BEFORE release-gate. When both
 * are unmet the first error surfaced is `mission_dependencies_unmet`.
 */
describe("claimTask guard ordering", () => {
  it("returns mission_dependencies_unmet first when both deps and gate are unmet", () => {
    const { mission: blocker } = seedMission({ title: "blocker-mission" });
    const { task } = seedMission({
      title: "compound-blocked",
      releaseGateType: "minor",
      dependsOn: [blocker.id],
    });

    const result = claimTask(task.id, agentId);
    expect(result.success).toBe(false);
    expect(result).toEqual({ success: false, reason: "mission_dependencies_unmet" });
  });
});

describe("claimTask canonical claimability reasons", () => {
  const cases = [
    {
      reason: "dependencies_unmet",
      seed: () => {
        const { mission, task } = seedMission({ title: "task-dependency-blocked" });
        const blocker = taskRepo.createTask({
          missionId: mission.id,
          title: "task-dependency-blocker",
          createdBy: "user-1",
        });
        getDb().insert(taskDependencies).values({ taskId: task.id, dependsOnId: blocker.id }).run();
        return task;
      },
    },
    {
      reason: "mission_dependencies_unmet",
      seed: () => {
        const { mission: blocker } = seedMission({ title: "mission-dependency-blocker" });
        return seedMission({ title: "mission-dependency-blocked", dependsOn: [blocker.id] }).task;
      },
    },
    {
      reason: "release_gate_unmet",
      seed: () => seedMission({ title: "release-gate-blocked", releaseGateType: "minor" }).task,
    },
    {
      reason: "workflow_gates_unmet",
      seed: () => {
        const { mission, task } = seedMission({ title: "workflow-gate-blocked" });
        const upstream = taskRepo.createTask({
          missionId: mission.id,
          title: "workflow-upstream",
          createdBy: "user-1",
        });
        getDb()
          .insert(workflows)
          .values({
            id: "wf-claimability-order",
            missionId: mission.id,
            habitatId,
            resolvedVariables: {},
            createdBy: "user-1",
          })
          .run();
        getDb()
          .insert(taskWorkflowGates)
          .values({
            id: "gate-claimability-order",
            workflowId: "wf-claimability-order",
            missionId: mission.id,
            habitatId,
            upstreamTaskId: upstream.id,
            downstreamTaskId: task.id,
            gateType: "on_complete",
            satisfied: false,
          })
          .run();
        return task;
      },
    },
  ] as const;

  it.each(cases)("returns $reason in canonical guard order", ({ reason, seed }) => {
    const task = seed();

    expect(claimTask(task.id, agentId)).toEqual({ success: false, reason });
  });
});

/**
 * Remote-participant parity — `claimTaskByRemoteParticipant` must enforce the
 * same guards as `claimTask` (Phase D remote model, same canonical path).
 */
describe("claimTaskByRemoteParticipant guard parity", () => {
  it("returns release_gate_unmet for a gated mission with no matching release", () => {
    const { task } = seedMission({ title: "remote-gated", releaseGateType: "minor" });

    const result = claimTaskByRemoteParticipant(task.id, "participant-1");
    expect(result.success).toBe(false);
    expect(result).toEqual({ success: false, reason: "release_gate_unmet" });
  });

  it("returns mission_dependencies_unmet when a depended-on mission is not done", () => {
    const { mission: blocker } = seedMission({ title: "remote-blocker" });
    const { task } = seedMission({ title: "remote-blocked", dependsOn: [blocker.id] });

    const result = claimTaskByRemoteParticipant(task.id, "participant-1");
    expect(result.success).toBe(false);
    expect(result).toEqual({ success: false, reason: "mission_dependencies_unmet" });
  });

  it("succeeds when no gate and no deps are present (backward compatible)", () => {
    const { task } = seedMission({ title: "remote-plain" });

    const result = claimTaskByRemoteParticipant(task.id, "participant-1");
    expect(result.success).toBe(true);
  });
});

/**
 * Backward compatibility — a task with no gate and no mission deps claims
 * successfully, and both predicates report true.
 */
describe("claimTask backward compatibility (no gate, no deps)", () => {
  it("succeeds and both predicates are true", () => {
    const { task } = seedMission({ title: "plain-mission" });

    expect(areAllMissionDependenciesMet(task.id)).toBe(true);
    expect(isReleaseGateSatisfiedForTask(task.id)).toBe(true);

    const result = claimTask(task.id, agentId);
    expect(result.success).toBe(true);
  });
});
