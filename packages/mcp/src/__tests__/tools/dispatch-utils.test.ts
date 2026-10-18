import { describe, it, expect, vi } from "vitest";
import {
  createDispatchTool,
  createDispatchHandler,
  type Handler,
  type DispatchToolConfig,
} from "../../tools/dispatch-utils.js";
import { createMockClient } from "../__fixtures__/mock-client.js";

describe("createDispatchTool", () => {
  it("produces a Tool with the correct name and description", () => {
    const config: DispatchToolConfig = {
      name: "board_task",
      description: "Task operations",
      actions: ["claim", "submit"],
    };

    const tool = createDispatchTool(config);

    expect(tool.name).toBe("board_task");
    expect(tool.description).toBe("Task operations");
  });

  it("produces a Tool with an action enum in inputSchema", () => {
    const config: DispatchToolConfig = {
      name: "board_task",
      description: "Task operations",
      actions: ["claim", "submit", "complete"],
    };

    const tool = createDispatchTool(config);

    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.properties).toBeDefined();
    expect(tool.inputSchema.properties.action).toEqual({
      type: "string",
      enum: ["claim", "submit", "complete"],
      description: "The operation to perform",
    });
    expect(tool.inputSchema.required).toEqual(["action"]);
  });

  it("includes shared params when provided", () => {
    const config: DispatchToolConfig = {
      name: "board_task",
      description: "Task operations",
      actions: ["claim", "submit"],
      sharedParams: {
        taskId: { type: "string", description: "Task UUID" },
        boardId: { type: "string", description: "Board UUID" },
      },
    };

    const tool = createDispatchTool(config);

    expect(tool.inputSchema.properties.taskId).toEqual({
      type: "string",
      description: "Task UUID",
    });
    expect(tool.inputSchema.properties.boardId).toEqual({
      type: "string",
      description: "Board UUID",
    });
  });

  it("has no shared params when none are provided", () => {
    const config: DispatchToolConfig = {
      name: "board_suggest",
      description: "Suggest next task",
      actions: ["suggest-next-task"],
    };

    const tool = createDispatchTool(config);

    expect(Object.keys(tool.inputSchema.properties)).toEqual(["action"]);
  });

  it("requires action when no shared params", () => {
    const config: DispatchToolConfig = {
      name: "board_suggest",
      description: "Suggest next task",
      actions: ["suggest-next-task"],
    };

    const tool = createDispatchTool(config);

    expect(tool.inputSchema.required).toEqual(["action"]);
  });
});

describe("createDispatchHandler", () => {
  it("routes known actions to the correct handler", async () => {
    const client = createMockClient();
    const claimHandler = vi.fn().mockResolvedValue({ success: true });
    const submitHandler = vi.fn().mockResolvedValue({ success: true });

    const actions: Record<string, Handler> = {
      claim: claimHandler,
      submit: submitHandler,
    };

    const handler = createDispatchHandler(actions);

    await handler(client, { action: "claim", taskId: "task-1" });

    expect(claimHandler).toHaveBeenCalledTimes(1);
    expect(submitHandler).not.toHaveBeenCalled();
  });

  it("passes args through to the handler", async () => {
    const client = createMockClient();
    const mockHandler = vi.fn().mockResolvedValue({ success: true });

    const actions: Record<string, Handler> = {
      claim: mockHandler,
    };

    const handler = createDispatchHandler(actions);

    const args = { action: "claim", taskId: "task-1", boardId: "board-1" };
    await handler(client, args);

    expect(mockHandler).toHaveBeenCalledWith(client, args);
  });

  it("returns formatted result via formatResult pattern", async () => {
    const client = createMockClient();
    const resultData = { id: "task-1", status: "done" };
    const mockHandler = vi.fn().mockResolvedValue(resultData);

    const actions: Record<string, Handler> = {
      claim: mockHandler,
    };

    const handler = createDispatchHandler(actions);
    const result = await handler(client, { action: "claim" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual(resultData);
  });

  it("returns isError result for unknown actions", async () => {
    const client = createMockClient();
    const actions: Record<string, Handler> = {
      claim: vi.fn(),
    };

    const handler = createDispatchHandler(actions);
    const result = await handler(client, { action: "nonexistent" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown action: nonexistent");
    expect(result.content[0].text).toContain("claim");
  });

  it("routes to the right handler when multiple actions exist", async () => {
    const client = createMockClient();
    const claimHandler = vi.fn().mockResolvedValue({ action: "claim" });
    const submitHandler = vi.fn().mockResolvedValue({ action: "submit" });
    const completeHandler = vi.fn().mockResolvedValue({ action: "complete" });

    const actions: Record<string, Handler> = {
      claim: claimHandler,
      submit: submitHandler,
      complete: completeHandler,
    };

    const handler = createDispatchHandler(actions);

    const submitResult = await handler(client, { action: "submit" });
    expect(JSON.parse(submitResult.content[0].text)).toEqual({ action: "submit" });
    expect(claimHandler).not.toHaveBeenCalled();
    expect(submitHandler).toHaveBeenCalledTimes(1);
    expect(completeHandler).not.toHaveBeenCalled();
  });

  it("allows optional params to be omitted when not in requiredFor", async () => {
    const client = createMockClient();
    const mockHandler = vi.fn().mockResolvedValue({ cleared: true });

    const actions: Record<string, Handler> = {
      set_focus: mockHandler,
    };

    const handler = createDispatchHandler(actions, {
      set_focus: ["habitatId"],
    });

    const result = await handler(client, { action: "set_focus", habitatId: "hab-1" });
    expect(result.isError).toBeUndefined();
    expect(mockHandler).toHaveBeenCalledWith(client, { action: "set_focus", habitatId: "hab-1" });
  });

  it("allows optional params to be null when not in requiredFor", async () => {
    const client = createMockClient();
    const mockHandler = vi.fn().mockResolvedValue({ cleared: true });

    const actions: Record<string, Handler> = {
      set_focus: mockHandler,
    };

    const handler = createDispatchHandler(actions, {
      set_focus: ["habitatId"],
    });

    const result = await handler(client, {
      action: "set_focus",
      habitatId: "hab-1",
      missionId: null,
    });
    expect(result.isError).toBeUndefined();
    expect(mockHandler).toHaveBeenCalledWith(client, {
      action: "set_focus",
      habitatId: "hab-1",
      missionId: null,
    });
  });
});

describe("dispatch registration boundaries", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "rejects inherited action %s without invoking it",
    async (action) => {
      const registered = vi.fn().mockResolvedValue({ ok: true });
      const dispatch = createDispatchHandler({ registered });
      const result = await dispatch(createMockClient(), { action });
      expect(result).toEqual({
        content: [{ type: "text", text: `Unknown action: ${action}. Valid actions: registered` }],
        isError: true,
      });
      expect(registered).not.toHaveBeenCalled();
    },
  );
});

describe("malformed dispatch input", () => {
  it.each([undefined, null, 12, false, [], { toString: "registered" }, ["registered"]])(
    "rejects non-string action %# without property-key coercion",
    async (action) => {
      const registered = vi.fn().mockResolvedValue({ ok: true });
      const dispatch = createDispatchHandler({ registered });
      await expect(dispatch(createMockClient(), { action })).resolves.toEqual({
        content: [{ type: "text", text: action === undefined ? "Unknown action: undefined. Valid actions: registered" : "Action must be a string. Valid actions: registered" }],
        isError: true,
      });
      expect(registered).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, "registered", 12, false, []])(
    "rejects non-object arguments %# as a tool error",
    async (args) => {
      const registered = vi.fn();
      const dispatch = createDispatchHandler({ registered });
      await expect(dispatch(createMockClient(), args)).resolves.toEqual({
        content: [{ type: "text", text: "Arguments must be an object." }],
        isError: true,
      });
      expect(registered).not.toHaveBeenCalled();
    },
  );
});

describe("required parameter registration boundaries", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "allows an explicitly registered %s action without inherited requirements",
    async (action) => {
      const registered = vi.fn().mockResolvedValue({ ok: true });
      const dispatch = createDispatchHandler({ [action]: registered }, {});
      await expect(dispatch(createMockClient(), { action })).resolves.toEqual({
        content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }],
      });
      expect(registered).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores inherited requirement lists while preserving own lists", async () => {
    const registered = vi.fn().mockResolvedValue({ ok: true });
    const requirements = Object.create({ registered: ["unrelated"] });
    const dispatch = createDispatchHandler({ registered }, requirements);
    expect((await dispatch(createMockClient(), { action: "registered" })).isError).toBeUndefined();
    const own = createDispatchHandler({ registered }, { registered: ["habitatId", "taskId"] });
    expect(await own(createMockClient(), { action: "registered" })).toEqual({
      content: [{ type: "text", text: 'Action "registered" is missing required parameters: habitatId, taskId' }],
      isError: true,
    });
    expect((await own(createMockClient(), { action: "registered", boardId: "legacy", taskId: "task" })).isError).toBeUndefined();
  });
});

describe("dispatch validation failures", () => {
  it("keeps action access failures inside the tool error result", async () => {
    const registered = vi.fn();
    const dispatch = createDispatchHandler({ registered });
    const args = { get action() { throw new Error("Unreadable action"); } };
    await expect(dispatch(createMockClient(), args)).resolves.toEqual({
      content: [{ type: "text", text: "Error: Unreadable action" }], isError: true,
    });
    expect(registered).not.toHaveBeenCalled();
  });

  it.each(["not-a-list", {}, null])("rejects invalid own requirement metadata %# without calling the action", async (required) => {
    const registered = vi.fn();
    const dispatch = createDispatchHandler({ registered }, { registered: required } as unknown as Record<string, string[]>);
    await expect(dispatch(createMockClient(), { action: "registered" })).resolves.toEqual({
      content: [{ type: "text", text: "Error: Invalid required parameters for action: registered" }], isError: true,
    });
    expect(registered).not.toHaveBeenCalled();
  });
});


describe("required metadata entry types", () => {
  it.each([
    { label: "numeric", required: [1] },
    { label: "boolean", required: [true] },
    { label: "null", required: [null] },
    { label: "undefined", required: [undefined] },
    { label: "symbol", required: [Symbol.for("invalid-required-entry")] },
    { label: "mixed", required: ["taskId", 1] },
    { label: "sparse", required: new Array(1) },
  ])("rejects $label metadata even when coerced argument keys are present", async ({ required }) => {
    const registered = vi.fn().mockResolvedValue({ ok: true });
    const dispatch = createDispatchHandler(
      { registered },
      { registered: required } as unknown as Record<string, string[]>,
    );
    const result = await dispatch(createMockClient(), {
      action: "registered", taskId: "task-1", "1": "unrelated", true: "unrelated",
      null: "unrelated", undefined: "unrelated", [Symbol.for("invalid-required-entry")]: "unrelated",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Error: Invalid required parameters for action: registered" }],
      isError: true,
    });
    expect(registered).not.toHaveBeenCalled();
  });

  it("does not coerce an object requirement into a supplied argument key", async () => {
    const registered = vi.fn().mockResolvedValue({ ok: true });
    const coerce = vi.fn(() => "unrelated");
    const required = [{ [Symbol.toPrimitive]: coerce }];
    const dispatch = createDispatchHandler(
      { registered },
      { registered: required } as unknown as Record<string, string[]>,
    );
    expect(await dispatch(createMockClient(), { action: "registered", unrelated: "present" })).toEqual({
      content: [{ type: "text", text: "Error: Invalid required parameters for action: registered" }],
      isError: true,
    });
    expect(coerce).not.toHaveBeenCalled();
    expect(registered).not.toHaveBeenCalled();
  });

  it("preserves valid string requirements with false and zero argument values", async () => {
    const registered = vi.fn().mockResolvedValue({ ok: true });
    const client = createMockClient();
    const dispatch = createDispatchHandler({ registered }, { registered: ["enabled", "count"] });
    const args = { action: "registered", enabled: false, count: 0 };
    expect(await dispatch(client, args)).toEqual({
      content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }],
    });
    expect(registered).toHaveBeenCalledExactlyOnceWith(client, args);
  });
});

it("does not coerce object actions or invoke non-function own entries", async () => {
  const registered = vi.fn();
  const coercion = vi.fn(() => "registered");
  const dispatch = createDispatchHandler({ registered, invalid: true as unknown as Handler });
  const result = await dispatch(createMockClient(), { action: { [Symbol.toPrimitive]: coercion } });
  expect(result.isError).toBe(true);
  expect(coercion).not.toHaveBeenCalled();
  expect(registered).not.toHaveBeenCalled();
  expect(await dispatch(createMockClient(), { action: "invalid" })).toEqual({
    content: [{ type: "text", text: "Unknown action: invalid. Valid actions: registered, invalid" }],
    isError: true,
  });
});
