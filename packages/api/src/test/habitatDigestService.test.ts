import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import { habitats, columns, missions, tasks } from "../db/schema/index.js";
import { generateAllDigests } from "../services/habitatDigestService.js";

describe("habitatDigestService", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  afterEach(() => {
    closeDb();
  });

  function setupHabitat(name: string) {
    const habitat = habitatRepo.createHabitat({ name });
    const col = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
    });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: col.id,
      title: `${name} Mission`,
      createdBy: "test",
    });
    return { habitat, col, mission };
  }

  it("skips habitats with no task activity", () => {
    setupHabitat("Empty Habitat");

    const results = generateAllDigests();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const hr = results.find((r: any) => r.summary.includes("Empty Habitat"));
    expect(hr).toBeDefined();
    expect(hr!.pulseId).toBeNull();
  });

  it("generates a context pulse for habitats with task activity", () => {
    const { habitat, mission } = setupHabitat("Active Habitat");
    taskRepo.createTask({
      missionId: mission.id,
      title: "Pending task",
      priority: "high",
      createdBy: "test",
    });

    const results = generateAllDigests();

    const hr = results.find((r: any) => r.habitatId === habitat.id);
    expect(hr).toBeDefined();
    expect(hr!.pulseId).toBeTruthy();
    expect(hr!.summary).toContain("1 pending task");
  });

  it("created pulse has correct shape", () => {
    const { habitat, mission } = setupHabitat("Shape Test");
    taskRepo.createTask({
      missionId: mission.id,
      title: "A task",
      priority: "medium",
      createdBy: "test",
    });

    const results = generateAllDigests();
    const hr = results.find((r: any) => r.habitatId === habitat.id);
    const pulse = pulseRepo.getPulseById(hr!.pulseId!);

    expect(pulse).toBeDefined();
    expect(pulse!.scope).toBe("habitat");
    expect(pulse!.subject).toContain("Daily digest");
    expect((pulse!.metadata as any).nudgeType).toBe("daily_digest");
  });

  it("includes multiple task statuses in summary", () => {
    const { habitat, mission } = setupHabitat("Multi Status");
    taskRepo.createTask({
      missionId: mission.id,
      title: "Task 1",
      priority: "medium",
      createdBy: "test",
    });
    const t2 = taskRepo.createTask({
      missionId: mission.id,
      title: "Task 2",
      priority: "medium",
      createdBy: "test",
    });
    taskRepo.updateTask(t2.id, { status: "in_progress" } as any);

    const results = generateAllDigests();
    const hr = results.find((r: any) => r.habitatId === habitat.id);

    expect(hr!.summary).toContain("1 pending task");
    expect(hr!.summary).toContain("1 in progress");
  });

  it("handles multiple habitats", () => {
    const { habitat: h1, mission: m1 } = setupHabitat("H1");
    const { habitat: h2, mission: m2 } = setupHabitat("H2");
    taskRepo.createTask({ missionId: m1.id, title: "T1", priority: "medium", createdBy: "test" });
    taskRepo.createTask({ missionId: m2.id, title: "T2", priority: "medium", createdBy: "test" });

    const results = generateAllDigests();

    const r1 = results.find((r: any) => r.habitatId === h1.id);
    const r2 = results.find((r: any) => r.habitatId === h2.id);
    expect(r1!.pulseId).toBeTruthy();
    expect(r2!.pulseId).toBeTruthy();
  });
});
