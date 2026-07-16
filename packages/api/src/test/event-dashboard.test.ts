import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as columnRepo from "../repositories/column.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import { getDashboardStats } from "../repositories/events/event-dashboard.js";
import {
  agents,
  columns,
  habitats,
  missions,
  taskEvents,
  tasks,
  webhookDeliveries,
  webhookSubscriptions,
} from "../db/schema/index.js";

const NOW = new Date("2026-05-27T12:00:00.000Z");

function iso(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}

function createTask(input: {
  missionId: string;
  title: string;
  priority?: "low" | "medium" | "high" | "critical";
  status?: "pending" | "claimed" | "in_progress" | "submitted" | "approved" | "done" | "failed";
  agentId?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
}) {
  const task = taskRepo.createTask({
    missionId: input.missionId,
    title: input.title,
    priority: input.priority ?? "medium",
    createdBy: "test-user",
  });

  getDb()
    .update(tasks)
    .set({
      status: input.status ?? "pending",
      assignedAgentId: input.agentId ?? null,
      claimedAt: input.claimedAt ?? null,
      completedAt: input.completedAt ?? null,
    })
    .where(eq(tasks.id, task.id))
    .run();

  return task;
}

function insertEvent(input: {
  id: string;
  taskId: string;
  actorId: string;
  action: "submitted" | "approved" | "rejected" | "completed";
  timestamp: string;
}) {
  getDb()
    .insert(taskEvents)
    .values({
      id: input.id,
      taskId: input.taskId,
      actorType: "agent",
      actorId: input.actorId,
      action: input.action,
      metadata: {},
      timestamp: input.timestamp,
    })
    .run();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await initTestDb();
  const db = getDb();
  db.delete(webhookDeliveries).run();
  db.delete(webhookSubscriptions).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
  db.delete(agents).run();
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe("event-dashboard repository", () => {
  it("returns zero-shaped dashboard stats for an empty database", () => {
    const result = getDashboardStats(undefined, "7d");

    expect(result).toEqual({
      throughput: [],
      cycleTime: [],
      rejectionRate: [],
      agentLeaderboard: [],
      taskByPriority: { critical: 0, high: 0, medium: 0, low: 0 },
      taskByStatus: { pending: 0, claimed: 0, in_progress: 0, submitted: 0, done: 0 },
      wipHealth: [],
      webhookStats: { total: 0, success: 0, failed: 0, pending: 0, successRate: 0 },
      summary: {
        totalTasksCompleted: 0,
        totalTasksInProgress: 0,
        averageCycleTimeMinutes: 0,
        overallRejectionRate: 0,
        activeAgents: 0,
      },
    });
  });

  it("aggregates dashboard stats for the requested habitat", () => {
    const { agent } = agentRepo.createAgent({
      name: "dashboard-agent",
      type: "claude-code",
      domain: "backend",
    });
    const otherAgent = agentRepo.createAgent({
      name: "other-dashboard-agent",
      type: "codex",
      domain: "frontend",
    }).agent;
    const habitat = habitatRepo.createHabitat({ name: "Dashboard Habitat" });
    const todo = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      wipLimit: 1,
      requiresClaim: false,
    });
    const doing = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Doing",
      order: 1,
      wipLimit: 5,
      requiresClaim: false,
    });
    const targetMission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: todo.id,
      title: "Target Mission",
      createdBy: "test-user",
    });
    const doingMission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: doing.id,
      title: "Doing Mission",
      createdBy: "test-user",
    });

    const completed = createTask({
      missionId: targetMission.id,
      title: "Completed",
      priority: "critical",
      status: "approved",
      agentId: agent.id,
      claimedAt: iso(120),
      completedAt: iso(60),
    });
    createTask({
      missionId: targetMission.id,
      title: "Claimed",
      priority: "high",
      status: "claimed",
      agentId: agent.id,
    });
    createTask({
      missionId: targetMission.id,
      title: "Pending",
      priority: "low",
      status: "pending",
    });
    createTask({
      missionId: doingMission.id,
      title: "In progress one",
      priority: "medium",
      status: "in_progress",
      agentId: agent.id,
    });
    createTask({
      missionId: doingMission.id,
      title: "Submitted one",
      priority: "medium",
      status: "submitted",
      agentId: agent.id,
    });
    createTask({
      missionId: doingMission.id,
      title: "Doing pending one",
      priority: "medium",
      status: "pending",
    });
    createTask({
      missionId: doingMission.id,
      title: "Doing pending two",
      priority: "medium",
      status: "pending",
    });

    const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
    const otherColumn = columnRepo.createColumn({
      habitatId: otherHabitat.id,
      name: "Other Todo",
      order: 0,
      requiresClaim: false,
    });
    const otherMission = missionRepo.createMission({
      habitatId: otherHabitat.id,
      columnId: otherColumn.id,
      title: "Other Mission",
      createdBy: "test-user",
    });
    const otherTask = createTask({
      missionId: otherMission.id,
      title: "Other Completed",
      status: "approved",
      agentId: otherAgent.id,
      claimedAt: iso(100),
      completedAt: iso(20),
    });

    insertEvent({
      id: "target-completed",
      taskId: completed.id,
      actorId: agent.id,
      action: "completed",
      timestamp: iso(55),
    });
    insertEvent({
      id: "target-submitted",
      taskId: completed.id,
      actorId: agent.id,
      action: "submitted",
      timestamp: iso(50),
    });
    insertEvent({
      id: "target-approved",
      taskId: completed.id,
      actorId: agent.id,
      action: "approved",
      timestamp: iso(45),
    });
    insertEvent({
      id: "target-rejected",
      taskId: completed.id,
      actorId: agent.id,
      action: "rejected",
      timestamp: iso(40),
    });
    insertEvent({
      id: "other-completed",
      taskId: otherTask.id,
      actorId: otherAgent.id,
      action: "completed",
      timestamp: iso(10),
    });

    const result = getDashboardStats(habitat.id, "7d");

    expect(result.throughput).toEqual([{ date: "2026-05-27", count: 1 }]);
    expect(result.cycleTime).toEqual([{ date: "2026-05-27", avgMinutes: 60, medianMinutes: 60 }]);
    expect(result.rejectionRate).toEqual([{ date: "2026-05-27", rejections: 1, total: 3 }]);
    expect(result.agentLeaderboard).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        agentName: "dashboard-agent",
        completed: 1,
        failed: 0,
        avgCycleMinutes: 60,
        approvalRate: 1,
      }),
    ]);
    expect(result.taskByPriority).toEqual({ critical: 1, high: 1, medium: 4, low: 1 });
    expect(result.taskByStatus).toEqual({
      pending: 3,
      claimed: 1,
      in_progress: 1,
      submitted: 1,
      done: 1,
    });
    expect(result.wipHealth).toEqual([
      expect.objectContaining({ columnId: todo.id, current: 2, limit: 1, health: "exceeded" }),
      expect.objectContaining({ columnId: doing.id, current: 4, limit: 5, health: "warning" }),
    ]);
    expect(result.summary).toEqual({
      totalTasksCompleted: 1,
      totalTasksInProgress: 3,
      averageCycleTimeMinutes: 60,
      overallRejectionRate: 0.33,
      activeAgents: 1,
    });
  });

  it("computes median cycle time independently from average cycle time", () => {
    const { agent } = agentRepo.createAgent({
      name: "median-agent",
      type: "claude-code",
      domain: "backend",
    });
    const habitat = habitatRepo.createHabitat({ name: "Median Habitat" });
    const column = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Median Mission",
      createdBy: "test-user",
    });

    const durations = [10, 20, 90];
    for (const duration of durations) {
      createTask({
        missionId: mission.id,
        title: `Cycle ${duration}`,
        status: "approved",
        agentId: agent.id,
        claimedAt: iso(120 + duration),
        completedAt: iso(120),
      });
    }

    const result = getDashboardStats(habitat.id, "7d");

    expect(result.cycleTime).toEqual([{ date: "2026-05-27", avgMinutes: 40, medianMinutes: 20 }]);
  });
});
