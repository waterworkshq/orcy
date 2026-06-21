import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import { tasks, agents, missions, columns, habitats, pulses } from "../db/schema/index.js";
import type { TaskStatus } from "../models/index.js";
import type { ExperienceCategory } from "@orcy/shared";
import {
  getExperienceMetrics,
  median,
  classifyOutlier,
  HIGH_REPORTER_THRESHOLD,
  LOW_REPORTER_THRESHOLD,
} from "../services/experienceMetricsService.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Metrics Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

function setupMission(habitatId: string, colId: string) {
  return missionRepo.createMission({
    habitatId,
    columnId: colId,
    title: "Metrics Mission",
    createdBy: "human-1",
  });
}

function setupAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "general",
  }).agent;
}

function assignAndSubmitTask(
  missionId: string,
  agentId: string,
  status: TaskStatus = "done",
  submittedAt?: string,
) {
  const task = taskCrudRepo.createTask({
    missionId,
    title: "Task",
    createdBy: "human-1",
  });
  const db = getDb();
  db.update(tasks)
    .set({
      assignedAgentId: agentId,
      status,
      submittedAt: submittedAt ?? new Date().toISOString(),
    })
    .where(eq(tasks.id, task.id))
    .run();
  return task;
}

function postExperience(
  habitatId: string,
  agentId: string,
  category: ExperienceCategory,
  timing: "mid_task" | "completion",
  taskId?: string,
  createdAt?: string,
) {
  const pulse = pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    fromType: "agent",
    fromId: agentId,
    signalType: "experience",
    subject: `${category} on task`,
    body: "",
    taskId,
    metadata: { experience: category, timing, implicit: true },
  });
  if (createdAt) {
    getDb().update(pulses).set({ createdAt }).where(eq(pulses.id, pulse.id)).run();
  }
  return pulse;
}

describe("experienceMetricsService", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(agents).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  afterEach(() => {
    closeDb();
  });

  describe("median", () => {
    it("returns 0 for an empty list", () => {
      expect(median([])).toBe(0);
    });
    it("returns the single value for a one-element list", () => {
      expect(median([5])).toBe(5);
    });
    it("returns the middle value for odd-length lists", () => {
      expect(median([1, 3, 5])).toBe(3);
    });
    it("returns the average of the two middle values for even-length lists", () => {
      expect(median([1, 2, 3, 4])).toBe(2.5);
    });
  });

  describe("classifyOutlier", () => {
    it("returns null when median is 0 (no data to compare)", () => {
      expect(classifyOutlier(10, 0)).toBeNull();
    });
    it("flags high_reporter above 2x median", () => {
      expect(classifyOutlier(10, 4)).toBe("high_reporter");
    });
    it("flags low_reporter below 0.5x median", () => {
      expect(classifyOutlier(1, 4)).toBe("low_reporter");
    });
    it("returns null within the normal band", () => {
      expect(classifyOutlier(4, 4)).toBeNull();
      expect(classifyOutlier(8, 4)).toBeNull();
      expect(classifyOutlier(2, 4)).toBeNull();
    });
    it("respects threshold constants", () => {
      expect(HIGH_REPORTER_THRESHOLD).toBe(2);
      expect(LOW_REPORTER_THRESHOLD).toBe(0.5);
    });
  });

  describe("getExperienceMetrics", () => {
    it("returns an empty agent list for a habitat with no experience signals", () => {
      const { habitat } = setupHabitat();
      const result = getExperienceMetrics(habitat.id, 30);
      expect(result.agents).toHaveLength(0);
      expect(result.medianSignalsTaskRatio).toBe(0);
      expect(result.generatedAt).toBeTruthy();
    });

    it("computes signals/task ratio and category distribution per agent", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const agentA = setupAgent("agent-a");

      assignAndSubmitTask(mission.id, agentA.id);
      assignAndSubmitTask(mission.id, agentA.id);

      postExperience(habitat.id, agentA.id, "stuck", "mid_task");
      postExperience(habitat.id, agentA.id, "confused", "mid_task");
      postExperience(habitat.id, agentA.id, "smooth", "completion");
      postExperience(habitat.id, agentA.id, "stuck", "mid_task");

      const result = getExperienceMetrics(habitat.id, 30);
      expect(result.agents).toHaveLength(1);

      const a = result.agents[0]!;
      expect(a.agentId).toBe(agentA.id);
      expect(a.agentName).toBe("agent-a");
      expect(a.agentType).toBe("claude-code");
      expect(a.signalCount).toBe(4);
      expect(a.tasksWorked).toBe(2);
      expect(a.signalsTaskRatio).toBe(2);
      expect(a.categoryDistribution.stuck).toBe(2);
      expect(a.categoryDistribution.confused).toBe(1);
      expect(a.categoryDistribution.smooth).toBe(1);
      expect(a.midTaskCount).toBe(3);
      expect(a.completionCount).toBe(1);
      expect(a.midTaskCompletionRatio).toBe(3);
    });

    it("flags a high reporter and a low reporter relative to the habitat median", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);

      const agentHigh = setupAgent("high-reporter");
      const agentNormal = setupAgent("normal-reporter");
      const agentLow = setupAgent("low-reporter");

      // Each agent worked 2 tasks
      for (const agent of [agentHigh, agentNormal, agentLow]) {
        assignAndSubmitTask(mission.id, agent.id);
        assignAndSubmitTask(mission.id, agent.id);
      }

      // High: 8 signals / 2 tasks = 4.0 ratio
      for (let i = 0; i < 8; i++) {
        postExperience(habitat.id, agentHigh.id, "stuck", "mid_task");
      }
      // Normal: 2 signals / 2 tasks = 1.0 ratio
      postExperience(habitat.id, agentNormal.id, "confused", "mid_task");
      postExperience(habitat.id, agentNormal.id, "smooth", "completion");
      // Low: 1 signal / 2 tasks = 0.5 ratio
      postExperience(habitat.id, agentLow.id, "surprised", "mid_task");

      const result = getExperienceMetrics(habitat.id, 30);
      expect(result.agents).toHaveLength(3);

      const byId = new Map(result.agents.map((a) => [a.agentId, a]));
      const high = byId.get(agentHigh.id)!;
      const normal = byId.get(agentNormal.id)!;
      const low = byId.get(agentLow.id)!;

      // Ratios: [4.0, 1.0, 0.5] → median = 1.0
      expect(result.medianSignalsTaskRatio).toBe(1);
      expect(high.outlierFlag).toBe("high_reporter");
      expect(normal.outlierFlag).toBeNull();
      expect(low.outlierFlag).toBeNull(); // 0.5 is NOT below 0.5 * 1.0 (it's equal, not less)
    });

    it("flags low_reporter and high_reporter with a three-agent habitat", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);

      const agentHigh = setupAgent("high-ratio");
      const agentNormal = setupAgent("normal-ratio");
      const agentLow = setupAgent("low-ratio");

      // Each agent worked 2 tasks
      for (const agent of [agentHigh, agentNormal, agentLow]) {
        assignAndSubmitTask(mission.id, agent.id);
        assignAndSubmitTask(mission.id, agent.id);
      }

      // High: 20 signals / 2 tasks = 10.0
      for (let i = 0; i < 20; i++) {
        postExperience(habitat.id, agentHigh.id, "stuck", "mid_task");
      }
      // Normal: 4 signals / 2 tasks = 2.0
      for (let i = 0; i < 4; i++) {
        postExperience(habitat.id, agentNormal.id, "smooth", "completion");
      }
      // Low: 1 signal / 2 tasks = 0.5
      postExperience(habitat.id, agentLow.id, "surprised", "mid_task");

      // Ratios [10, 2, 0.5] → median = 2.0
      // high: 10 > 2*2 = 4 → high_reporter
      // low: 0.5 < 2*0.5 = 1.0 → low_reporter
      const result = getExperienceMetrics(habitat.id, 30);
      expect(result.medianSignalsTaskRatio).toBe(2);
      const byId = new Map(result.agents.map((a) => [a.agentId, a]));
      expect(byId.get(agentHigh.id)!.outlierFlag).toBe("high_reporter");
      expect(byId.get(agentNormal.id)!.outlierFlag).toBeNull();
      expect(byId.get(agentLow.id)!.outlierFlag).toBe("low_reporter");
    });

    it("sorts agents by signals/task ratio descending", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);

      const agentLow = setupAgent("low-ratio");
      const agentHigh = setupAgent("high-ratio");

      assignAndSubmitTask(mission.id, agentLow.id);
      assignAndSubmitTask(mission.id, agentHigh.id);

      postExperience(habitat.id, agentLow.id, "smooth", "mid_task");
      for (let i = 0; i < 3; i++) {
        postExperience(habitat.id, agentHigh.id, "stuck", "mid_task");
      }

      const result = getExperienceMetrics(habitat.id, 30);
      expect(result.agents[0]!.agentId).toBe(agentHigh.id);
      expect(result.agents[1]!.agentId).toBe(agentLow.id);
    });

    it("respects the time range filter (excludes signals outside the window)", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const agent = setupAgent("time-agent");
      assignAndSubmitTask(mission.id, agent.id);

      const now = new Date();
      const recentISO = new Date(now.getTime() - 3 * 86_400_000).toISOString();
      const oldISO = new Date(now.getTime() - 60 * 86_400_000).toISOString();

      postExperience(habitat.id, agent.id, "stuck", "mid_task", undefined, recentISO);
      postExperience(habitat.id, agent.id, "confused", "mid_task", undefined, oldISO);

      const result30 = getExperienceMetrics(habitat.id, 30);
      const byId30 = new Map(result30.agents.map((a) => [a.agentId, a]));
      expect(byId30.get(agent.id)!.signalCount).toBe(1);
      expect(byId30.get(agent.id)!.categoryDistribution.stuck).toBe(1);

      const resultAll = getExperienceMetrics(habitat.id, 0);
      const byIdAll = new Map(resultAll.agents.map((a) => [a.agentId, a]));
      expect(byIdAll.get(agent.id)!.signalCount).toBe(2);
    });

    it("handles agent with signals but no worked tasks (ratio 0, not flagged high)", () => {
      const { habitat } = setupHabitat();
      const agent = setupAgent("signals-no-tasks");

      postExperience(habitat.id, agent.id, "stuck", "mid_task");
      postExperience(habitat.id, agent.id, "confused", "mid_task");

      const result = getExperienceMetrics(habitat.id, 30);
      expect(result.agents).toHaveLength(1);
      const a = result.agents[0]!;
      expect(a.signalCount).toBe(2);
      expect(a.tasksWorked).toBe(0);
      expect(a.signalsTaskRatio).toBe(0);
      // No other agents → median 0 → no outlier flag
      expect(a.outlierFlag).toBeNull();
    });

    it("counts all seven experience categories in the distribution", () => {
      const { habitat } = setupHabitat();
      const agent = setupAgent("all-cats");

      const cats: ExperienceCategory[] = [
        "stuck",
        "confused",
        "backtrack",
        "surprised",
        "ambiguous",
        "sidetracked",
        "smooth",
      ];
      for (const cat of cats) {
        postExperience(habitat.id, agent.id, cat, "mid_task");
      }

      const result = getExperienceMetrics(habitat.id, 30);
      const a = result.agents[0]!;
      expect(a.signalCount).toBe(7);
      for (const cat of cats) {
        expect(a.categoryDistribution[cat]).toBe(1);
      }
    });
  });
});
