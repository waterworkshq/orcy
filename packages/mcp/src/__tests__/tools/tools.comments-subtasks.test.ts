import { describe, it, expect } from "vitest";
import { TASK_DISPATCH_HANDLER } from "../../tools/index.js";
import { createMockClient } from "../__fixtures__/mock-client.js";

describe("task dispatch delete-subtask", () => {
  it("deletes a subtask", async () => {
    const client = createMockClient();
    client.deleteSubtask.mockResolvedValue(undefined);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "delete-subtask",
      taskId: "task-1",
      subtaskId: "sub-1",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual({ success: true });
    expect(client.deleteSubtask).toHaveBeenCalledWith("task-1", "sub-1");
  });

  it("propagates API errors", async () => {
    const client = createMockClient();
    client.deleteSubtask.mockRejectedValue(new Error("Subtask not found"));

    const result = await TASK_DISPATCH_HANDLER(client, {
      action: "delete-subtask",
      taskId: "task-1",
      subtaskId: "sub-999",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Subtask not found");
  });
});

describe("task dispatch get-comments", () => {
  it("returns comments from the API client", async () => {
    const client = createMockClient();
    const mockComments = [
      {
        id: "comment-1",
        taskId: "task-1",
        parentId: null,
        authorType: "human" as const,
        authorId: "user-1",
        content: "Please fix the error handling",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ];
    client.getTaskComments.mockResolvedValue({ comments: mockComments, total: 1 });

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "get-comments", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.comments).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.comments[0].authorName).toBe("Human");
    expect(client.getTaskComments).toHaveBeenCalledWith("task-1", { limit: 50, offset: 0 });
  });

  it("enriches agent comments with agent name", async () => {
    const client = createMockClient();
    const mockComments = [
      {
        id: "comment-1",
        taskId: "task-1",
        parentId: null,
        authorType: "agent" as const,
        authorId: "agent-1",
        content: "Working on it",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ];
    client.getTaskComments.mockResolvedValue({ comments: mockComments, total: 1 });
    client.getAgentById.mockResolvedValue({ agent: { id: "agent-1", name: "coding-agent" } });

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "get-comments", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.comments[0].authorName).toBe("coding-agent");
  });

  it("passes pagination options", async () => {
    const client = createMockClient();
    client.getTaskComments.mockResolvedValue({ comments: [], total: 10 });

    await TASK_DISPATCH_HANDLER(client, {
      action: "get-comments",
      taskId: "task-1",
      limit: 5,
      offset: 5,
    });

    expect(client.getTaskComments).toHaveBeenCalledWith("task-1", { limit: 5, offset: 5 });
  });

  it("uses default pagination when not provided", async () => {
    const client = createMockClient();
    client.getTaskComments.mockResolvedValue({ comments: [], total: 0 });

    await TASK_DISPATCH_HANDLER(client, { action: "get-comments", taskId: "task-1" });

    expect(client.getTaskComments).toHaveBeenCalledWith("task-1", { limit: 50, offset: 0 });
  });

  it("falls back to agent ID when agent lookup fails", async () => {
    const client = createMockClient();
    const mockComments = [
      {
        id: "comment-1",
        taskId: "task-1",
        parentId: null,
        authorType: "agent" as const,
        authorId: "agent-999",
        content: "Hello",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ];
    client.getTaskComments.mockResolvedValue({ comments: mockComments, total: 1 });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "get-comments", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.comments[0].authorName).toBe("agent-999");
  });
});

describe("task dispatch add-comment", () => {
  it("adds a comment to a task", async () => {
    const client = createMockClient();
    const mockComment = {
      id: "comment-1",
      taskId: "task-1",
      parentId: null,
      authorType: "agent" as const,
      authorId: "agent-1",
      content: "Starting work on this",
      createdAt: "2026-04-10T10:00:00Z",
      updatedAt: "2026-04-10T10:00:00Z",
    };
    client.addComment.mockResolvedValue({ comment: mockComment });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "add-comment",
      taskId: "task-1",
      content: "Starting work on this",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.comment.id).toBe("comment-1");
    expect(result.comment.content).toBe("Starting work on this");
    expect(client.addComment).toHaveBeenCalledWith("task-1", "Starting work on this", undefined);
  });

  it("adds a reply comment with parentId", async () => {
    const client = createMockClient();
    const mockComment = {
      id: "comment-2",
      taskId: "task-1",
      parentId: "comment-1",
      authorType: "agent" as const,
      authorId: "agent-1",
      content: "I will fix that",
      createdAt: "2026-04-10T10:05:00Z",
      updatedAt: "2026-04-10T10:05:00Z",
    };
    client.addComment.mockResolvedValue({ comment: mockComment });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "add-comment",
      taskId: "task-1",
      content: "I will fix that",
      parentId: "comment-1",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.comment.parentId).toBe("comment-1");
    expect(client.addComment).toHaveBeenCalledWith("task-1", "I will fix that", "comment-1");
  });

  it("propagates API errors", async () => {
    const client = createMockClient();
    client.addComment.mockRejectedValue(new Error("Task not found"));

    const result = await TASK_DISPATCH_HANDLER(client, {
      action: "add-comment",
      taskId: "task-999",
      content: "Hello",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Task not found");
  });
});

describe("task dispatch list-subtasks", () => {
  it("returns subtasks with counts", async () => {
    const client = createMockClient();
    const mockSubtasks = [
      {
        id: "sub-1",
        taskId: "task-1",
        title: "Step 1",
        completed: true,
        order: 0,
        assigneeId: null,
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
      {
        id: "sub-2",
        taskId: "task-1",
        title: "Step 2",
        completed: false,
        order: 1,
        assigneeId: null,
        createdAt: "2026-04-10T10:01:00Z",
        updatedAt: "2026-04-10T10:01:00Z",
      },
    ];
    client.listSubtasks.mockResolvedValue({ subtasks: mockSubtasks, total: 2, completedCount: 1 });

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "list-subtasks", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.subtasks).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.completedCount).toBe(1);
    expect(result.subtasks[0].completed).toBe(true);
    expect(client.listSubtasks).toHaveBeenCalledWith("task-1");
  });

  it("propagates API errors", async () => {
    const client = createMockClient();
    client.listSubtasks.mockRejectedValue(new Error("Task not found"));

    const result = await TASK_DISPATCH_HANDLER(client, {
      action: "list-subtasks",
      taskId: "task-999",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Task not found");
  });
});

describe("task dispatch create-subtask", () => {
  it("creates a subtask with title", async () => {
    const client = createMockClient();
    const mockSubtask = {
      id: "sub-1",
      taskId: "task-1",
      title: "Write tests",
      completed: false,
      order: 0,
      assigneeId: null,
      createdAt: "2026-04-10T10:00:00Z",
      updatedAt: "2026-04-10T10:00:00Z",
    };
    client.createSubtask.mockResolvedValue({ subtask: mockSubtask });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "create-subtask",
      taskId: "task-1",
      title: "Write tests",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.subtask.id).toBe("sub-1");
    expect(result.subtask.title).toBe("Write tests");
    expect(client.createSubtask).toHaveBeenCalledWith("task-1", {
      title: "Write tests",
      order: undefined,
      assigneeId: undefined,
    });
  });

  it("creates a subtask with order and assignee", async () => {
    const client = createMockClient();
    const mockSubtask = {
      id: "sub-2",
      taskId: "task-1",
      title: "Deploy",
      completed: false,
      order: 2,
      assigneeId: "agent-1",
      createdAt: "2026-04-10T10:00:00Z",
      updatedAt: "2026-04-10T10:00:00Z",
    };
    client.createSubtask.mockResolvedValue({ subtask: mockSubtask });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "create-subtask",
      taskId: "task-1",
      title: "Deploy",
      order: 2,
      assigneeId: "agent-1",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.subtask.assigneeId).toBe("agent-1");
    expect(result.subtask.order).toBe(2);
    expect(client.createSubtask).toHaveBeenCalledWith("task-1", {
      title: "Deploy",
      order: 2,
      assigneeId: "agent-1",
    });
  });
});

describe("task dispatch update — status transitions", () => {
  it("calls startTask when status is in_progress", async () => {
    const client = createMockClient();
    const mockTask = { id: "task-1", status: "in_progress" as const, assignedAgentId: null };
    client.startTask.mockResolvedValue({ task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      status: "in_progress",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(client.startTask).toHaveBeenCalledWith("task-1", null);
    expect(result).toEqual({ success: true, task: { ...mockTask, assignedAgentName: null } });
  });

  it("calls failTask when status is failed", async () => {
    const client = createMockClient();
    const mockTask = { id: "task-1", status: "failed" as const, assignedAgentId: null };
    client.failTask.mockResolvedValue({ task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      status: "failed",
      failureReason: "Could not complete",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(client.failTask).toHaveBeenCalledWith("task-1", "Could not complete", null);
    expect(result).toEqual({ success: true, task: { ...mockTask, assignedAgentName: null } });
  });

  it("calls submitTask when status is submitted", async () => {
    const client = createMockClient();
    const mockResponse = {
      success: true,
      task: {
        id: "task-1",
        status: "submitted" as const,
        columnId: "col-review",
        submittedAt: "2026-04-20T00:00:00Z",
      },
      message: "Task submitted for review.",
    };
    client.submitTask.mockResolvedValue(mockResponse);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      status: "submitted",
      result: "Fixed the bug",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(client.submitTask).toHaveBeenCalledWith("task-1", "Fixed the bug", [], null);
    expect(result).toEqual({ success: true });
  });

  it("calls submitTask with empty result when not provided", async () => {
    const client = createMockClient();
    client.submitTask.mockResolvedValue({
      success: true,
      task: {
        id: "task-1",
        status: "submitted" as const,
        columnId: "col-review",
        submittedAt: "2026-04-20T00:00:00Z",
      },
      message: "Task submitted for review.",
    });

    await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      status: "submitted",
    });

    expect(client.submitTask).toHaveBeenCalledWith("task-1", "", [], null);
  });

  it("calls approveTask (canonical review decision) when status is approved", async () => {
    const client = createMockClient();
    const mockTask = { id: "task-1", status: "approved" as const, assignedAgentId: null };
    client.approveTask.mockResolvedValue({ task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      status: "approved",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(client.approveTask).toHaveBeenCalledWith("task-1");
    expect(client.updateTaskStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, task: { ...mockTask, assignedAgentName: null } });
  });

  it("calls completeTask when status is done", async () => {
    const client = createMockClient();
    const mockResponse = {
      success: true,
      task: {
        id: "task-1",
        status: "done" as const,
        columnId: "col-done",
        completedAt: "2026-04-20T00:00:00Z",
        result: null,
        artifacts: [],
      },
      message: "Task completed.",
    };
    client.completeTask.mockResolvedValue(mockResponse);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      status: "done",
      reviewNote: "Looks good",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(client.completeTask).toHaveBeenCalledWith("task-1", "Looks good", []);
    expect(result).toEqual({ success: true });
  });

  it("calls completeTask without reviewNote when not provided", async () => {
    const client = createMockClient();
    client.completeTask.mockResolvedValue({
      success: true,
      task: {
        id: "task-1",
        status: "done" as const,
        columnId: "col-done",
        completedAt: "2026-04-20T00:00:00Z",
        result: null,
        artifacts: [],
      },
      message: "Task completed.",
    });

    await TASK_DISPATCH_HANDLER(client, { action: "update", taskId: "task-1", status: "done" });

    expect(client.completeTask).toHaveBeenCalledWith("task-1", undefined, []);
  });
});

describe("task dispatch update — subtask operations", () => {
  it("toggles subtask completion", async () => {
    const client = createMockClient();
    const mockSubtask = {
      id: "sub-1",
      taskId: "task-1",
      title: "Write tests",
      completed: true,
      order: 0,
      assigneeId: null,
      createdAt: "2026-04-10T10:00:00Z",
      updatedAt: "2026-04-10T10:05:00Z",
    };
    client.updateSubtask.mockResolvedValue({ subtask: mockSubtask });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      subtaskId: "sub-1",
      subtaskCompleted: true,
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.success).toBe(true);
    expect(client.updateSubtask).toHaveBeenCalledWith("task-1", "sub-1", {
      completed: true,
      title: undefined,
      order: undefined,
      assigneeId: undefined,
    });
  });

  it("renames a subtask", async () => {
    const client = createMockClient();
    const mockSubtask = {
      id: "sub-1",
      taskId: "task-1",
      title: "Updated title",
      completed: false,
      order: 0,
      assigneeId: null,
      createdAt: "2026-04-10T10:00:00Z",
      updatedAt: "2026-04-10T10:05:00Z",
    };
    client.updateSubtask.mockResolvedValue({ subtask: mockSubtask });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      subtaskId: "sub-1",
      subtaskTitle: "Updated title",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.success).toBe(true);
    expect(client.updateSubtask).toHaveBeenCalledWith("task-1", "sub-1", {
      title: "Updated title",
      completed: undefined,
      order: undefined,
      assigneeId: undefined,
    });
  });

  it("reassigns a subtask", async () => {
    const client = createMockClient();
    const mockSubtask = {
      id: "sub-1",
      taskId: "task-1",
      title: "Write tests",
      completed: false,
      order: 0,
      assigneeId: "agent-2",
      createdAt: "2026-04-10T10:00:00Z",
      updatedAt: "2026-04-10T10:05:00Z",
    };
    client.updateSubtask.mockResolvedValue({ subtask: mockSubtask });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      subtaskId: "sub-1",
      subtaskAssigneeId: "agent-2",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.success).toBe(true);
    expect(client.updateSubtask).toHaveBeenCalledWith("task-1", "sub-1", {
      assigneeId: "agent-2",
      completed: undefined,
      title: undefined,
      order: undefined,
    });
  });

  it("deletes a subtask", async () => {
    const client = createMockClient();
    client.deleteSubtask.mockResolvedValue(undefined);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      subtaskId: "sub-1",
      deleteSubtask: true,
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.success).toBe(true);
    expect(client.deleteSubtask).toHaveBeenCalledWith("task-1", "sub-1");
  });
});

describe("task dispatch review decisions (approve/reject)", () => {
  const mockTask = { id: "task-1", status: "approved" as const, assignedAgentId: null };

  it("approve calls client.approveTask (canonical POST) and returns the enriched task", async () => {
    const client = createMockClient();
    client.approveTask.mockResolvedValue({ task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "approve", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(client.approveTask).toHaveBeenCalledWith("task-1");
    expect(result).toEqual({ success: true, task: { ...mockTask, assignedAgentName: null } });
  });

  it("reject calls client.rejectTask with the reason and returns the enriched task", async () => {
    const client = createMockClient();
    const rejected = { ...mockTask, status: "rejected" as const };
    client.rejectTask.mockResolvedValue({ task: rejected });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "reject",
      taskId: "task-1",
      reason: "Tests are missing",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(client.rejectTask).toHaveBeenCalledWith("task-1", "Tests are missing");
    expect(result).toEqual({ success: true, task: { ...rejected, assignedAgentName: null } });
  });

  it("reject without a reason is rejected by required-parameter validation", async () => {
    const client = createMockClient();

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "reject", taskId: "task-1" });

    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toContain("missing required parameters: reason");
    expect(client.rejectTask).not.toHaveBeenCalled();
  });

  it("review actions never send an executionToken", async () => {
    const client = createMockClient();
    client.approveTask.mockResolvedValue({ task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    await TASK_DISPATCH_HANDLER(client, {
      action: "approve",
      taskId: "task-1",
      executionToken: "should-be-ignored",
    });

    // Token-free by contract: the handler passes only taskId — admission is
    // reviewer-row-bound, not claim-epoch-bound.
    expect(client.approveTask).toHaveBeenCalledWith("task-1");
  });
});
