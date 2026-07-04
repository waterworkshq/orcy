import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/task.js", () => ({
  getAvailableTasksForAgent: vi.fn(),
  getTaskById: vi.fn(),
}));

vi.mock("../repositories/feature.js", () => ({
  getMissionById: vi.fn(),
}));

vi.mock("../repositories/agent.js", () => ({
  getAgentById: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock("../repositories/workflow.js", () => ({
  areAllWorkflowGatesSatisfied: vi.fn().mockReturnValue(true),
}));

const taskScoringMocks = vi.hoisted(() => ({
  scoreTask: vi.fn(() => 50),
  computeSlaUrgencyWeight: vi.fn(() => 0),
  computeCapabilityWeight: vi.fn(() => 10),
}));

vi.mock("./taskScoring.js", () => ({
  scoreTask: taskScoringMocks.scoreTask,
  computeSlaUrgencyWeight: taskScoringMocks.computeSlaUrgencyWeight,
  PRIORITY_WEIGHTS: { low: 10, medium: 20, high: 30, critical: 50 },
  computeCapabilityWeight: taskScoringMocks.computeCapabilityWeight,
}));

vi.mock("../db/index.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => ({ count: 0 }),
          all: () => [],
        }),
      }),
    }),
  }),
}));

vi.mock("../db/schema/index.js", () => ({
  tasks: { assignedAgentId: "a_id", status: "status" },
  taskDependencies: { dependsOnId: "depends_on_id", taskId: "task_id" },
}));

// resolveRoadmapSettings (called by getSuggestionsForAgent) reads habitat settings;
// stub the board repo so it returns no habitat → default `fanout` algorithm.
vi.mock("../repositories/board.js", () => ({ getHabitatById: () => null }));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_c, _v) => ({ _type: "eq" })),
    and: vi.fn((..._c) => ({ _type: "and" })),
    sql: vi.fn((_s, ..._v) => ({ _type: "sql" })),
    inArray: vi.fn(() => ({ _type: "inArray" })),
  };
});

import { getSuggestionsForAgent } from "../services/taskSuggestion.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as agentRepo from "../repositories/agent.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Test Task",
    missionId: "mission-1",
    priority: "medium",
    status: "pending",
    assignedAgentId: null,
    domain: "backend",
    requiredDomain: null,
    capabilities: [],
    createdAt: new Date().toISOString(),
    artifacts: [],
    order: 0,
    ...overrides,
  };
}

function makeAgent() {
  return { id: "agent-1", name: "Bot", domain: "backend", status: "working", capabilities: [] };
}

describe("taskSuggestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(taskRepo.getAvailableTasksForAgent).mockReturnValue([]);
    vi.mocked(missionRepo.getMissionById).mockReturnValue(null);
    vi.mocked(agentRepo.getAgentById).mockReturnValue(null);
    taskScoringMocks.scoreTask.mockReturnValue(50);
    taskScoringMocks.computeSlaUrgencyWeight.mockReturnValue(0);
    taskScoringMocks.computeCapabilityWeight.mockReturnValue(10);
  });

  describe("getSuggestionsForAgent", () => {
    it("returns empty when agent not found", () => {
      vi.mocked(agentRepo.getAgentById).mockReturnValue(null);

      const result = getSuggestionsForAgent("h1", "agent-1");

      expect(result.suggestions).toEqual([]);
      expect(result.agentWorkload.claimed).toBe(0);
    });

    it("returns empty when no available tasks", () => {
      vi.mocked(agentRepo.getAgentById).mockReturnValue(makeAgent() as any);
      vi.mocked(taskRepo.getAvailableTasksForAgent).mockReturnValue([]);

      const result = getSuggestionsForAgent("h1", "agent-1");

      expect(result.suggestions).toEqual([]);
      expect(result.agentWorkload.claimed).toBe(0);
    });

    it("returns scored suggestions", () => {
      vi.mocked(agentRepo.getAgentById).mockReturnValue(makeAgent() as any);
      vi.mocked(taskRepo.getAvailableTasksForAgent).mockReturnValue([makeTask() as any]);
      vi.mocked(missionRepo.getMissionById).mockReturnValue({ title: "Mission X" } as any);

      const result = getSuggestionsForAgent("h1", "agent-1");

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].taskId).toBe("task-1");
      expect(result.suggestions[0].missionTitle).toBe("Mission X");
      expect(result.suggestions[0].reasons.length).toBeGreaterThan(0);
    });

    it("sorts by score descending", () => {
      vi.mocked(agentRepo.getAgentById).mockReturnValue(makeAgent() as any);
      vi.mocked(taskRepo.getAvailableTasksForAgent).mockReturnValue([
        makeTask({ id: "t1", title: "Low", priority: "low" }) as any,
        makeTask({ id: "t2", title: "High", priority: "critical" }) as any,
      ]);
      vi.mocked(missionRepo.getMissionById).mockReturnValue({ title: "M" } as any);

      taskScoringMocks.scoreTask.mockReturnValueOnce(30).mockReturnValueOnce(80);

      const result = getSuggestionsForAgent("h1", "agent-1");

      expect(result.suggestions).toHaveLength(2);
      expect(result.suggestions[0].taskId).toBe("t2");
    });

    it("respects limit", () => {
      vi.mocked(agentRepo.getAgentById).mockReturnValue(makeAgent() as any);
      vi.mocked(taskRepo.getAvailableTasksForAgent).mockReturnValue([
        makeTask({ id: "t1" }) as any,
        makeTask({ id: "t2" }) as any,
        makeTask({ id: "t3" }) as any,
      ]);
      vi.mocked(missionRepo.getMissionById).mockReturnValue({ title: "M" } as any);

      const result = getSuggestionsForAgent("h1", "agent-1", 2);

      expect(result.suggestions).toHaveLength(2);
    });

    it("excludes tasks with unsatisfied workflow gates (W5)", () => {
      vi.mocked(agentRepo.getAgentById).mockReturnValue(makeAgent() as any);
      vi.mocked(taskRepo.getAvailableTasksForAgent).mockReturnValue([
        makeTask({ id: "t1" }) as any,
        makeTask({ id: "t2" }) as any,
      ]);
      vi.mocked(missionRepo.getMissionById).mockReturnValue({ title: "M" } as any);
      vi.mocked(areAllWorkflowGatesSatisfied).mockImplementation(
        (taskId: string) => taskId !== "t1",
      );

      const result = getSuggestionsForAgent("h1", "agent-1");

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].taskId).toBe("t2");
    });

    it("includes all tasks when all workflow gates are satisfied (W5)", () => {
      vi.mocked(agentRepo.getAgentById).mockReturnValue(makeAgent() as any);
      vi.mocked(taskRepo.getAvailableTasksForAgent).mockReturnValue([
        makeTask({ id: "t1" }) as any,
        makeTask({ id: "t2" }) as any,
      ]);
      vi.mocked(missionRepo.getMissionById).mockReturnValue({ title: "M" } as any);
      vi.mocked(areAllWorkflowGatesSatisfied).mockReturnValue(true);

      const result = getSuggestionsForAgent("h1", "agent-1");

      expect(result.suggestions).toHaveLength(2);
    });
  });
});
