import { describe, it, expect } from "vitest";
import {
  ALL_TOOLS,
  HABITAT_DISPATCH_HANDLER,
  MISSION_DISPATCH_HANDLER,
  TASK_DISPATCH_HANDLER,
  TASK_DISPATCH_TOOL,
  AGENT_DISPATCH_HANDLER,
  MISSION_DISPATCH_TOOL,
} from "../../tools/index.js";
import { createMockClient } from "../__fixtures__/mock-client.js";

describe("board_list_features", () => {
  it("returns features from the API client", async () => {
    const client = createMockClient();
    const mockFeatures = [
      {
        id: "feat-1",
        boardId: "board-1",
        columnId: "col-1",
        title: "Auth Feature",
        description: "Implement auth",
        acceptanceCriteria: "Users can log in",
        priority: "high" as const,
        labels: ["auth"],
        status: "in_progress" as const,
        displayOrder: 0,
        dependsOn: [],
        blocks: [],
        dueAt: null,
        slaMinutes: null,
        slaDeadlineAt: null,
        createdBy: "human-1",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        version: 1,
        progress: {
          total: 3,
          pending: 1,
          claimed: 0,
          inProgress: 1,
          submitted: 0,
          approved: 1,
          done: 0,
          failed: 0,
          rejected: 0,
        },
      },
    ];
    client.listMissions.mockResolvedValue({ missions: mockFeatures, total: 1 });

    const raw = await MISSION_DISPATCH_HANDLER(client, { action: "list", boardId: "board-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.missions).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.missions[0].title).toBe("Auth Feature");
    expect(client.listMissions).toHaveBeenCalledWith("board-1", {
      status: undefined,
      priority: undefined,
      limit: undefined,
    });
  });

  it("passes through status and priority filters", async () => {
    const client = createMockClient();
    client.listMissions.mockResolvedValue({ missions: [], total: 0 });

    await MISSION_DISPATCH_HANDLER(client, {
      action: "list",
      boardId: "board-1",
      status: "in_progress",
      priority: "high",
      limit: 10,
    });

    expect(client.listMissions).toHaveBeenCalledWith("board-1", {
      status: "in_progress",
      priority: "high",
      limit: 10,
    });
  });
});

describe("board_create_feature", () => {
  it("creates a feature and returns it", async () => {
    const client = createMockClient();
    const mockFeature = {
      id: "feat-new",
      boardId: "board-1",
      columnId: "col-1",
      title: "New Feature",
      description: "A new feature",
      acceptanceCriteria: "",
      priority: "medium" as const,
      labels: [],
      status: "not_started" as const,
      displayOrder: 0,
      dependsOn: [],
      blocks: [],
      dueAt: null,
      slaMinutes: null,
      slaDeadlineAt: null,
      createdBy: "agent-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      version: 1,
    };
    client.createMission.mockResolvedValue({ mission: mockFeature });

    const raw = await MISSION_DISPATCH_HANDLER(client, {
      action: "create",
      boardId: "board-1",
      title: "New Feature",
      description: "A new feature",
      priority: "medium",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.mission.id).toBe("feat-new");
    expect(result.mission.title).toBe("New Feature");
    expect(client.createMission).toHaveBeenCalledWith("board-1", {
      title: "New Feature",
      description: "A new feature",
      acceptanceCriteria: undefined,
      priority: "medium",
      labels: undefined,
      dependsOn: undefined,
    });
  });

  it("passes all optional parameters", async () => {
    const client = createMockClient();
    client.createMission.mockResolvedValue({ mission: { id: "feat-1" } });

    await MISSION_DISPATCH_HANDLER(client, {
      action: "create",
      boardId: "board-1",
      title: "Full Feature",
      description: "Desc",
      acceptanceCriteria: "AC",
      priority: "critical",
      labels: ["frontend", "urgent"],
      dependsOn: ["feat-other"],
    });

    expect(client.createMission).toHaveBeenCalledWith("board-1", {
      title: "Full Feature",
      description: "Desc",
      acceptanceCriteria: "AC",
      priority: "critical",
      labels: ["frontend", "urgent"],
      dependsOn: ["feat-other"],
      dueAt: undefined,
      slaMinutes: undefined,
      blocks: undefined,
    });
  });

  it("forwards dueAt, slaMinutes, and blocks to client.createMission", async () => {
    const client = createMockClient();
    client.createMission.mockResolvedValue({ mission: { id: "feat-1" } });

    await MISSION_DISPATCH_HANDLER(client, {
      action: "create",
      boardId: "board-1",
      title: "SLA Feature",
      dueAt: "2026-06-01T00:00:00Z",
      slaMinutes: 1440,
      blocks: ["feat-blocked-1", "feat-blocked-2"],
    });

    expect(client.createMission).toHaveBeenCalledWith("board-1", {
      title: "SLA Feature",
      description: undefined,
      acceptanceCriteria: undefined,
      priority: undefined,
      labels: undefined,
      dependsOn: undefined,
      dueAt: "2026-06-01T00:00:00Z",
      slaMinutes: 1440,
      blocks: ["feat-blocked-1", "feat-blocked-2"],
    });
  });
});

describe("board_create_feature schema", () => {
  it("includes dueAt, slaMinutes, and blocks in inputSchema", () => {
    const schema = MISSION_DISPATCH_TOOL.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("dueAt");
    expect(schema.properties).toHaveProperty("slaMinutes");
    expect(schema.properties).toHaveProperty("blocks");
  });

  it("correctly types the new fields", () => {
    const schema = MISSION_DISPATCH_TOOL.inputSchema as {
      properties: Record<string, { type: string }>;
    };
    expect(schema.properties.dueAt.type).toBe("string");
    expect(schema.properties.slaMinutes.type).toBe("number");
    expect(schema.properties.blocks.type).toBe("array");
  });
});

describe("board_delete_feature", () => {
  it("deletes a feature", async () => {
    const client = createMockClient();
    client.deleteMission.mockResolvedValue(undefined);

    const raw = await MISSION_DISPATCH_HANDLER(client, { action: "delete", missionId: "feat-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual({
      success: true,
      missionId: "feat-1",
      message: "Mission feat-1 deleted",
    });
    expect(client.deleteMission).toHaveBeenCalledWith("feat-1");
  });

  it("propagates API errors", async () => {
    const client = createMockClient();
    client.deleteMission.mockRejectedValue(new Error("Mission not found"));

    const result = await MISSION_DISPATCH_HANDLER(client, {
      action: "delete",
      missionId: "feat-999",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Mission not found");
  });
});

describe("feature_list_tasks", () => {
  it("returns tasks within a feature", async () => {
    const client = createMockClient();
    const mockTasks = [
      {
        id: "task-1",
        featureId: "feat-1",
        title: "Task 1",
        status: "pending" as const,
        priority: "high" as const,
      },
      {
        id: "task-2",
        featureId: "feat-1",
        title: "Task 2",
        status: "in_progress" as const,
        priority: "medium" as const,
      },
    ];
    client.listTasksInMission.mockResolvedValue({ tasks: mockTasks, total: 2 });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "list-in-mission",
      missionId: "feat-1",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.tasks).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(client.listTasksInMission).toHaveBeenCalledWith("feat-1");
  });
});

describe("feature_create_task", () => {
  it("creates a task within a feature", async () => {
    const client = createMockClient();
    const mockTask = {
      id: "task-new",
      featureId: "feat-1",
      title: "New Task",
      status: "pending" as const,
      priority: "medium" as const,
    };
    client.createTaskInMission.mockResolvedValue({ task: mockTask });

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "create-in-mission",
      missionId: "feat-1",
      title: "New Task",
      description: "A description",
      priority: "medium",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.task.id).toBe("task-new");
    expect(client.createTaskInMission).toHaveBeenCalledWith("feat-1", {
      title: "New Task",
      description: "A description",
      priority: "medium",
      requiredDomain: undefined,
      requiredCapabilities: undefined,
      estimatedMinutes: undefined,
    });
  });

  it("passes all optional parameters", async () => {
    const client = createMockClient();
    client.createTaskInMission.mockResolvedValue({ task: { id: "task-1" } });

    await TASK_DISPATCH_HANDLER(client, {
      action: "create-in-mission",
      missionId: "feat-1",
      title: "Full Task",
      description: "Desc",
      priority: "critical",
      requiredDomain: "backend",
      requiredCapabilities: ["typescript", "postgresql"],
      estimatedMinutes: 120,
    });

    expect(client.createTaskInMission).toHaveBeenCalledWith("feat-1", {
      title: "Full Task",
      description: "Desc",
      priority: "critical",
      requiredDomain: "backend",
      requiredCapabilities: ["typescript", "postgresql"],
      estimatedMinutes: 120,
    });
  });
});

describe("feature_get_context", () => {
  it("returns mission context with tasks", async () => {
    const client = createMockClient();
    const mockContext = {
      mission: {
        id: "feat-1",
        boardId: "board-1",
        columnId: "col-1",
        title: "Auth Feature",
        description: "Implement auth",
        acceptanceCriteria: "Users can log in",
        status: "in_progress",
        tasks: [
          {
            id: "task-1",
            title: "Task 1",
            status: "done",
            result: "Done",
            artifacts: [],
            assignedAgentId: null,
          },
          {
            id: "task-2",
            title: "Task 2",
            status: "in_progress",
            result: null,
            artifacts: [],
            assignedAgentId: "agent-1",
          },
        ],
        dependencies: [],
        blocking: [],
      },
    };
    client.getMissionContext.mockResolvedValue(mockContext);

    const raw = await MISSION_DISPATCH_HANDLER(client, {
      action: "get-context",
      missionId: "feat-1",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.mission.title).toBe("Auth Feature");
    expect(result.mission.tasks).toHaveLength(2);
    expect(client.getMissionContext).toHaveBeenCalledWith("feat-1");
  });
});

describe("board_claim_task", () => {
  it("returns success with task when claim succeeds", async () => {
    const client = createMockClient();
    const mockTask = {
      id: "task-1",
      title: "Test",
      status: "claimed" as const,
      assignedAgentId: null,
      featureId: "feat-1",
    };
    client.claimTask.mockResolvedValue({ success: true, task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "claim", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual({ success: true, task: { ...mockTask, assignedAgentName: null } });
  });

  it("returns failure when task is already claimed", async () => {
    const client = createMockClient();
    client.claimTask.mockResolvedValue({
      success: false,
      reason: "already_claimed",
      message: "Task already claimed",
    });

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "claim", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual({
      success: false,
      reason: "already_claimed",
      message: "Task already claimed",
    });
  });
});

describe("board_submit_task", () => {
  it("submits task with result and artifacts", async () => {
    const client = createMockClient();
    const mockResponse = {
      success: true,
      task: { id: "task-1", status: "submitted" as const, submittedAt: "2026-04-03T00:00:00Z" },
      message: "Task submitted for review.",
    };
    client.submitTask.mockResolvedValue(mockResponse);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "submit",
      taskId: "task-1",
      result: "Fixed the bug",
      artifacts: [{ type: "pr" as const, url: "https://github.com/pr/1", description: "Fix PR" }],
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual(mockResponse);
    expect(client.submitTask).toHaveBeenCalledWith("task-1", "Fixed the bug", [
      { type: "pr", url: "https://github.com/pr/1", description: "Fix PR" },
    ]);
  });
});

describe("board_get_task_context", () => {
  it("returns task context with feature and siblings", async () => {
    const client = createMockClient();
    const mockTask = {
      id: "task-1",
      title: "Test",
      status: "pending" as const,
      assignedAgentId: null,
      featureId: "feat-1",
    };
    const mockContext = {
      task: mockTask,
      feature: {
        id: "feat-1",
        title: "Auth Feature",
        description: "Implement auth",
        acceptanceCriteria: "Users can log in",
        status: "in_progress",
        priority: "high",
      },
      siblingTasks: [{ id: "task-2", title: "Sibling", status: "done", result: "Done" }],
      dependencies: [],
      blockedBy: [],
      blocking: [],
      boardContext: { name: "Sprint 24", columns: [{ name: "Todo", taskCount: 5 }] },
    };
    client.getTaskContext.mockResolvedValue(mockContext);
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "get-context", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.task).toEqual({ ...mockTask, assignedAgentName: null });
    expect(result.feature.title).toBe("Auth Feature");
    expect(result.siblingTasks).toHaveLength(1);
    expect(client.getTaskContext).toHaveBeenCalledWith("task-1");
  });
});

describe("board_release_task", () => {
  it("releases task with reason", async () => {
    const client = createMockClient();
    const mockResponse = {
      success: true,
      task: { id: "task-1", status: "pending" as const, assignedAgentId: null },
    };
    client.releaseTask.mockResolvedValue(mockResponse);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "release",
      taskId: "task-1",
      reason: "blocked_by_dependency",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual(mockResponse);
    expect(client.releaseTask).toHaveBeenCalledWith("task-1", "blocked_by_dependency");
  });
});

describe("board_retry_task", () => {
  it("retries a failed task", async () => {
    const client = createMockClient();
    const mockResponse = { task: { id: "task-1", status: "pending" as const } };
    client.retryTask.mockResolvedValue(mockResponse);

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "retry", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual(mockResponse);
    expect(client.retryTask).toHaveBeenCalledWith("task-1");
  });
});

describe("board_heartbeat", () => {
  it("sends heartbeat with taskId and progress", async () => {
    const client = createMockClient();
    const mockResponse = {
      success: true,
      agentStatus: "working" as const,
      nextCheckIn: 300,
      taskStatus: "in_progress" as const,
    };
    client.heartbeat.mockResolvedValue(mockResponse);

    const raw = await AGENT_DISPATCH_HANDLER(client, {
      action: "heartbeat",
      taskId: "task-1",
      progress: "Halfway done",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual(mockResponse);
    expect(client.heartbeat).toHaveBeenCalledWith("task-1", "Halfway done");
  });
});

describe("board_list_boards", () => {
  it("returns boards from the API client", async () => {
    const client = createMockClient();
    const mockBoards = [
      { id: "board-1", name: "Sprint 24", description: "Sprint board", columns: [] },
      { id: "board-2", name: "Backlog", description: "Feature backlog", columns: [] },
    ];
    client.listHabitats.mockResolvedValue({ habitats: mockBoards });

    const raw = await HABITAT_DISPATCH_HANDLER(client, { action: "list" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.habitats).toHaveLength(2);
    expect(result.habitats[0].id).toBe("board-1");
  });
});

describe("board_find", () => {
  it("returns matching boards for partial name search", async () => {
    const client = createMockClient();
    const mockBoards = [
      { id: "board-1", name: "Sprint 24", description: "Current sprint", columns: [] },
    ];
    client.listHabitats.mockResolvedValue({ habitats: mockBoards });

    const raw = await HABITAT_DISPATCH_HANDLER(client, { action: "find", name: "Sprint" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.habitats).toHaveLength(1);
    expect(client.listHabitats).toHaveBeenCalledWith("Sprint");
  });
});

describe("board_update_task", () => {
  it("updates task title", async () => {
    const client = createMockClient();
    const mockTask = {
      id: "task-1",
      title: "Updated title",
      status: "in_progress" as const,
      assignedAgentId: null,
      featureId: "feat-1",
    };
    client.updateTask.mockResolvedValue({ task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      title: "Updated title",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.task.title).toBe("Updated title");
    }
    expect(client.updateTask).toHaveBeenCalledWith("task-1", {
      title: "Updated title",
      description: undefined,
      priority: undefined,
      version: undefined,
      estimatedMinutes: undefined,
    });
  });

  it("supports optimistic locking with version", async () => {
    const client = createMockClient();
    const mockTask = {
      id: "task-1",
      title: "Test",
      status: "in_progress" as const,
      version: 6,
      assignedAgentId: null,
      featureId: "feat-1",
    };
    client.updateTask.mockResolvedValue({ task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      title: "New title",
      version: 5,
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.task.version).toBe(6);
    }
    expect(client.updateTask).toHaveBeenCalledWith("task-1", {
      title: "New title",
      description: undefined,
      priority: undefined,
      version: 5,
      estimatedMinutes: undefined,
    });
  });

  it("updates estimatedMinutes", async () => {
    const client = createMockClient();
    const mockTask = {
      id: "task-1",
      title: "Test",
      status: "in_progress" as const,
      assignedAgentId: null,
      featureId: "feat-1",
    };
    client.updateTask.mockResolvedValue({ task: mockTask });
    client.getAgentById.mockResolvedValue(null);

    await TASK_DISPATCH_HANDLER(client, {
      action: "update",
      taskId: "task-1",
      estimatedMinutes: 60,
    });

    expect(client.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        estimatedMinutes: 60,
      }),
    );
  });
});

describe("board_delete_task", () => {
  it("deletes a task", async () => {
    const client = createMockClient();
    client.deleteTask.mockResolvedValue(undefined);

    const raw = await TASK_DISPATCH_HANDLER(client, { action: "delete", taskId: "task-1" });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual({ success: true, taskId: "task-1", message: "Task task-1 deleted" });
    expect(client.deleteTask).toHaveBeenCalledWith("task-1");
  });
});

describe("audit bundle dispatch actions", () => {
  it("task dispatch exposes and calls get-audit-bundle", async () => {
    const client = createMockClient();
    client.getTaskAuditBundle.mockResolvedValue({ target: { id: "task-1" }, events: [] });

    const actionProp = TASK_DISPATCH_TOOL.inputSchema.properties!.action as { enum?: string[] };
    expect(actionProp.enum).toContain("get-audit-bundle");

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: "get-audit-bundle",
      taskId: "task-1",
      includeHealthSnapshots: true,
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toMatchObject({ target: { id: "task-1" }, events: [] });
    expect(client.getTaskAuditBundle).toHaveBeenCalledWith("task-1", {
      includeHealthSnapshots: true,
    });
  });

  it("mission dispatch calls get-audit-bundle", async () => {
    const client = createMockClient();
    client.getMissionAuditBundle.mockResolvedValue({ target: { id: "mission-1" }, warnings: [] });

    const raw = await MISSION_DISPATCH_HANDLER(client, {
      action: "get-audit-bundle",
      missionId: "mission-1",
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toMatchObject({ target: { id: "mission-1" }, warnings: [] });
    expect(client.getMissionAuditBundle).toHaveBeenCalledWith("mission-1", {
      includeHealthSnapshots: false,
    });
  });
});

describe("Consolidated tools in ALL_TOOLS", () => {
  it("board_create_task is not in ALL_TOOLS", () => {
    const toolNames = ALL_TOOLS.map((t) => t.name);
    expect(toolNames).not.toContain("board_create_task");
  });

  it("board_list_tasks is not in ALL_TOOLS", () => {
    const toolNames = ALL_TOOLS.map((t) => t.name);
    expect(toolNames).not.toContain("board_list_tasks");
  });

  it("consolidated mission and task tools are in ALL_TOOLS", () => {
    const toolNames = ALL_TOOLS.map((t) => t.name);
    expect(toolNames).toContain("orcy_habitat_mission");
    expect(toolNames).toContain("orcy_habitat_task");
    expect(toolNames).not.toContain("board_create_feature");
    expect(toolNames).not.toContain("board_list_features");
    expect(toolNames).not.toContain("feature_list_tasks");
    expect(toolNames).not.toContain("feature_create_task");
    expect(toolNames).not.toContain("board_delete_feature");
  });

  it("batch tools are consolidated under admin tool", () => {
    const toolNames = ALL_TOOLS.map((t) => t.name);
    expect(toolNames).toContain("orcy_admin");
    expect(toolNames).not.toContain("board_batch_assign_tasks");
    expect(toolNames).not.toContain("board_batch_set_task_priority");
  });
});
