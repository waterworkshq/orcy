import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildPluginContext } from "../plugins/context.js";

const createPulseMock = vi.fn();
const getPulseByIdMock = vi.fn();
const listByHabitatSinceMock = vi.fn();
const listByHabitatBetweenMock = vi.fn();
const getTaskByIdMock = vi.fn();
const getTasksByHabitatIdMock = vi.fn();
const listCommentsMock = vi.fn();
const getHabitatByIdMock = vi.fn();

vi.mock("../repositories/pulse.js", () => ({
  createPulse: (i: unknown) => createPulseMock(i),
  getPulseById: (i: unknown) => getPulseByIdMock(i),
  listByHabitatSince: (h: unknown, s: unknown) => listByHabitatSinceMock(h, s),
  listByHabitatBetween: (h: unknown, f: unknown, t: unknown) => listByHabitatBetweenMock(h, f, t),
}));

vi.mock("../repositories/task.js", () => ({
  getTaskById: (i: unknown) => getTaskByIdMock(i),
  getTasksByHabitatId: (h: unknown, f?: unknown) => getTasksByHabitatIdMock(h, f),
}));

vi.mock("../repositories/comment.js", () => ({
  listByHabitatSince: (h: unknown, s: unknown) => listCommentsMock(h, s),
}));

vi.mock("../repositories/board.js", () => ({
  getHabitatById: (i: unknown) => getHabitatByIdMock(i),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("pluginContext: capability projections", () => {
  beforeEach(() => {
    createPulseMock.mockReset();
    getPulseByIdMock.mockReset();
    getTaskByIdMock.mockReset();
    getHabitatByIdMock.mockReset();
  });

  it("PulseWriter.createDetectedSignal server-injects detected/detector/detectorRunId", async () => {
    createPulseMock.mockReturnValue({ id: "pulse-1", metadata: {} });
    const ctx = buildPluginContext({
      pluginId: "my-detector",
      contributionId: "d1",
      habitatId: "hab-1",
      runId: "run-9",
      requires: ["pulseWriter"],
    });
    await ctx.pulseWriter!.createDetectedSignal({
      signalType: "detected",
      subject: "hello",
      metadata: { custom: "field" },
    });
    expect(createPulseMock).toHaveBeenCalledTimes(1);
    const call = createPulseMock.mock.calls[0][0];
    expect(call.signalType).toBe("detected");
    expect(call.fromType).toBe("system");
    expect(call.fromId).toBe("my-detector");
    expect(call.isAuto).toBe(true);
    expect(call.habitatId).toBe("hab-1");
    expect(call.metadata).toEqual({
      custom: "field",
      detected: true,
      detector: "my-detector",
      detectorRunId: "run-9",
    });
  });

  it("PulseWriter.createDetectedSignal rejects non-detected signalType", async () => {
    const ctx = buildPluginContext({
      pluginId: "p",
      contributionId: "c",
      habitatId: "h",
      runId: "r",
      requires: ["pulseWriter"],
    });
    await expect(
      ctx.pulseWriter!.createDetectedSignal({
        signalType: "experience" as "detected",
        subject: "nope",
      }),
    ).rejects.toThrow(/signalType "detected"/);
    expect(createPulseMock).not.toHaveBeenCalled();
  });

  it("TaskReader.getTask returns the Task as-is (no auth fields stripped)", async () => {
    const task = { id: "t1", title: "Sample", apiKeyHash: "should-not-exist-on-task" };
    getTaskByIdMock.mockReturnValue(task);
    const ctx = buildPluginContext({
      pluginId: "p",
      contributionId: "c",
      habitatId: "h",
      runId: "r",
      requires: ["taskReader"],
    });
    const result = await ctx.taskReader!.getTask("t1");
    expect(result).toEqual(task);
  });

  it("HabitatReader.getHabitat returns PluginHabitatView (admin settings stripped)", async () => {
    getHabitatByIdMock.mockReturnValue({
      id: "h1",
      name: "Board",
      description: "desc",
      teamId: null,
      retrySettings: { maxRetries: 5 },
      anomalySettings: { enabled: true },
      automationSettings: { rules: [] },
      wikiSettings: { enabled: false },
      eventRetentionDays: 30,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const ctx = buildPluginContext({
      pluginId: "p",
      contributionId: "c",
      habitatId: "h1",
      runId: "r",
      requires: ["habitatReader"],
    });
    const result = await ctx.habitatReader!.getHabitat("h1");
    expect(result).toEqual({
      id: "h1",
      name: "Board",
      description: "desc",
      teamId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });

  it("HabitatReader.getHabitat returns null when habitat missing", async () => {
    getHabitatByIdMock.mockReturnValue(null);
    const ctx = buildPluginContext({
      pluginId: "p",
      contributionId: "c",
      habitatId: "h1",
      runId: "r",
      requires: ["habitatReader"],
    });
    expect(await ctx.habitatReader!.getHabitat("h1")).toBeNull();
  });

  it("leaves undeclared capabilities undefined", () => {
    const ctx = buildPluginContext({
      pluginId: "p",
      contributionId: "c",
      habitatId: "h",
      runId: "r",
      requires: ["taskReader"],
    });
    expect(ctx.taskReader).toBeDefined();
    expect(ctx.pulseReader).toBeUndefined();
    expect(ctx.pulseWriter).toBeUndefined();
    expect(ctx.commentReader).toBeUndefined();
    expect(ctx.habitatReader).toBeUndefined();
  });

  it("always provides logger and audit", () => {
    const ctx = buildPluginContext({
      pluginId: "p",
      contributionId: "c",
      habitatId: "h",
      runId: "r",
      requires: [],
    });
    expect(ctx.logger).toBeDefined();
    expect(ctx.logger.info).toBeTypeOf("function");
    expect(ctx.audit).toBeDefined();
    expect(ctx.audit.log).toBeTypeOf("function");
    expect(() => ctx.audit.log({ action: "test" })).not.toThrow();
  });
});
