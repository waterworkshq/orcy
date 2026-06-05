import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  agents,
  codeEvidenceCompleteness,
  codeEvidenceGaps,
  codeEvidenceLinks,
  columns,
  effortEntries,
  habitats,
  missions,
  taskEvents,
  taskTimeRecords,
  tasks,
} from "../db/schema/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as columnRepo from "../repositories/column.js";
import * as habitatRepo from "../repositories/board.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import { getAgentQualityInputs, getAgentQualitySignals } from "../services/agentQualityService.js";

const NOW = new Date("2026-06-05T12:00:00.000Z");

let habitatId: string;
let missionId: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await initTestDb();
  const db = getDb();
  db.delete(codeEvidenceGaps).run();
  db.delete(codeEvidenceCompleteness).run();
  db.delete(codeEvidenceLinks).run();
  db.delete(effortEntries).run();
  db.delete(taskTimeRecords).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
  db.delete(agents).run();

  const habitat = habitatRepo.createHabitat({ name: "Quality Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "Quality Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

function createCompletedTask(
  agentId: string,
  index: number,
  options?: {
    estimate?: number;
    actual?: number;
    evidence?: "active" | "partial" | "gap";
    rejectedCount?: number;
  },
) {
  const task = taskRepo.createTask({
    missionId,
    title: `Task ${index}`,
    createdBy: "user-1",
    estimatedMinutes: options?.estimate ?? 60,
  });
  const completedAt = new Date(NOW.getTime() - index * 60_000).toISOString();
  const claimedAt = new Date(NOW.getTime() - (index * 60_000 + 60 * 60_000)).toISOString();
  getDb()
    .update(tasks)
    .set({
      assignedAgentId: agentId,
      status: "approved",
      claimedAt,
      completedAt,
      rejectedCount: options?.rejectedCount ?? 0,
      cycleTimeMinutes: 60,
    })
    .where(eq(tasks.id, task.id))
    .run();
  getDb()
    .insert(taskEvents)
    .values({
      id: `approved-${task.id}`,
      taskId: task.id,
      actorType: "human",
      actorId: "reviewer-1",
      action: "approved",
      timestamp: completedAt,
    })
    .run();
  if (options?.rejectedCount) {
    getDb()
      .insert(taskEvents)
      .values({
        id: `rejected-${task.id}`,
        taskId: task.id,
        actorType: "human",
        actorId: "reviewer-1",
        action: "rejected",
        timestamp: claimedAt,
      })
      .run();
  }
  if (options?.actual) {
    getDb()
      .insert(effortEntries)
      .values({
        id: `effort-${task.id}`,
        taskId: task.id,
        actorType: "agent",
        actorId: agentId,
        minutes: options.actual,
        source: "agent_reported",
        recordedAt: completedAt,
      })
      .run();
  }
  if (options?.evidence === "active") {
    getDb()
      .insert(codeEvidenceLinks)
      .values({
        id: `evidence-${task.id}`,
        targetType: "task",
        targetId: task.id,
        evidenceType: "pull_request",
        evidenceId: `pr-${index}`,
        linkSource: "agent_reported",
        linkedByType: "agent",
        linkedById: agentId,
        linkedAt: completedAt,
        status: "active",
      })
      .run();
  }
  if (options?.evidence === "partial") {
    getDb()
      .insert(codeEvidenceCompleteness)
      .values({
        targetType: "task",
        targetId: task.id,
        status: "partial",
        markedByType: "system",
        markedById: "system",
        createdAt: completedAt,
        updatedAt: completedAt,
      })
      .run();
  }
  if (options?.evidence === "gap") {
    getDb()
      .insert(codeEvidenceGaps)
      .values({
        id: `gap-${task.id}`,
        targetType: "task",
        targetId: task.id,
        reasonCode: "missing_pr",
        status: "active",
        reportedByType: "system",
        reportedById: "system",
        reportedAt: completedAt,
      })
      .run();
  }
  return task;
}

describe("agentQualityService", () => {
  it("returns transparent inputs for a habitat-scoped agent", () => {
    const { agent } = agentRepo.createAgent({
      name: "Quality Agent",
      type: "codex",
      domain: "backend",
    });
    createCompletedTask(agent.id, 1, { estimate: 60, actual: 60, evidence: "active" });

    const inputs = getAgentQualityInputs(habitatId, agent.id);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      agentId: agent.id,
      completedTasks: 1,
      approvedEvents: 1,
      rejectedEvents: 0,
      totalRejections: 0,
      cycleTimeSamples: [60],
      estimateAccuracySamples: [1],
      evidenceCompletenessSamples: [1],
    });
  });

  it("gates score when completed sample size is insufficient", () => {
    const { agent } = agentRepo.createAgent({
      name: "New Agent",
      type: "opencode",
      domain: "frontend",
    });
    createCompletedTask(agent.id, 1, { estimate: 60, actual: 50, evidence: "partial" });

    const signal = getAgentQualitySignals(habitatId, agent.id).signals[0];

    expect(signal.confidence).toBe("insufficient_data");
    expect(signal.score).toBeNull();
    expect(signal.dimensions.evidenceCompleteness).toBe(0.5);
    expect(signal.warnings).toContain("Low confidence: not enough completed work yet.");
  });

  it("computes low-confidence informational score with effort and evidence dimensions", () => {
    const { agent } = agentRepo.createAgent({
      name: "Signal Agent",
      type: "claude-code",
      domain: "backend",
    });
    for (let i = 1; i <= 4; i++) {
      createCompletedTask(agent.id, i, {
        estimate: 60,
        actual: 60,
        evidence: i <= 3 ? "active" : "gap",
      });
    }

    const signal = getAgentQualitySignals(habitatId, agent.id).signals[0];

    expect(signal.confidence).toBe("low");
    expect(signal.score).not.toBeNull();
    expect(signal.dimensions.approval).toBe(1);
    expect(signal.dimensions.estimateAccuracy).toBe(1);
    expect(signal.dimensions.evidenceCompleteness).toBe(0.75);
    expect(signal.warnings).toContain(
      "Code evidence completeness is below the target range for this sample.",
    );
  });

  it("warns on high rejection rate without punitive labels", () => {
    const { agent } = agentRepo.createAgent({
      name: "Review Agent",
      type: "codex",
      domain: "backend",
    });
    for (let i = 1; i <= 4; i++) {
      createCompletedTask(agent.id, i, {
        estimate: 60,
        actual: 90,
        evidence: "active",
        rejectedCount: i <= 3 ? 1 : 0,
      });
    }

    const signal = getAgentQualitySignals(habitatId, agent.id).signals[0];

    expect(signal.confidence).toBe("low");
    expect(signal.warnings).toContain("High rejection rate in recent sample.");
    expect(signal.warnings.join(" ").toLowerCase()).not.toContain("bad agent");
    expect(signal.warnings.join(" ").toLowerCase()).not.toContain("low performer");
  });
});
