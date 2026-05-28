import { describe, it, expect, vi, beforeEach } from "vitest";

let _habitatNameResult: { name: string } | undefined = undefined;
let _taskResult: Record<string, unknown> | null = null;
let _agentResult: { name: string } | null = null;

const mockGet = vi.fn(() => _habitatNameResult);
const mockSelect = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({
      get: mockGet,
    })),
  })),
}));

vi.mock("../db/index.js", () => ({
  getDb: () => ({
    select: mockSelect,
  }),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../db/schema/index.js", () => ({
  habitats: {
    id: "id",
    name: "name",
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_col: unknown, _val: unknown) => ({ _type: "eq" })),
  };
});

vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn(),
  getHabitatIdForTask: vi.fn(),
}));

vi.mock("../repositories/agent.js", () => ({
  getAgentById: vi.fn(),
}));

import { enrichEvent } from "../services/eventEnricher.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import type { SSEEvent } from "../models/index.js";

describe("eventEnricher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _habitatNameResult = { name: "Test Habitat" };
    _taskResult = null;
    _agentResult = null;
    vi.mocked(taskRepo.getTaskById).mockReturnValue(null);
    vi.mocked(agentRepo.getAgentById).mockReturnValue(null);
  });

  describe("enrichEvent", () => {
    it("enriches with habitatName", () => {
      _habitatNameResult = { name: "My Habitat" };

      const event: SSEEvent = {
        type: "agent.status_changed",
        data: { agentId: "agent-1", status: "idle" },
      };

      const result = enrichEvent("habitat-1", event);

      expect(result.habitatName).toBe("My Habitat");
      expect(result.task).toBeUndefined();
    });

    it("falls back to habitatId when habitat not found", () => {
      _habitatNameResult = undefined;

      const event: SSEEvent = {
        type: "agent.status_changed",
        data: { agentId: "agent-1", status: "idle" },
      };

      const result = enrichEvent("unknown-habitat", event);

      expect(result.habitatName).toBe("unknown-habitat");
    });

    it("enriches with task info when event has taskId", () => {
      mockGet.mockReturnValue({ name: "Task Habitat" });

      vi.mocked(taskRepo.getTaskById).mockReturnValue({
        id: "task-1",
        title: "Build Feature",
        status: "in_progress",
        priority: "high",
        assignedAgentId: "agent-1",
        result: null,
        artifacts: [{ type: "pr", url: "https://github.com/pr/1", description: "PR" }],
      } as any);

      vi.mocked(agentRepo.getAgentById).mockReturnValue({ name: "HelperBot" } as any);

      const event: SSEEvent = {
        type: "task.moved",
        data: { taskId: "task-1", fromColumn: "todo", toColumn: "in_progress" },
      };

      const result = enrichEvent("habitat-1", event);

      expect(result.habitatName).toBe("Task Habitat");
      expect(result.task).toBeDefined();
      expect(result.task!.id).toBe("task-1");
      expect(result.task!.title).toBe("Build Feature");
      expect(result.task!.status).toBe("in_progress");
      expect(result.task!.priority).toBe("high");
      expect(result.task!.assignedAgentId).toBe("agent-1");
      expect(result.task!.assignedAgentName).toBe("HelperBot");
      expect(result.task!.result).toBeNull();
      expect(result.task!.artifacts).toEqual([
        { type: "pr", url: "https://github.com/pr/1", description: "PR" },
      ]);
    });

    it("enriches task without agent name when no assignedAgentId", () => {
      mockGet.mockReturnValue({ name: "Task Habitat" });

      vi.mocked(taskRepo.getTaskById).mockReturnValue({
        id: "task-2",
        title: "Unassigned Task",
        status: "pending",
        priority: "medium",
        assignedAgentId: null,
        result: "Done!",
        artifacts: [],
      } as any);

      const event: SSEEvent = {
        type: "task.submitted",
        data: { taskId: "task-2", agentId: "agent-x" },
      };

      const result = enrichEvent("habitat-2", event);

      expect(result.task).toBeDefined();
      expect(result.task!.assignedAgentId).toBeNull();
      expect(result.task!.assignedAgentName).toBeUndefined();
      expect(result.task!.result).toBe("Done!");
    });

    it("enriches task without agent name when assignedAgentId but agent not found", () => {
      mockGet.mockReturnValue({ name: "Task Habitat" });

      vi.mocked(taskRepo.getTaskById).mockReturnValue({
        id: "task-3",
        title: "Task with Ghost Agent",
        status: "pending",
        priority: "low",
        assignedAgentId: "ghost-agent",
        result: null,
        artifacts: [],
      } as any);

      vi.mocked(agentRepo.getAgentById).mockReturnValue(null);

      const event: SSEEvent = {
        type: "task.completed",
        data: { taskId: "task-3" },
      };

      const result = enrichEvent("habitat-3", event);

      expect(result.task!.assignedAgentId).toBe("ghost-agent");
      expect(result.task!.assignedAgentName).toBeUndefined();
    });

    it("does not enrich task when task not found", () => {
      mockGet.mockReturnValue({ name: "Habitat" });

      vi.mocked(taskRepo.getTaskById).mockReturnValue(null);

      const event: SSEEvent = {
        type: "task.failed",
        data: { taskId: "missing-task", reason: "error" },
      };

      const result = enrichEvent("habitat-1", event);

      expect(result.habitatName).toBe("Habitat");
      expect(result.task).toBeUndefined();
    });

    it("enriches event with taskId but no task data", () => {
      mockGet.mockReturnValue({ name: "Habitat" });

      const event: SSEEvent = {
        type: "task.overdue",
        data: { taskId: "task-1", habitatId: "habitat-1", detectedAt: "2025-01-01" },
      };

      const result = enrichEvent("habitat-1", event);

      expect(result.habitatName).toBe("Habitat");
    });

    it("includes artifacts from task", () => {
      mockGet.mockReturnValue({ name: "H" });

      vi.mocked(taskRepo.getTaskById).mockReturnValue({
        id: "t1",
        title: "T",
        status: "done",
        priority: "medium",
        assignedAgentId: null,
        result: null,
        artifacts: [
          { type: "file", url: "/file.txt", description: "Output" },
          { type: "screenshot", url: "/img.png", description: "Screen" },
        ],
      } as any);

      const event: SSEEvent = {
        type: "task.updated",
        data: { taskId: "t1" } as any,
      };

      const result = enrichEvent("h1", event);

      expect(result.task!.artifacts).toHaveLength(2);
      expect(result.task!.artifacts[0].type).toBe("file");
    });
  });
});
