import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { createHabitat } from "../services/habitatService.js";
import { createMission } from "../repositories/mission.js";
import { createTask } from "../repositories/task.js";
import { tasks } from "../db/schema/index.js";
import { getHabitatMetrics } from "../repositories/timeTracking.js";

beforeEach(async () => {
  await initTestDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T12:00:00.500Z"));
});
afterEach(() => { vi.useRealTimers(); closeDb(); });

it("counts an open task whose Mission ISO deadline passed earlier today", () => {
  const { habitat, columns } = createHabitat({ name: "Overdue metrics", defaultColumns: true });
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const mission = createMission({ habitatId: habitat.id, columnId: columns[0].id,
    title: "Due Mission", createdBy: "test-user", dueAt });
  createTask({ missionId: mission.id, title: "Open task", createdBy: "test-user" });
  expect(getHabitatMetrics(habitat.id).overdueTasks).toBe(1);
});

it("uses the controlled clock at the real SQLite time boundary", () => {
  expect(getDb().get(sql`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`))
    .toEqual({ now: "2026-10-17T12:00:00.500Z" });
});

const instants = [
  ["same-day before", "2026-10-17T11:59:59.999Z", 1],
  ["one millisecond before", "2026-10-17T12:00:00.499Z", 1],
  ["equal", "2026-10-17T12:00:00.500Z", 0],
  ["one millisecond after", "2026-10-17T12:00:00.501Z", 0],
  ["previous UTC day", "2026-10-16T23:59:59.999Z", 1],
  ["next UTC day", "2026-10-18T00:00:00.000Z", 0],
  ["equal positive offset", "2026-10-17T17:30:00.500+05:30", 0],
  ["overdue positive offset", "2026-10-17T17:30:00.499+05:30", 1],
  ["future negative offset", "2026-10-17T07:00:00.501-05:00", 0],
  ["legacy SQLite timestamp", "2026-10-17 11:59:59.999", 1],
  ["date only", "2026-10-17", 1],
  ["null", null, 0],
  ["malformed", "not a date", 0],
  ["empty", "", 0],
] as const;

it.each(instants)("compares the Mission deadline as an instant: %s", (_name, dueAt, expected) => {
  const { habitat, columns } = createHabitat({ name: "Boundary metrics", defaultColumns: true });
  const mission = createMission({ habitatId: habitat.id, columnId: columns[0].id,
    title: "Deadline boundary", createdBy: "test-user", dueAt });
  createTask({ missionId: mission.id, title: "Open task", createdBy: "test-user" });
  expect(getHabitatMetrics(habitat.id).overdueTasks).toBe(expected);
});

it.each(["done", "approved", "failed"] as const)("excludes %s tasks despite an overdue Mission", (status) => {
  const { habitat, columns } = createHabitat({ name: "Terminal metrics", defaultColumns: true });
  const mission = createMission({ habitatId: habitat.id, columnId: columns[0].id,
    title: "Overdue Mission", createdBy: "test-user", dueAt: "2026-10-17T11:00:00.000Z" });
  const task = createTask({ missionId: mission.id, title: "Terminal task", createdBy: "test-user" });
  getDb().update(tasks).set({ status }).where(eq(tasks.id, task.id)).run();
  expect(getHabitatMetrics(habitat.id).overdueTasks).toBe(0);
});

it("counts only this Habitat's open tasks and inherits their Mission deadline", () => {
  const first = createHabitat({ name: "First Habitat", defaultColumns: true });
  const second = createHabitat({ name: "Second Habitat", defaultColumns: true });
  for (const fixture of [first, second]) {
    const mission = createMission({ habitatId: fixture.habitat.id, columnId: fixture.columns[0].id,
      title: "Overdue Mission", createdBy: "test-user", dueAt: "2026-10-17T11:00:00.000Z" });
    createTask({ missionId: mission.id, title: "First open task", createdBy: "test-user" });
    createTask({ missionId: mission.id, title: "Second open task", createdBy: "test-user" });
  }
  expect(getHabitatMetrics(first.habitat.id).overdueTasks).toBe(2);
  expect(getHabitatMetrics("missing-habitat").overdueTasks).toBe(0);
});
