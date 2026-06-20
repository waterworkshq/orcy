import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({
  getDb: () => ({
    transaction: (fn: (tx: any) => any) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              get: () => mockTask,
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              run: () => {},
            }),
          }),
        }),
      }),
  }),
}));

vi.mock("../db/schema/index.js", () => ({
  tasks: {
    id: "id",
    status: "status",
    assignedAgentId: "assigned_agent_id",
    remoteAssignedParticipantId: "remote_assigned_participant_id",
    version: "version",
    claimedAt: "claimed_at",
    updatedAt: "updated_at",
  },
}));

vi.mock("drizzle-orm", () => ({
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
  areAllDependenciesMet: vi.fn().mockReturnValue(true),
}));

vi.mock("../repositories/workflow.js", () => ({
  areAllWorkflowGatesSatisfied: vi.fn().mockReturnValue(true),
}));

import { claimTask, claimTaskByRemoteParticipant } from "../repositories/taskStateMachine.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import { areAllDependenciesMet } from "../repositories/taskQueries.js";

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
  });
});
