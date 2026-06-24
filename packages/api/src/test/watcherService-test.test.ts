import { describe, it, expect, vi, beforeEach } from "vitest";

const watcherMocks = vi.hoisted(() => ({
  addWatcher: vi.fn(() => ({ taskId: "t1", userId: "u1", createdAt: "2025-01-01" })),
  removeWatcher: vi.fn(() => true),
  isWatching: vi.fn(() => true),
  getWatchersForTask: vi.fn(() => [{ taskId: "t1", userId: "u1", createdAt: "2025-01-01" }]),
  getWatcherUserIdsForTask: vi.fn(() => ["u1"]),
}));
const taskMocks = vi.hoisted(() => ({
  getTaskById: vi.fn(() => ({ id: "t1", title: "Task X" })),
}));
const sseMock = vi.hoisted(() => vi.fn());

vi.mock("../repositories/watcher.js", () => watcherMocks);
vi.mock("../repositories/task.js", () => taskMocks);
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: sseMock } }));
vi.mock("../errors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../errors.js")>();
  return { ...actual };
});

import { watchTask, notifyWatchers } from "../services/watcherService.js";

describe("watcherService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    watcherMocks.addWatcher.mockReturnValue({
      taskId: "t1",
      userId: "u1",
      createdAt: "2025-01-01",
    });
    watcherMocks.removeWatcher.mockReturnValue(true);
    watcherMocks.isWatching.mockReturnValue(true);
    watcherMocks.getWatchersForTask.mockReturnValue([
      { taskId: "t1", userId: "u1", createdAt: "2025-01-01" },
    ]);
    watcherMocks.getWatcherUserIdsForTask.mockReturnValue(["u1"]);
    taskMocks.getTaskById.mockReturnValue({ id: "t1", title: "Task X" });
  });

  it("watchTask throws when task not found", () => {
    taskMocks.getTaskById.mockReturnValue(null as any);
    expect(() => watchTask("t1", "u1")).toThrow("Task not found");
  });

  it("watchTask adds watcher when task exists", () => {
    const r = watchTask("t1", "u1");
    expect(r.taskId).toBe("t1");
  });

  it("notifyWatchers publishes when watchers exist", () => {
    notifyWatchers("t1", "h1", "task.updated");
    expect(sseMock).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "task.watcher_notify" }),
    );
  });

  it("notifyWatchers skips when no watchers", () => {
    watcherMocks.getWatcherUserIdsForTask.mockReturnValue([]);
    sseMock.mockClear();
    notifyWatchers("t1", "h1", "task.updated");
    expect(sseMock).not.toHaveBeenCalled();
  });
});
