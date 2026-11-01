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
import { MISSION_ID_CHUNK_SIZE, getMissionsByIds } from "../repositories/mission.js";
import { getSuggestionsForAgent } from "../services/taskSuggestion.js";

// --- PR151 corrective: bounded per-pass suggestion query work -----------------
//
// The suggestion pass (`getSuggestionsForAgent` -> `getAvailableTasksForAgent`
// -> scoring strategies) must issue a BOUNDED number of statements regardless
// of how many missions/tasks the habitat has. The pre-fix pass issued:
//   - ONE missionDependencies query PER habitat mission (eligibility filter),
//   - ONE getMissionById PER DISTINCT mission (titles) plus ONE PER TASK
//     (SLA deadlines) and, under release_proximity, ONE PER TASK (gate check).
// These tests pin the WORK (exact prepare counts against the real sql.js DB)
// and the PARITY (identical suggestion output semantics). A regression back to
// per-mission or per-task reads fails on statement counts.
//
// Instrumentation: every drizzle sql.js query goes through
// `client.prepare(sql)` (same instrumentation as
// notificationEmailAuthorization.test.ts). Drizzle's projected `.all()`
// prepares the same SQL TWICE (once discarded in `all()`, once inside
// `values()`); `.get()` prepares ONCE. Counts below acknowledge those
// driver double-prepares — the bound is on DISTINCT logical queries, not
// raw prepares.

interface HabitatWorld {
  habitatId: string;
  columnId: string;
  agentId: string;
}

function seedHabitatWorld(name: string): HabitatWorld {
  const habitat = habitatRepo.createHabitat({ name });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const { agent } = agentRepo.createAgent({
    name: `agent-${name}`,
    type: "codex",
    domain: "backend",
    capabilities: [],
  });
  return { habitatId: habitat.id, columnId: column.id, agentId: agent.id };
}

function seedMission(
  world: HabitatWorld,
  title: string,
  opts: { releaseGateType?: "patch" | "minor" | "major"; displayOrder?: number } = {},
) {
  return missionRepo.createMission({
    habitatId: world.habitatId,
    columnId: world.columnId,
    title,
    createdBy: "user-1",
    releaseGateType: opts.releaseGateType,
    displayOrder: opts.displayOrder,
  });
}

function seedTask(missionId: string, title: string) {
  return taskRepo.createTask({ missionId, title, createdBy: "user-1" });
}

function setAlgorithm(
  world: HabitatWorld,
  algorithm: "fanout" | "depth_from_root" | "release_proximity" | "goal_directed" | "critical_path",
) {
  habitatRepo.updateHabitat(world.habitatId, {
    roadmapSettings: { scoringAlgorithm: algorithm, mode: "release", focusMissionId: null },
  });
}

function capturePreparedStatements(run: () => unknown): string[] {
  const client = (
    getDb() as unknown as {
      session: { client: { prepare: (source: string) => unknown } };
    }
  ).session.client;
  const statements: string[] = [];
  const originalPrepare = client.prepare;
  client.prepare = (source: string) => {
    statements.push(source);
    return originalPrepare.call(client, source);
  };
  try {
    run();
  } finally {
    client.prepare = originalPrepare;
  }
  return statements;
}

/** Prepared-statement count whose SQL reads a given table (`from "missions"`). */
function preparesFrom(statements: string[], table: string): string[] {
  return statements.filter((s) => s.includes(`from "${table}"`));
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();
});

afterEach(() => closeDb());

describe("mission-eligibility query work (getAvailableTasksForAgent)", () => {
  it("issues ONE habitat-keyed missionDependencies query regardless of habitat mission count", () => {
    const world = seedHabitatWorld("Eligibility Habitat");
    // 12 missions across the eligibility matrix:
    //  - 4 blocked by an unmet mission dependency,
    //  - 2 with a MET dependency (dependsOn is done),
    //  - 2 gated by an unsatisfied release gate (no releases shipped),
    //  - 4 plain eligible.
    const depTargets = [seedMission(world, "dep-target-unmet-1"), seedMission(world, "dep-target-unmet-2")];
    const doneTarget = seedMission(world, "dep-target-done");
    missionRepo.updateMission(doneTarget.id, { status: "done" });

    const blocked: string[] = [];
    for (let n = 0; n < 4; n++) {
      const m = seedMission(world, `blocked-${n}`);
      dependencyRepo.addMissionDependency(m.id, depTargets[n % 2].id);
      blocked.push(m.id);
    }
    const metDep: string[] = [];
    for (let n = 0; n < 2; n++) {
      const m = seedMission(world, `met-dep-${n}`);
      dependencyRepo.addMissionDependency(m.id, doneTarget.id);
      metDep.push(m.id);
    }
    const gated: string[] = [];
    for (let n = 0; n < 2; n++) gated.push(seedMission(world, `gated-${n}`, { releaseGateType: "minor" }).id);
    const plain: string[] = [];
    for (let n = 0; n < 4; n++) plain.push(seedMission(world, `plain-${n}`).id);

    const expected = new Set([...metDep, ...plain]);
    const seeded = new Set([...blocked, ...metDep, ...gated, ...plain]);
    for (const missionId of seeded) seedTask(missionId, `task-${missionId}`);

    let available: { id: string; missionId: string }[] = [];
    const statements = capturePreparedStatements(() => {
      available = taskRepo.getAvailableTasksForAgent(world.habitatId, "backend") as typeof available;
    });

    // PARITY: exactly the eligible missions' tasks — unmet deps and unsatisfied
    // gates excluded, met deps and plain included.
    expect(new Set(available.map((t) => t.missionId))).toEqual(expected);

    // WORK: the eligibility filter is ONE logical missionDependencies query.
    // (Projected `.all()` double-prepares: <= 2 prepares for 1 logical query.
    // The per-mission loop this pins out issued 12 logical queries.)
    expect(preparesFrom(statements, "mission_dependencies").length).toBeLessThanOrEqual(2);
  });

  it("cross-habitat dependency rows still block until the other habitat's mission is done", () => {
    const worldA = seedHabitatWorld("Habitat A");
    const worldB = seedHabitatWorld("Habitat B");
    const foreign = seedMission(worldB, "foreign-mission");
    const local = seedMission(worldA, "local-blocked");
    dependencyRepo.addMissionDependency(local.id, foreign.id); // A depends on B
    const localTask = seedTask(local.id, "local-task");

    const before = taskRepo.getAvailableTasksForAgent(worldA.habitatId, "backend");
    expect(before.map((t) => t.id)).not.toContain(localTask.id);

    missionRepo.updateMission(foreign.id, { status: "done" });
    const after = taskRepo.getAvailableTasksForAgent(worldA.habitatId, "backend");
    expect(after.map((t) => t.id)).toContain(localTask.id);
  });
});

describe("suggestion-pass mission reads (getSuggestionsForAgent)", () => {
  it("default (fanout) pass reads missions in a bounded number of statements, not per task/per mission", () => {
    const world = seedHabitatWorld("Fanout Bounded");
    // 3 distinct missions / 6 tasks (2 per mission), one mission with an SLA
    // deadline so the SLA read path is exercised. No fanout edges needed —
    // the point is the mission READ work.
    const m1 = seedMission(world, "mission-one");
    const m2 = seedMission(world, "mission-two");
    const m3 = seedMission(world, "mission-three");
    missionRepo.updateMission(m3.id, { slaDeadlineAt: "2030-01-01T00:00:00.000Z" });
    const tasks = [
      seedTask(m1.id, "t1"),
      seedTask(m1.id, "t2"),
      seedTask(m2.id, "t3"),
      seedTask(m2.id, "t4"),
      seedTask(m3.id, "t5"),
      seedTask(m3.id, "t6"),
    ];

    let suggestions: ReturnType<typeof getSuggestionsForAgent>["suggestions"] = [];
    const statements = capturePreparedStatements(() => {
      suggestions = getSuggestionsForAgent(world.habitatId, world.agentId, 6).suggestions;
    });

    // PARITY: every candidate task scored, titles resolved from the batch map.
    expect(new Set(suggestions.map((s) => s.taskId))).toEqual(new Set(tasks.map((t) => t.id)));
    const titles = new Map(suggestions.map((s) => [s.missionId, s.missionTitle]));
    expect(titles.get(m1.id)).toBe("mission-one");
    expect(titles.get(m2.id)).toBe("mission-two");
    expect(titles.get(m3.id)).toBe("mission-three");
    expect(suggestions.every((s) => s.missionTitle !== "Unknown mission")).toBe(true);
    // The SLA mission's tasks keep their (zero, deadline far out) SLA factor.
    for (const s of suggestions.filter((s) => s.missionId === m3.id)) {
      expect(s.factors.slaUrgencyWeight).toBe(0);
    }

    // WORK: mission reads for the WHOLE pass = the availability habitat read
    // (1 logical, double-prepared) + the ONE chunked batched read (1 logical,
    // double-prepared). Pre-fix: + 3 title lookups + 6 per-task SLA lookups.
    expect(preparesFrom(statements, "missions").length).toBeLessThanOrEqual(4);
  });

  it("release_proximity pass performs no per-task mission queries and keeps gate parity", () => {
    const world = seedHabitatWorld("Proximity Bounded");
    setAlgorithm(world, "release_proximity");
    releaseRepo.create({
      habitatId: world.habitatId,
      version: "0.1.0",
      releaseType: "minor",
      detectedBy: "api",
    });
    const gated = seedMission(world, "gated", { releaseGateType: "minor" });
    const plain = seedMission(world, "plain");
    const gatedTasks = [seedTask(gated.id, "g1"), seedTask(gated.id, "g2"), seedTask(gated.id, "g3")];
    const plainTask = seedTask(plain.id, "p1");

    let suggestions: ReturnType<typeof getSuggestionsForAgent>["suggestions"] = [];
    const statements = capturePreparedStatements(() => {
      suggestions = getSuggestionsForAgent(world.habitatId, world.agentId, 10).suggestions;
    });

    // PARITY: freshly gate-resolved mission boosted; plain mission not.
    const byTask = new Map(suggestions.map((s) => [s.taskId, s]));
    for (const t of gatedTasks) {
      expect(byTask.get(t.id)!.factors.dependencyBonus).toBeGreaterThan(0);
      expect(byTask.get(t.id)!.reasons).toContain("Gate just resolved by recent release");
    }
    expect(byTask.get(plainTask.id)!.factors.dependencyBonus).toBe(0);
    expect(suggestions.map((s) => s.missionTitle)).not.toContain("Unknown mission");

    // WORK: same bounded shape as the default pass — the strategy reads its
    // missions from the per-pass map. Pre-fix the strategy alone issued ONE
    // getMissionById PER CANDIDATE TASK (3 here) on top of the title/SLA reads.
    expect(preparesFrom(statements, "missions").length).toBeLessThanOrEqual(4);
  });

  it("does not disclose other habitats' tasks or titles", () => {
    const worldA = seedHabitatWorld("Isolation A");
    const worldB = seedHabitatWorld("Isolation B");
    const foreignMission = seedMission(worldB, "secret-foreign-mission");
    seedTask(foreignMission.id, "secret-foreign-task");
    const localMission = seedMission(worldA, "local-mission");
    const localTask = seedTask(localMission.id, "local-task");

    const result = getSuggestionsForAgent(worldA.habitatId, worldA.agentId, 10);

    expect(result.suggestions.map((s) => s.taskId)).toEqual([localTask.id]);
    expect(result.suggestions.map((s) => s.missionTitle)).toEqual(["local-mission"]);
    expect(JSON.stringify(result)).not.toContain("secret-foreign");
  });
});

describe("chunked batched mission reads (getMissionsByIds)", () => {
  it(`chunks 501 distinct mission ids at ${MISSION_ID_CHUNK_SIZE} per statement and merges the map`, () => {
    const world = seedHabitatWorld("Chunk Habitat");
    const created: string[] = [];
    for (let n = 0; n < MISSION_ID_CHUNK_SIZE + 1; n++) {
      created.push(seedMission(world, `chunked-${n}`, { displayOrder: n }).id);
    }
    // One candidate task per mission: the suggestion pass batches over the
    // CANDIDATE missions, so 501 tasks give 501 distinct ids -> 2 chunks.
    for (const missionId of created) seedTask(missionId, `task-${missionId}`);

    const map = getMissionsByIds(created);
    // Map merge across the chunk boundary: no id lost, no id duplicated.
    expect(map.size).toBe(MISSION_ID_CHUNK_SIZE + 1);
    for (const id of created) expect(map.get(id)!.title).toMatch(/^chunked-\d+$/);

    // End-to-end: the suggestion pass issues exactly TWO id-listed logical
    // mission reads (501 ids -> chunks of 500 + 1), each double-prepared.
    let suggestions: ReturnType<typeof getSuggestionsForAgent>["suggestions"] = [];
    const statements = capturePreparedStatements(() => {
      suggestions = getSuggestionsForAgent(world.habitatId, world.agentId, 5).suggestions;
    });
    const idListed = preparesFrom(statements, "missions").filter((s) =>
      s.includes('"id" in ('),
    );
    expect(idListed).toHaveLength(4); // 2 logical chunks x driver double-prepare
    // Chunk sizes prove the boundary: one statement at the full 500 bound and
    // its double-prepare, one at the remainder of 1 and its double-prepare.
    const chunkSizes = idListed.map((s) => s.split("?").length - 1).sort((a, b) => b - a);
    expect(chunkSizes).toEqual([
      MISSION_ID_CHUNK_SIZE,
      MISSION_ID_CHUNK_SIZE,
      1,
      1,
    ]);
    // Total mission reads for the 501-mission pass stay bounded (habitat read
    // + 2 chunks), and the pass still returns scored suggestions.
    expect(suggestions).toHaveLength(5);
    expect(suggestions.every((s) => s.missionTitle.startsWith("chunked-"))).toBe(true);
    expect(preparesFrom(statements, "missions").length).toBeLessThanOrEqual(6);
  });
});
