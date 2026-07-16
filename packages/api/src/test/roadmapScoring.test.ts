import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as releaseRepo from "../repositories/release.js";
import { getSuggestionsForAgent } from "../services/taskSuggestion.js";

let habitatId: string;
let columnId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Scoring Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const { agent } = agentRepo.createAgent({
    name: "Scorer",
    type: "codex",
    domain: "backend",
    capabilities: [],
  });
  agentId = agent.id;
});

afterEach(() => closeDb());

function seedMission(title: string, opts: { releaseGateType?: "patch" | "minor" | "major" } = {}) {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "user-1",
    releaseGateType: opts.releaseGateType,
  });
}

function seedTask(missionId: string, title: string) {
  return taskRepo.createTask({ missionId, title, createdBy: "user-1" });
}

function setAlgorithm(
  algorithm: "fanout" | "depth_from_root" | "release_proximity" | "goal_directed",
) {
  habitatRepo.updateHabitat(habitatId, {
    roadmapSettings: { scoringAlgorithm: algorithm, mode: "release", focusMissionId: null },
  });
}

function suggest() {
  return getSuggestionsForAgent(habitatId, agentId, 50);
}

function setGoal(missionId: string) {
  habitatRepo.updateHabitat(habitatId, {
    roadmapSettings: {
      scoringAlgorithm: "goal_directed",
      mode: "release",
      focusMissionId: missionId,
    },
  });
}

describe("goal_directed strategy (RM-15)", () => {
  it("boosts the focus goal's prerequisite chain; an unrelated mission gets no boost", () => {
    // Goal G depends on P (so P is a prerequisite, depth 1). X is unrelated.
    const g = seedMission("M-goal");
    const p = seedMission("M-prereq");
    const x = seedMission("M-unrelated");
    dependencyRepo.addMissionDependency(g.id, p.id); // G depends on P
    const pTask = seedTask(p.id, "P-task");
    const xTask = seedTask(x.id, "X-task");
    setGoal(g.id);

    const map = new Map(suggest().suggestions.map((s) => [s.taskId, s]));
    // P's task is on the goal's prerequisite chain → boosted.
    expect(map.get(pTask.id)!.factors.dependencyBonus).toBeGreaterThan(0);
    expect(map.get(pTask.id)!.reasons).toContain("Advances focus goal (1 prerequisite hop away)");
    // X is unrelated to the goal → no goal boost.
    expect(map.get(xTask.id)!.factors.dependencyBonus).toBe(0);
  });

  it("self-derives the goal as the highest-fan-out mission when no focus is set", () => {
    // P has two dependents (G1, G2) → highest fan-out. X has none.
    const p = seedMission("M-bottleneck");
    const g1 = seedMission("M-g1");
    const g2 = seedMission("M-g2");
    const x = seedMission("M-loner");
    dependencyRepo.addMissionDependency(g1.id, p.id);
    dependencyRepo.addMissionDependency(g2.id, p.id);
    const pTask = seedTask(p.id, "P-task");
    const xTask = seedTask(x.id, "X-task");
    // goal_directed, NO explicit focus → self-derive.
    setAlgorithm("goal_directed");

    const map = new Map(suggest().suggestions.map((s) => [s.taskId, s]));
    // P self-derives as the goal (highest fan-out); its own task is the focus (depth 0).
    expect(map.get(pTask.id)!.factors.dependencyBonus).toBeGreaterThan(0);
    expect(map.get(pTask.id)!.reasons).toContain("Focus goal");
    // X is not the derived goal and not in its chain → no boost.
    expect(map.get(xTask.id)!.factors.dependencyBonus).toBe(0);
  });
});

describe("depth_from_root strategy", () => {
  it("boosts root-mission tasks over deeper-mission tasks (foundational-first)", () => {
    setAlgorithm("depth_from_root");
    const mRoot = seedMission("M-root"); // depth 0
    const mDeep = seedMission("M-deep"); // will depend on a done root → depth 1
    const mOtherRoot = seedMission("M-other-root"); // depth 0
    // mDeep depends on mRoot; complete mRoot so mDeep's tasks become available.
    dependencyRepo.addMissionDependency(mDeep.id, mRoot.id);
    missionRepo.updateMission(mRoot.id, { status: "done" });

    const deepTask = seedTask(mDeep.id, "deep-task");
    const rootTask = seedTask(mOtherRoot.id, "root-task");

    const map = new Map(suggest().suggestions.map((s) => [s.taskId, s]));
    const rootBonus = map.get(rootTask.id)!.factors.dependencyBonus;
    const deepBonus = map.get(deepTask.id)!.factors.dependencyBonus;
    expect(rootBonus).toBeGreaterThan(deepBonus);
    expect(map.get(rootTask.id)!.reasons).toContain("Foundational mission (depth 0 from root)");
  });
});

describe("release_proximity strategy", () => {
  it("boosts tasks whose mission gate was just resolved by a recent release", () => {
    setAlgorithm("release_proximity");
    // Recent release that satisfies a minor gate.
    releaseRepo.create({
      habitatId,
      version: "0.1.0",
      releaseType: "minor",
      detectedBy: "api",
    });
    const gated = seedMission("M-gated", { releaseGateType: "minor" });
    const gatedTask = seedTask(gated.id, "gated-task");
    const plain = seedMission("M-plain");
    const plainTask = seedTask(plain.id, "plain-task");

    const map = new Map(suggest().suggestions.map((s) => [s.taskId, s]));
    expect(map.get(gatedTask.id)!.factors.dependencyBonus).toBeGreaterThan(0);
    expect(map.get(gatedTask.id)!.reasons).toContain("Gate just resolved by recent release");
    expect(map.get(plainTask.id)!.factors.dependencyBonus).toBe(0);
  });
});

describe("algorithm selection (RM-5)", () => {
  it("default is fanout (Unblocks reason); switching to depth_from_root changes the reason", () => {
    const a = seedTask(seedMission("M-A").id, "A");
    const b = seedTask(seedMission("M-B").id, "B");
    dependencyRepo.addTaskDependency(b.id, a.id);

    // Default (no setting) → fanout reason.
    let map = new Map(suggest().suggestions.map((s) => [s.taskId, s]));
    expect(map.get(a.id)!.reasons).toContain("Unblocks 1 downstream task");

    setAlgorithm("depth_from_root");
    map = new Map(suggest().suggestions.map((s) => [s.taskId, s]));
    expect(map.get(a.id)!.reasons).toContain("Foundational mission (depth 0 from root)");
  });
});
