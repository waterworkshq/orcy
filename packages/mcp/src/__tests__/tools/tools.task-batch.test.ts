import { describe, it, expect, vi } from "vitest";
import { TASK_DISPATCH_TOOL, TASK_DISPATCH_HANDLER } from "../../tools/index.js";

describe("TASK_DISPATCH_TOOL batch schema", () => {
  it("includes batch-assign action", () => {
    const action = TASK_DISPATCH_TOOL.inputSchema.properties!.action as {
      type: string;
      enum: string[];
    };
    expect(action.enum).toContain("batch-assign");
  });

  it("includes batch-set-priority action", () => {
    const action = TASK_DISPATCH_TOOL.inputSchema.properties!.action as {
      type: string;
      enum: string[];
    };
    expect(action.enum).toContain("batch-set-priority");
  });

  it("includes batch-delete action", () => {
    const action = TASK_DISPATCH_TOOL.inputSchema.properties!.action as {
      type: string;
      enum: string[];
    };
    expect(action.enum).toContain("batch-delete");
  });

  it("has boardId, taskIds, assigneeId in shared params", () => {
    const props = TASK_DISPATCH_TOOL.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("boardId");
    expect(props).toHaveProperty("taskIds");
    expect(props).toHaveProperty("assigneeId");
  });

  it("accepts taskIds as string array with constraints", () => {
    const props = TASK_DISPATCH_TOOL.inputSchema.properties as Record<string, unknown>;
    const taskIds = props.taskIds as {
      type: string;
      items: { type: string };
      minItems: number;
      maxItems: number;
    };
    expect(taskIds.type).toBe("array");
    expect(taskIds.items.type).toBe("string");
    expect(taskIds.minItems).toBe(1);
    expect(taskIds.maxItems).toBe(100);
  });

  it("accepts priority as string enum with valid levels", () => {
    const props = TASK_DISPATCH_TOOL.inputSchema.properties as Record<string, unknown>;
    const priority = props.priority as { type: string; enum: string[] };
    expect(priority.type).toBe("string");
    expect(priority.enum).toEqual(["low", "medium", "high", "critical"]);
  });
});

describe("task dispatch batch-assign", () => {
  function createMockClient() {
    return {
      batchAssignTasks: vi.fn(),
    } as any;
  }

  it("calls client.batchAssignTasks with correct arguments", async () => {
    const client = createMockClient();
    const mockResult = {
      successCount: 2,
      failureCount: 0,
      results: [
        { taskId: "task-1", success: true },
        { taskId: "task-2", success: true },
      ],
    };
    client.batchAssignTasks.mockResolvedValue(mockResult);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-assign",
      boardId: "board-1",
      taskIds: ["task-1", "task-2"],
      assigneeId: "agent-42",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(client.batchAssignTasks).toHaveBeenCalledWith(
      "board-1",
      ["task-1", "task-2"],
      "agent-42",
    );
  });

  it("returns per-task failures when some assignments fail", async () => {
    const client = createMockClient();
    const mockResult = {
      successCount: 1,
      failureCount: 1,
      results: [
        { taskId: "task-1", success: true },
        { taskId: "task-2", success: false, error: "Agent domain does not match task requirement" },
      ],
    };
    client.batchAssignTasks.mockResolvedValue(mockResult);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-assign",
      boardId: "board-1",
      taskIds: ["task-1", "task-2"],
      assigneeId: "agent-99",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[1].error).toBe("Agent domain does not match task requirement");
  });

  it("handles empty taskIds array gracefully", async () => {
    const client = createMockClient();
    client.batchAssignTasks.mockResolvedValue({
      successCount: 0,
      failureCount: 0,
      results: [],
    });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-assign",
      boardId: "board-1",
      taskIds: [],
      assigneeId: "agent-42",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});

describe("task dispatch batch-set-priority", () => {
  function createMockClient() {
    return {
      batchSetTaskPriority: vi.fn(),
    } as any;
  }

  it("calls client.batchSetTaskPriority with correct arguments", async () => {
    const client = createMockClient();
    const mockResult = {
      successCount: 2,
      failureCount: 0,
      results: [
        { taskId: "task-1", success: true },
        { taskId: "task-2", success: true },
      ],
    };
    client.batchSetTaskPriority.mockResolvedValue(mockResult);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-set-priority",
      boardId: "board-1",
      taskIds: ["task-1", "task-2"],
      priority: "high",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(client.batchSetTaskPriority).toHaveBeenCalledWith(
      "board-1",
      ["task-1", "task-2"],
      "high",
    );
  });

  it("returns per-task failures when some priority updates fail", async () => {
    const client = createMockClient();
    const mockResult = {
      successCount: 1,
      failureCount: 1,
      results: [
        { taskId: "task-1", success: true },
        { taskId: "task-2", success: false, error: "Priority update failed" },
      ],
    };
    client.batchSetTaskPriority.mockResolvedValue(mockResult);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-set-priority",
      boardId: "board-1",
      taskIds: ["task-1", "task-2"],
      priority: "low",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[1].error).toBe("Priority update failed");
  });

  it("handles empty taskIds array gracefully", async () => {
    const client = createMockClient();
    client.batchSetTaskPriority.mockResolvedValue({
      successCount: 0,
      failureCount: 0,
      results: [],
    });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-set-priority",
      boardId: "board-1",
      taskIds: [],
      priority: "critical",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});

describe("task dispatch batch-delete", () => {
  function createMockClient() {
    return {
      batchDeleteTasks: vi.fn(),
    } as any;
  }

  it("calls client.batchDeleteTasks with correct arguments", async () => {
    const client = createMockClient();
    const mockResult = {
      successCount: 2,
      failureCount: 0,
      results: [
        { taskId: "task-1", success: true },
        { taskId: "task-2", success: true },
      ],
    };
    client.batchDeleteTasks.mockResolvedValue(mockResult);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-delete",
      boardId: "board-1",
      taskIds: ["task-1", "task-2"],
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(client.batchDeleteTasks).toHaveBeenCalledWith("board-1", ["task-1", "task-2"]);
  });

  it("returns per-task failures with dependency errors", async () => {
    const client = createMockClient();
    const mockResult = {
      successCount: 1,
      failureCount: 1,
      results: [
        { taskId: "task-1", success: true },
        { taskId: "task-2", success: false, error: "Task has 3 dependent task(s)" },
      ],
    };
    client.batchDeleteTasks.mockResolvedValue(mockResult);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-delete",
      boardId: "board-1",
      taskIds: ["task-1", "task-2"],
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.results[1].error).toBe("Task has 3 dependent task(s)");
  });

  it("handles empty taskIds array gracefully", async () => {
    const client = createMockClient();
    client.batchDeleteTasks.mockResolvedValue({
      successCount: 0,
      failureCount: 0,
      results: [],
    });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "batch-delete",
      boardId: "board-1",
      taskIds: [],
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});
