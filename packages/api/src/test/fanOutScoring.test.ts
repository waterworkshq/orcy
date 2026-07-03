import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as dependencyRepo from "../repositories/dependency.js";
import { getSuggestionsForAgent } from "../services/taskSuggestion.js";

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Fanout Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Seed Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;

  const { agent } = agentRepo.createAgent({
    name: "Fanout Bot",
    type: "codex",
    domain: "backend",
    capabilities: [],
  });
  agentId = agent.id;
});

afterEach(() => closeDb());

function seedTask(title: string) {
  return taskRepo.createTask({
    missionId,
    title,
    createdBy: "user-1",
  });
}

function suggest() {
  return getSuggestionsForAgent(habitatId, agentId, 50);
}

/**
 * AC-GUIDE-1 — `dependencyBonus` is computed (not 0) when dependency edges
 * exist: a task with N blocked dependents scores higher than a task with 0.
 *
 * Note: dependents (B, C) are NOT in the suggestion set — they are blocked by
 * their unmet dep on A. The unblocker (A) is the suggested task, and its
 * `dependencyBonus` reflects its downstream fan-out.
 */
describe("AC-GUIDE-1: dependencyBonus is non-zero for tasks that unblock others", () => {
  it("task A (blocks B, C) has dependencyBonus > 0; a peer with no dependents has 0", () => {
    const a = seedTask("A - unblocks others");
    const b = seedTask("B - blocked by A");
    const c = seedTask("C - blocked by A");
    const peer = seedTask("peer - no dependents");
    dependencyRepo.addTaskDependency(b.id, a.id);
    dependencyRepo.addTaskDependency(c.id, a.id);

    const result = suggest();
    const map = new Map(result.suggestions.map((s) => [s.taskId, s]));

    // A is available (no deps); its fan-out bonus reflects 2 dependents.
    const aSuggestion = map.get(a.id);
    expect(aSuggestion).toBeDefined();
    expect(aSuggestion!.factors.dependencyBonus).toBeGreaterThan(0);

    // The peer task is also available but unblocks nothing — bonus 0.
    const peerSuggestion = map.get(peer.id);
    expect(peerSuggestion).toBeDefined();
    expect(peerSuggestion!.factors.dependencyBonus).toBe(0);

    // B and C are filtered out by getAvailableTasksForAgent (unmet deps).
    expect(map.has(b.id)).toBe(false);
    expect(map.has(c.id)).toBe(false);
  });

  it("dependencyBonus scales with fan-out (more downstream → larger bonus, capped)", () => {
    const aLow = seedTask("A-low-fanout");
    const aHigh = seedTask("A-high-fanout");

    // aLow unblocks 1 task.
    const lowDep = seedTask("low-dep");
    dependencyRepo.addTaskDependency(lowDep.id, aLow.id);

    // aHigh unblocks 5 tasks.
    for (let i = 0; i < 5; i++) {
      const dep = seedTask(`high-dep-${i}`);
      dependencyRepo.addTaskDependency(dep.id, aHigh.id);
    }

    const result = suggest();
    const map = new Map(result.suggestions.map((s) => [s.taskId, s]));
    expect(map.get(aHigh.id)!.factors.dependencyBonus).toBeGreaterThan(
      map.get(aLow.id)!.factors.dependencyBonus,
    );
  });
});

/**
 * AC-GUIDE-2 — the `reasons` array includes "Unblocks N downstream task(s)" when
 * `dependencyBonus > 0`.
 */
describe("AC-GUIDE-2: reasons surface the unblock signal", () => {
  it("task A (blocks 2 tasks) has a reason 'Unblocks 2 downstream tasks'", () => {
    const a = seedTask("A");
    const b = seedTask("B");
    const c = seedTask("C");
    dependencyRepo.addTaskDependency(b.id, a.id);
    dependencyRepo.addTaskDependency(c.id, a.id);

    const result = suggest();
    const aSuggestion = result.suggestions.find((s) => s.taskId === a.id)!;

    expect(aSuggestion.factors.dependencyBonus).toBeGreaterThan(0);
    expect(aSuggestion.reasons).toContain("Unblocks 2 downstream tasks");
  });

  it("task that blocks a single dependent carries a singular reason string", () => {
    const a = seedTask("solo-unblocker");
    const b = seedTask("dependent");
    dependencyRepo.addTaskDependency(b.id, a.id);

    const result = suggest();
    const aSuggestion = result.suggestions.find((s) => s.taskId === a.id)!;

    expect(aSuggestion.reasons).toContain("Unblocks 1 downstream task");
  });
});

/**
 * AC-GUIDE-3 — all else equal, a task that unblocks more downstream work ranks
 * above one that unblocks less.
 */
describe("AC-GUIDE-3: higher-fan-out task ranks above lower-fan-out task", () => {
  it("the high-fan-out task appears before the low-fan-out task in the ranked list", () => {
    const lowFan = seedTask("low-fan");
    const highFan = seedTask("high-fan");

    // Equal-priority dependents (so the only differentiator is fan-out).
    for (let i = 0; i < 1; i++) {
      const dep = seedTask(`low-dep-${i}`);
      dependencyRepo.addTaskDependency(dep.id, lowFan.id);
    }
    for (let i = 0; i < 4; i++) {
      const dep = seedTask(`high-dep-${i}`);
      dependencyRepo.addTaskDependency(dep.id, highFan.id);
    }

    const result = suggest();
    const ranks = new Map(result.suggestions.map((s, i) => [s.taskId, i]));

    // Lower rank index = higher position. highFan should outrank lowFan.
    expect(ranks.get(highFan.id)!).toBeLessThan(ranks.get(lowFan.id)!);
    expect(result.suggestions[ranks.get(highFan.id)!].score).toBeGreaterThan(
      result.suggestions[ranks.get(lowFan.id)!].score,
    );
  });
});

/**
 * AC-GUIDE-4 — when the DAG has no dependency edges, `dependencyBonus` is 0 for
 * all tasks (no behaviour change from the pre-v0.25.0 hardcoded 0).
 */
describe("AC-GUIDE-4: empty DAG → all dependencyBonus = 0 (no behaviour change)", () => {
  it("tasks with no dependency edges all score dependencyBonus = 0", () => {
    const t1 = seedTask("t1");
    const t2 = seedTask("t2");
    const t3 = seedTask("t3");

    const result = suggest();
    const map = new Map(result.suggestions.map((s) => [s.taskId, s]));

    expect(map.get(t1.id)!.factors.dependencyBonus).toBe(0);
    expect(map.get(t2.id)!.factors.dependencyBonus).toBe(0);
    expect(map.get(t3.id)!.factors.dependencyBonus).toBe(0);

    // And no "Unblocks …" reason fires.
    for (const s of result.suggestions) {
      expect(s.reasons.some((r) => r.startsWith("Unblocks"))).toBe(false);
    }
  });
});
