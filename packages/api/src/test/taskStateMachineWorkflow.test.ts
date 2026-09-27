import { describe, it, expect, vi, beforeEach } from "vitest";

const claimabilityMocks = vi.hoisted(() => ({
  dependencies: vi.fn().mockReturnValue(true),
  missionDependencies: vi.fn().mockReturnValue(true),
  releaseGate: vi.fn().mockReturnValue(true),
  workflowGates: vi.fn().mockReturnValue(true),
}));

vi.mock("../services/tasks/transitionBudget.js", () => ({
  // The budget guard is a module seam for this suite (its subject is gate
  // ordering, not metering): allow every transition.
  guardTransition: vi.fn(() => ({ outcome: "allow", count: 0, ceiling: 12 })),
  habitatIdForTaskWithClient: vi.fn(() => "habitat-1"),
}));

vi.mock("../db/index.js", async () => {
  const reviewSafety = await vi.importActual("../db/schema/reviewSafety.js");
  const isReviewSafetyTable = (t: unknown) =>
    t === (reviewSafety as any).taskReviewRequirements ||
    t === (reviewSafety as any).taskReviewSnapshots ||
    t === (reviewSafety as any).taskReviewDecisions ||
    t === (reviewSafety as any).taskReviewOverrides;
  const birthRow = {
    taskId: "task-1",
    origin: "ordinary",
    state: "uncaptured",
    nonOverriddenFloor: null,
    knownPolicyFloor: 0,
    effectiveCount: null,
    requirementVersion: 1,
    reviewGeneration: 0,
    reviewRound: 0,
    claimantType: null,
    claimantId: null,
    approvedGeneration: null,
    activeOverrideId: null,
    selectedRuleId: null,
  };
  return {
    getDb: () => ({
      transaction: (fn: (tx: any) => any) =>
        fn({
          // Review-safety capture (every successful claim) reads the
          // requirement table (→ the birth `uncaptured` row), the rules
          // table (→ no rows: explicit no-match capture) and writes the
          // snapshot + requirement rows through insert no-ops. Everything
          // else keeps the pre-cutover mock shape.
          select: () => ({
            from: (table: any) => {
              const rows = {
                get: () => (isReviewSafetyTable(table) ? { ...birthRow } : mockTask),
                all: () => [] as unknown[],
              };
              return {
                where: () => ({ ...rows, orderBy: () => rows }),
              };
            },
          }),
          insert: () => ({
            values: () => ({
              run: () => {},
              onConflictDoNothing: () => ({ run: () => {} }),
            }),
          }),
          update: () => ({
            set: (value: Record<string, unknown>) => ({
              where: () => ({
                run: () => {
                  Object.assign(mockTask, value);
                },
              }),
            }),
          }),
        }),
    }),
  };
});
vi.mock("../db/schema/index.js", async () => {
  // Review-safety cutover, minimal adaptation: the REAL schema module —
  // every export present and correctly bound (no stubs, no catch-all), so
  // the widened import graph (daemon tables, review-safety tables) resolves
  // exactly as in production. Behavior is shaped by the db mock below.
  return (await vi.importActual("../db/schema/index.js")) as Record<string, unknown>;
});
vi.mock("drizzle-orm", () => ({
  // Review-safety cutover: the real schema module's relations need the
  // `relations` helper at import time.
  relations: (name: string, fn: (helper: unknown) => unknown) => ({ name, fn }),
  eq: vi.fn((_c, _v) => ({})),
  and: vi.fn((..._c) => ({})),
  inArray: vi.fn((_c, _v) => ({})),
  sql: vi.fn((s: TemplateStringsArray) => s.join("")),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("../errors/sqlite.js", () => ({
  isSqliteError: vi.fn().mockReturnValue(false),
}));

vi.mock("../errors/repository.js", () => ({
  repositoryTransactionError: vi.fn(),
  repositoryCreateError: vi.fn(),
  repositoryNotFoundError: vi.fn(),
  repositoryUpdateError: vi.fn(),
  repositoryDeleteError: vi.fn(),
  repositoryUpsertError: vi.fn(),
}));

vi.mock("../repositories/taskCrud.js", () => ({
  getTaskById: vi.fn().mockReturnValue(null),
}));

vi.mock("../repositories/taskQueries.js", () => ({
  areAllDependenciesMet: claimabilityMocks.dependencies,
  areAllMissionDependenciesMet: claimabilityMocks.missionDependencies,
  isReleaseGateSatisfiedForTask: claimabilityMocks.releaseGate,
  checkClaimability: vi.fn((taskId: string) => {
    if (!claimabilityMocks.dependencies(taskId)) {
      return { claimable: false, reason: "dependencies_unmet" };
    }
    if (!claimabilityMocks.missionDependencies(taskId)) {
      return { claimable: false, reason: "mission_dependencies_unmet" };
    }
    if (!claimabilityMocks.releaseGate(taskId)) {
      return { claimable: false, reason: "release_gate_unmet" };
    }
    if (!claimabilityMocks.workflowGates(taskId)) {
      return { claimable: false, reason: "workflow_gates_unmet" };
    }
    return { claimable: true };
  }),
}));

vi.mock("../repositories/workflow.js", () => ({
  areAllWorkflowGatesSatisfied: claimabilityMocks.workflowGates,
}));

import { claimTask, claimTaskByRemoteParticipant } from "../repositories/taskStateMachine.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import {
  areAllDependenciesMet,
  areAllMissionDependenciesMet,
  isReleaseGateSatisfiedForTask,
} from "../repositories/taskQueries.js";

const mockTask = {
  id: "task-1",
  status: "pending",
  assignedAgentId: null,
  remoteAssignedParticipantId: null,
  version: 1,
};

describe("claimTask workflow gates guard (W4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (areAllDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (areAllMissionDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isReleaseGateSatisfiedForTask as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockTask.status = "pending";
    mockTask.assignedAgentId = null;
    mockTask.remoteAssignedParticipantId = null;
  });

  describe("claimTask", () => {
    it("returns workflow_gates_unmet when gates are unsatisfied", () => {
      (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTask("task-1", "agent-1");
      expect(result.success).toBe(false);
      expect(result).toEqual({ success: false, reason: "workflow_gates_unmet" });
    });

    it("proceeds with claim when gates are satisfied", () => {
      (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const result = claimTask("task-1", "agent-1");
      expect(result.success).toBe(true);
    });

    it("checks gates only after dependencies pass", () => {
      (areAllDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTask("task-1", "agent-1");
      expect(result.success).toBe(false);
      expect((result as { reason: string }).reason).toBe("dependencies_unmet");
      expect(areAllWorkflowGatesSatisfied).not.toHaveBeenCalled();
    });

    it("checks gates when no dependencies exist (deps pass, gates fail)", () => {
      (areAllDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTask("task-1", "agent-1");
      expect(result.success).toBe(false);
      expect((result as { reason: string }).reason).toBe("workflow_gates_unmet");
    });

    it("returns mission_dependencies_unmet when mission deps fail", () => {
      (areAllMissionDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTask("task-1", "agent-1");
      expect(result.success).toBe(false);
      expect(result).toEqual({ success: false, reason: "mission_dependencies_unmet" });
    });

    it("returns release_gate_unmet when release gate fails", () => {
      (isReleaseGateSatisfiedForTask as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTask("task-1", "agent-1");
      expect(result.success).toBe(false);
      expect(result).toEqual({ success: false, reason: "release_gate_unmet" });
    });

    it("ordering: mission-dep checked before release-gate (both unmet → mission first)", () => {
      (areAllMissionDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (isReleaseGateSatisfiedForTask as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTask("task-1", "agent-1");
      expect(result.success).toBe(false);
      expect((result as { reason: string }).reason).toBe("mission_dependencies_unmet");
      expect(isReleaseGateSatisfiedForTask).not.toHaveBeenCalled();
    });

    it("ordering: release-gate checked before workflow-gates", () => {
      (isReleaseGateSatisfiedForTask as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTask("task-1", "agent-1");
      expect(result.success).toBe(false);
      expect((result as { reason: string }).reason).toBe("release_gate_unmet");
      expect(areAllWorkflowGatesSatisfied).not.toHaveBeenCalled();
    });
  });

  describe("claimTaskByRemoteParticipant", () => {
    it("returns workflow_gates_unmet when gates are unsatisfied", () => {
      (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTaskByRemoteParticipant("task-1", "participant-1");
      expect(result.success).toBe(false);
      expect(result).toEqual({ success: false, reason: "workflow_gates_unmet" });
    });

    it("proceeds with claim when gates are satisfied", () => {
      (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const result = claimTaskByRemoteParticipant("task-1", "participant-1");
      expect(result.success).toBe(true);
    });

    it("checks gates only after dependencies pass", () => {
      (areAllDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (areAllWorkflowGatesSatisfied as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTaskByRemoteParticipant("task-1", "participant-1");
      expect(result.success).toBe(false);
      expect((result as { reason: string }).reason).toBe("dependencies_unmet");
      expect(areAllWorkflowGatesSatisfied).not.toHaveBeenCalled();
    });

    it("returns mission_dependencies_unmet when mission deps fail (remote parity)", () => {
      (areAllMissionDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTaskByRemoteParticipant("task-1", "participant-1");
      expect(result.success).toBe(false);
      expect(result).toEqual({ success: false, reason: "mission_dependencies_unmet" });
    });

    it("returns release_gate_unmet when release gate fails (remote parity)", () => {
      (isReleaseGateSatisfiedForTask as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = claimTaskByRemoteParticipant("task-1", "participant-1");
      expect(result.success).toBe(false);
      expect(result).toEqual({ success: false, reason: "release_gate_unmet" });
    });
  });
});
