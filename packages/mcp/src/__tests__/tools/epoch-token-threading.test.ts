/**
 * Epoch mutation guard — MCP client/tool threading (unit).
 *
 * Pins that every served tool that reaches the four guarded mutations threads
 * the caller's `executionToken` verbatim into the client call, and that
 * `board_claim_task` gains no token input (it mints).
 */
import { describe, it, expect } from "vitest";
import {
  BOARD_CLAIM_TASK_TOOL,
  BOARD_START_TASK_TOOL,
  BOARD_SUBMIT_TASK_TOOL,
  BOARD_RELEASE_TASK_TOOL,
  BOARD_FAIL_TASK_TOOL,
  habitatStartTask,
  habitatSubmitTask,
  habitatReleaseTask,
  habitatFailTask,
} from "../../tools/task-lifecycle.js";
import { BOARD_UPDATE_TASK_TOOL, habitatUpdateTask } from "../../tools/task-crud.js";
import { createMockClient } from "../__fixtures__/mock-client.js";

const TOKEN = "epoch-token-123";

describe("epoch guard — tool schemas", () => {
  it("the four mutation tool schemas expose executionToken", () => {
    for (const tool of [
      BOARD_START_TASK_TOOL,
      BOARD_SUBMIT_TASK_TOOL,
      BOARD_RELEASE_TASK_TOOL,
      BOARD_FAIL_TASK_TOOL,
      BOARD_UPDATE_TASK_TOOL,
    ]) {
      const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props.executionToken, `${tool.name} must expose executionToken`).toBeTruthy();
      expect(
        (props.executionToken as { description?: string }).description,
        `${tool.name} description must explain the token`,
      ).toContain("executionToken");
    }
  });

  it("board_claim_task gains NO token input (claim mints)", () => {
    const props = (BOARD_CLAIM_TASK_TOOL.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.executionToken).toBeUndefined();
    expect(BOARD_CLAIM_TASK_TOOL.inputSchema).not.toContain("executionToken");
  });
});

describe("epoch guard — lifecycle tool handlers thread the token", () => {
  it("board_start_task passes executionToken to client.startTask", async () => {
    const client = createMockClient();
    client.startTask.mockResolvedValue({ task: { id: "t1" } });
    client.getAgentById = client.getAgentById ?? (() => Promise.resolve(null));
    await habitatStartTask(client as never, { taskId: "t1", executionToken: TOKEN });
    expect(client.startTask).toHaveBeenCalledWith("t1", TOKEN);
  });

  it("board_submit_task passes executionToken to client.submitTask", async () => {
    const client = createMockClient();
    client.submitTask.mockResolvedValue({ success: true });
    await habitatSubmitTask(client as never, {
      taskId: "t1",
      result: "r",
      executionToken: TOKEN,
    });
    expect(client.submitTask).toHaveBeenCalledWith("t1", "r", undefined, TOKEN);
  });

  it("board_release_task passes executionToken to client.releaseTask", async () => {
    const client = createMockClient();
    client.releaseTask.mockResolvedValue({ success: true });
    await habitatReleaseTask(client as never, { taskId: "t1", reason: "r", executionToken: TOKEN });
    expect(client.releaseTask).toHaveBeenCalledWith("t1", "r", TOKEN);
  });

  it("board_fail_task passes executionToken to client.failTask", async () => {
    const client = createMockClient();
    client.failTask.mockResolvedValue({ task: { id: "t1" } });
    client.getAgentById = client.getAgentById ?? (() => Promise.resolve(null));
    await habitatFailTask(client as never, {
      taskId: "t1",
      failureReason: "r",
      executionToken: TOKEN,
    });
    expect(client.failTask).toHaveBeenCalledWith("t1", "r", TOKEN);
  });

  it("a 409 EPOCH_MISMATCH from the client surfaces through the tool as an error", async () => {
    const client = createMockClient();
    const apiError = new Error(
      'API 409: {"error":"task was claimed in a different execution epoch; present `executionToken` from your claim response (`task.executionToken`)","code":"EPOCH_MISMATCH"}',
    );
    (apiError as Error & { status?: number }).status = 409;
    client.startTask.mockRejectedValue(apiError);
    await expect(
      habitatStartTask(client as never, { taskId: "t1", executionToken: "stale" }),
    ).rejects.toThrow(/EPOCH_MISMATCH/);
  });
});

describe("epoch guard — task-crud alias (board_update_task) threads the token", () => {
  it("status=in_progress threads executionToken into client.startTask", async () => {
    const client = createMockClient();
    client.startTask.mockResolvedValue({ task: { id: "t1" } });
    client.getAgentById = client.getAgentById ?? (() => Promise.resolve(null));
    await habitatUpdateTask(client as never, {
      taskId: "t1",
      status: "in_progress",
      executionToken: TOKEN,
    });
    expect(client.startTask).toHaveBeenCalledWith("t1", TOKEN);
  });

  it("status=submitted threads executionToken into client.submitTask", async () => {
    const client = createMockClient();
    client.submitTask.mockResolvedValue({ success: true });
    await habitatUpdateTask(client as never, {
      taskId: "t1",
      status: "submitted",
      result: "r",
      executionToken: TOKEN,
    });
    expect(client.submitTask).toHaveBeenCalledWith("t1", "r", [], TOKEN);
  });

  it("status=failed threads executionToken into client.failTask", async () => {
    const client = createMockClient();
    client.failTask.mockResolvedValue({ task: { id: "t1" } });
    client.getAgentById = client.getAgentById ?? (() => Promise.resolve(null));
    await habitatUpdateTask(client as never, {
      taskId: "t1",
      status: "failed",
      failureReason: "r",
      executionToken: TOKEN,
    });
    expect(client.failTask).toHaveBeenCalledWith("t1", "r", TOKEN);
  });

  it("status=approved / done review branches do NOT touch the token (out of agent scope)", async () => {
    const client = createMockClient();
    client.approveTask.mockResolvedValue({ task: { id: "t1" } });
    client.completeTask.mockResolvedValue({ success: true });
    client.getAgentById = client.getAgentById ?? (() => Promise.resolve(null));
    await habitatUpdateTask(client as never, { taskId: "t1", status: "approved" });
    await habitatUpdateTask(client as never, { taskId: "t1", status: "done" });
    expect(client.startTask).not.toHaveBeenCalled();
    expect(client.submitTask).not.toHaveBeenCalled();
    expect(client.failTask).not.toHaveBeenCalled();
  });
});
