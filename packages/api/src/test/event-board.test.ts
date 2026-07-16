import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as columnRepo from "../repositories/column.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import { getEventsByHabitatId, getHabitatStats } from "../repositories/events/event-board.js";
import { agents, columns, habitats, missions, taskEvents, tasks } from "../db/schema/index.js";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function createHabitatFixture(name: string) {
  const habitat = habitatRepo.createHabitat({ name });
  const todo = columnRepo.createColumn({
    habitatId: habitat.id,
    name: `${name} Todo`,
    order: 0,
    requiresClaim: false,
  });
  const done = columnRepo.createColumn({
    habitatId: habitat.id,
    name: `${name} Done`,
    order: 1,
    requiresClaim: false,
    isTerminal: true,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: todo.id,
    title: `${name} Mission`,
    createdBy: "test-user",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: `${name} Task`,
    createdBy: "test-user",
  });

  return { habitat, todo, done, mission, task };
}

function insertEvent(input: {
  id: string;
  taskId: string;
  actorType?: "human" | "agent" | "system";
  actorId?: string;
  action: "created" | "claimed" | "started" | "completed" | "moved" | "updated";
  timestamp: string;
  fromColumnId?: string | null;
  toColumnId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  metadata?: Record<string, unknown>;
}) {
  getDb()
    .insert(taskEvents)
    .values({
      id: input.id,
      taskId: input.taskId,
      actorType: input.actorType ?? "human",
      actorId: input.actorId ?? "user-1",
      action: input.action,
      fromColumnId: input.fromColumnId ?? null,
      toColumnId: input.toColumnId ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      metadata: input.metadata ?? {},
      timestamp: input.timestamp,
    })
    .run();
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
  db.delete(agents).run();
});

afterEach(() => {
  closeDb();
});

describe("event-board repository", () => {
  describe("getEventsByHabitatId", () => {
    it("returns an empty page when the habitat has no missions", () => {
      const habitat = habitatRepo.createHabitat({ name: "Empty Habitat" });

      const result = getEventsByHabitatId(habitat.id, 10, 0);

      expect(result).toEqual({ events: [], total: 0 });
    });

    it("returns enriched events scoped to the requested habitat", () => {
      const { agent } = agentRepo.createAgent({
        name: "event-agent",
        type: "claude-code",
        domain: "backend",
      });
      const target = createHabitatFixture("Target");
      const other = createHabitatFixture("Other");

      insertEvent({
        id: "target-event",
        taskId: target.task.id,
        actorType: "agent",
        actorId: agent.id,
        action: "moved",
        fromColumnId: target.todo.id,
        toColumnId: target.done.id,
        fromStatus: "pending",
        toStatus: "done",
        metadata: { reason: "finished" },
        timestamp: "2026-01-02T00:00:00.000Z",
      });
      insertEvent({
        id: "other-event",
        taskId: other.task.id,
        action: "updated",
        timestamp: "2026-01-03T00:00:00.000Z",
      });

      const result = getEventsByHabitatId(target.habitat.id, 10, 0);

      expect(result.total).toBe(1);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        id: "target-event",
        taskId: target.task.id,
        taskTitle: target.task.title,
        habitatId: target.habitat.id,
        actorType: "agent",
        actorId: agent.id,
        actorName: "event-agent",
        action: "moved",
        fromColumnId: target.todo.id,
        toColumnId: target.done.id,
        fromColumnName: "Target Todo",
        toColumnName: "Target Done",
        fromStatus: "pending",
        toStatus: "done",
        metadata: { reason: "finished" },
        timestamp: "2026-01-02T00:00:00.000Z",
      });
    });

    it("applies action and actor filters while preserving the total across pagination", () => {
      const { agent } = agentRepo.createAgent({
        name: "filter-agent",
        type: "codex",
        domain: "backend",
      });
      const fixture = createHabitatFixture("Filtered");

      insertEvent({
        id: "match-newer",
        taskId: fixture.task.id,
        actorType: "agent",
        actorId: agent.id,
        action: "completed",
        timestamp: "2026-01-04T00:00:00.000Z",
      });
      insertEvent({
        id: "match-older",
        taskId: fixture.task.id,
        actorType: "agent",
        actorId: agent.id,
        action: "claimed",
        timestamp: "2026-01-03T00:00:00.000Z",
      });
      insertEvent({
        id: "wrong-action",
        taskId: fixture.task.id,
        actorType: "agent",
        actorId: agent.id,
        action: "updated",
        timestamp: "2026-01-02T00:00:00.000Z",
      });
      insertEvent({
        id: "wrong-actor",
        taskId: fixture.task.id,
        actorType: "human",
        actorId: "user-1",
        action: "completed",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const result = getEventsByHabitatId(fixture.habitat.id, 1, 1, {
        action: ["claimed", "completed"],
        actorType: "agent",
        actorId: agent.id,
      });

      expect(result.total).toBe(2);
      expect(result.events.map((event) => event.id)).toEqual(["match-older"]);
    });

    it("applies the since filter", () => {
      const fixture = createHabitatFixture("Since");
      insertEvent({
        id: "old-event",
        taskId: fixture.task.id,
        action: "created",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      insertEvent({
        id: "new-event",
        taskId: fixture.task.id,
        action: "updated",
        timestamp: "2026-01-03T00:00:00.000Z",
      });

      const result = getEventsByHabitatId(fixture.habitat.id, 10, 0, {
        since: "2026-01-02T00:00:00.000Z",
      });

      expect(result.total).toBe(1);
      expect(result.events.map((event) => event.id)).toEqual(["new-event"]);
    });
  });

  describe("getHabitatStats", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns zero stats when the habitat has no missions", () => {
      const habitat = habitatRepo.createHabitat({ name: "Stats Empty" });

      const result = getHabitatStats(habitat.id);

      expect(result).toEqual({
        cycleTime: { averageMinutes: 0, medianMinutes: 0, count: 0 },
        throughput: { today: 0, thisWeek: 0, thisMonth: 0 },
        wipHealth: [],
        missionSummary: {
          total: 0,
          completed: 0,
          blocked: 0,
          byStatus: { not_started: 0, in_progress: 0, review: 0, done: 0, failed: 0 },
        },
      });
    });

    it("computes cycle time and throughput for completed task events", () => {
      const fixture = createHabitatFixture("Stats");
      insertEvent({
        id: "claimed-event",
        taskId: fixture.task.id,
        action: "claimed",
        timestamp: minutesAgo(90),
      });
      insertEvent({
        id: "completed-event",
        taskId: fixture.task.id,
        action: "completed",
        timestamp: minutesAgo(30),
      });

      const result = getHabitatStats(fixture.habitat.id);

      expect(result).toEqual({
        cycleTime: { averageMinutes: 60, medianMinutes: 60, count: 1 },
        throughput: { today: 1, thisWeek: 1, thisMonth: 1 },
        wipHealth: [],
        missionSummary: {
          total: 0,
          completed: 0,
          blocked: 0,
          byStatus: { not_started: 0, in_progress: 0, review: 0, done: 0, failed: 0 },
        },
      });
    });
  });
});
