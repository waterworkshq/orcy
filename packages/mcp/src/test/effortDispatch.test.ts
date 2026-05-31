import { describe, it, expect, vi } from "vitest";
import {
  habitatLogEffort,
  habitatListEffort,
  habitatGetEffortReport,
  habitatCorrectEffortEntry,
} from "../tools/lifecycle-gaps.js";

function createMockClient() {
  return {
    logEffort: vi.fn(() => Promise.resolve({ id: "entry-1", taskId: "task-1", minutes: 30 })),
    listEffortEntries: vi.fn(() =>
      Promise.resolve([{ id: "entry-1", taskId: "task-1", minutes: 30, note: "did stuff" }]),
    ),
    getEffortReport: vi.fn(() =>
      Promise.resolve({
        taskId: "task-1",
        totalMinutes: 60,
        entryCount: 2,
        correctedMinutes: 0,
      }),
    ),
    correctEffortEntry: vi.fn(() =>
      Promise.resolve({ id: "correction-1", entryId: "entry-1", minutesDelta: -10 }),
    ),
  } as any;
}

describe("habitatLogEffort", () => {
  it("passes taskId and minutes to client.logEffort", async () => {
    const client = createMockClient();
    await habitatLogEffort(client, { taskId: "task-1", minutes: 30 });
    expect(client.logEffort).toHaveBeenCalledWith("task-1", 30, undefined, undefined, undefined);
  });

  it("passes all optional fields to client.logEffort", async () => {
    const client = createMockClient();
    await habitatLogEffort(client, {
      taskId: "task-1",
      minutes: 45,
      note: "debugging session",
      startedAt: "2026-01-01T10:00:00Z",
      endedAt: "2026-01-01T10:45:00Z",
    });
    expect(client.logEffort).toHaveBeenCalledWith(
      "task-1",
      45,
      "debugging session",
      "2026-01-01T10:00:00Z",
      "2026-01-01T10:45:00Z",
    );
  });

  it("passes note without timestamps", async () => {
    const client = createMockClient();
    await habitatLogEffort(client, { taskId: "task-1", minutes: 15, note: "quick fix" });
    expect(client.logEffort).toHaveBeenCalledWith("task-1", 15, "quick fix", undefined, undefined);
  });

  it("returns the result from client.logEffort", async () => {
    const client = createMockClient();
    const result = await habitatLogEffort(client, { taskId: "task-1", minutes: 30 });
    expect(result).toEqual({ id: "entry-1", taskId: "task-1", minutes: 30 });
  });
});

describe("habitatListEffort", () => {
  it("passes taskId to client.listEffortEntries", async () => {
    const client = createMockClient();
    await habitatListEffort(client, { taskId: "task-1" });
    expect(client.listEffortEntries).toHaveBeenCalledWith("task-1", undefined);
  });

  it("passes taskId and includeCorrections=true", async () => {
    const client = createMockClient();
    await habitatListEffort(client, { taskId: "task-1", includeCorrections: true });
    expect(client.listEffortEntries).toHaveBeenCalledWith("task-1", true);
  });

  it("passes taskId and includeCorrections=false", async () => {
    const client = createMockClient();
    await habitatListEffort(client, { taskId: "task-1", includeCorrections: false });
    expect(client.listEffortEntries).toHaveBeenCalledWith("task-1", false);
  });

  it("returns the result from client.listEffortEntries", async () => {
    const client = createMockClient();
    const result = await habitatListEffort(client, { taskId: "task-1" });
    expect(result).toEqual([{ id: "entry-1", taskId: "task-1", minutes: 30, note: "did stuff" }]);
  });
});

describe("habitatGetEffortReport", () => {
  it("passes taskId to client.getEffortReport", async () => {
    const client = createMockClient();
    await habitatGetEffortReport(client, { taskId: "task-1" });
    expect(client.getEffortReport).toHaveBeenCalledWith("task-1");
  });

  it("returns the result from client.getEffortReport", async () => {
    const client = createMockClient();
    const result = await habitatGetEffortReport(client, { taskId: "task-1" });
    expect(result).toEqual({
      taskId: "task-1",
      totalMinutes: 60,
      entryCount: 2,
      correctedMinutes: 0,
    });
  });
});

describe("habitatCorrectEffortEntry", () => {
  it("passes all fields to client.correctEffortEntry", async () => {
    const client = createMockClient();
    await habitatCorrectEffortEntry(client, {
      taskId: "task-1",
      entryId: "entry-1",
      minutesDelta: -10,
      correctionReason: "overcounted by 10 minutes",
      note: "timer was left running",
    });
    expect(client.correctEffortEntry).toHaveBeenCalledWith(
      "task-1",
      "entry-1",
      -10,
      "overcounted by 10 minutes",
      "timer was left running",
    );
  });

  it("passes required fields without optional note", async () => {
    const client = createMockClient();
    await habitatCorrectEffortEntry(client, {
      taskId: "task-1",
      entryId: "entry-1",
      minutesDelta: 5,
      correctionReason: "undercounted",
    });
    expect(client.correctEffortEntry).toHaveBeenCalledWith(
      "task-1",
      "entry-1",
      5,
      "undercounted",
      undefined,
    );
  });

  it("returns the result from client.correctEffortEntry", async () => {
    const client = createMockClient();
    const result = await habitatCorrectEffortEntry(client, {
      taskId: "task-1",
      entryId: "entry-1",
      minutesDelta: -10,
      correctionReason: "fix",
    });
    expect(result).toEqual({ id: "correction-1", entryId: "entry-1", minutesDelta: -10 });
  });
});
