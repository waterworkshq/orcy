import { describe, it, expect, beforeEach } from "vitest";
import {
  getFailureContext,
  getWorkflowContext,
  WORKFLOW_FAILURE_CONTEXT_TOOL,
  WORKFLOW_CONTEXT_TOOL,
  WORKFLOW_FAILURE_CONTEXT_HANDLER,
  WORKFLOW_CONTEXT_HANDLER,
} from "../../tools/workflow.js";
import { ALL_TOOLS } from "../../tools/index.js";
import { createMockClient } from "../__fixtures__/mock-client.js";

describe("orcy_get_failure_context — getFailureContext handler", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it("calls client.getTaskFailureContext with the correct taskId", async () => {
    const mockContext = {
      failureContext: {
        id: "ctx-1",
        failedTaskId: "task-1",
        failureKind: "lifecycle_failed",
        bundle: {
          artifacts: [],
          recentLifecycleEvents: [],
          experienceSignals: [],
          retryHistory: [],
          experienceCategorySummary: {},
        },
      },
    };
    client.getTaskFailureContext.mockResolvedValue(mockContext);

    const result = await getFailureContext(client, { taskId: "task-1" });

    expect(client.getTaskFailureContext).toHaveBeenCalledTimes(1);
    expect(client.getTaskFailureContext).toHaveBeenCalledWith("task-1");
    expect(result).toEqual(mockContext);
  });

  it("propagates errors from the API client (e.g. 404 when no failure context)", async () => {
    client.getTaskFailureContext.mockRejectedValue(new Error("Not found: 404"));

    await expect(getFailureContext(client, { taskId: "no-ctx" })).rejects.toThrow(/404/);
  });
});

describe("orcy_get_workflow_context — getWorkflowContext handler", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it("calls client.getTaskWorkflowContext with the correct taskId", async () => {
    const mockContext = {
      upstream: [{ id: "gate-1", gateType: "on_complete", satisfied: true }],
      downstream: [{ id: "gate-2", gateType: "on_approve", satisfied: false }],
    };
    client.getTaskWorkflowContext.mockResolvedValue(mockContext);

    const result = await getWorkflowContext(client, { taskId: "task-1" });

    expect(client.getTaskWorkflowContext).toHaveBeenCalledTimes(1);
    expect(client.getTaskWorkflowContext).toHaveBeenCalledWith("task-1");
    expect(result).toEqual(mockContext);
  });

  it("propagates errors from the API client (e.g. 404 when task not in workflow)", async () => {
    client.getTaskWorkflowContext.mockRejectedValue(new Error("Not found: 404"));

    await expect(getWorkflowContext(client, { taskId: "orphan" })).rejects.toThrow(/404/);
  });
});

describe("WORKFLOW_FAILURE_CONTEXT_HANDLER — ToolResult wrapping", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it("formats a successful response as JSON text content", async () => {
    const mockContext = { failureContext: { id: "ctx-1", failedTaskId: "task-1" } };
    client.getTaskFailureContext.mockResolvedValue(mockContext);

    const result = await WORKFLOW_FAILURE_CONTEXT_HANDLER(client, { taskId: "task-1" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(mockContext);
  });

  it("returns isError=true with message when API throws", async () => {
    client.getTaskFailureContext.mockRejectedValue(new Error("Not found: 404"));

    const result = await WORKFLOW_FAILURE_CONTEXT_HANDLER(client, { taskId: "no-ctx" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Error:.*404/);
  });

  it("returns isError=true when taskId is missing", async () => {
    const result = await WORKFLOW_FAILURE_CONTEXT_HANDLER(client, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/taskId is required/i);
    expect(client.getTaskFailureContext).not.toHaveBeenCalled();
  });
});

describe("WORKFLOW_CONTEXT_HANDLER — ToolResult wrapping", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it("formats a successful response as JSON text content", async () => {
    const mockContext = { upstream: [], downstream: [{ id: "g-1" }] };
    client.getTaskWorkflowContext.mockResolvedValue(mockContext);

    const result = await WORKFLOW_CONTEXT_HANDLER(client, { taskId: "task-1" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(mockContext);
  });

  it("returns isError=true with message when API throws", async () => {
    client.getTaskWorkflowContext.mockRejectedValue(new Error("Not found: 404"));

    const result = await WORKFLOW_CONTEXT_HANDLER(client, { taskId: "orphan" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Error:.*404/);
  });

  it("returns isError=true when taskId is missing", async () => {
    const result = await WORKFLOW_CONTEXT_HANDLER(client, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/taskId is required/i);
    expect(client.getTaskWorkflowContext).not.toHaveBeenCalled();
  });
});

describe("Tool descriptors", () => {
  it("WORKFLOW_FAILURE_CONTEXT_TOOL has correct name and schema", () => {
    expect(WORKFLOW_FAILURE_CONTEXT_TOOL.name).toBe("orcy_get_failure_context");
    expect(WORKFLOW_FAILURE_CONTEXT_TOOL.description).toMatch(/failure context/i);
    expect(WORKFLOW_FAILURE_CONTEXT_TOOL.description).toMatch(/recovery/i);
    const schema = WORKFLOW_FAILURE_CONTEXT_TOOL.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["taskId"]);
    expect(schema.properties).toHaveProperty("taskId");
  });

  it("WORKFLOW_CONTEXT_TOOL has correct name and schema", () => {
    expect(WORKFLOW_CONTEXT_TOOL.name).toBe("orcy_get_workflow_context");
    expect(WORKFLOW_CONTEXT_TOOL.description).toMatch(/workflow/i);
    const schema = WORKFLOW_CONTEXT_TOOL.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["taskId"]);
    expect(schema.properties).toHaveProperty("taskId");
  });

  it("both tools are registered in ALL_TOOLS", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names).toContain("orcy_get_failure_context");
    expect(names).toContain("orcy_get_workflow_context");
  });
});
