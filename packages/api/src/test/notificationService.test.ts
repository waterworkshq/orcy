import { describe, it, expect, vi } from "vitest";

vi.mock("../repositories/notificationPreferences.js", () => ({ getPreferences: vi.fn() }));
vi.mock("../repositories/task.js", () => ({ getTaskById: vi.fn() }));
vi.mock("../repositories/mission.js", () => ({ getMissionById: vi.fn() }));
vi.mock("../repositories/habitat.js", () => ({ getHabitatById: vi.fn() }));
vi.mock("../repositories/user.js", () => ({
  getActorName: vi.fn(),
  getUserEmail: vi.fn(),
  getAdmins: vi.fn(() => []),
}));
vi.mock("../repositories/watcher.js", () => ({ getWatcherUserIdsForTask: vi.fn() }));
vi.mock("../services/emailService.js", () => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }));
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return { ...actual, eq: vi.fn((_c, _v) => ({ _type: "eq" })) };
});

import { getPreferences } from "../repositories/notificationPreferences.js";
import { getTaskById } from "../repositories/task.js";
import { isConfigured } from "../services/emailService.js";

import { processEvent } from "../services/notificationService.js";

describe("notificationService", () => {
  it("returns early when email not configured", async () => {
    vi.mocked(isConfigured).mockReturnValue(false);
    await processEvent("task.assigned", "h1", {});
    expect(getTaskById).not.toHaveBeenCalled();
  });

  it("returns early when task not found", async () => {
    vi.mocked(isConfigured).mockReturnValue(true);
    vi.mocked(getTaskById).mockReturnValue(null);
    await processEvent("task.assigned", "h1", { taskId: "t1" });
  });

  it("processes task.assigned when no preferences", async () => {
    vi.mocked(isConfigured).mockReturnValue(true);
    vi.mocked(getTaskById).mockReturnValue({
      id: "t1",
      missionId: "m1",
      title: "T",
      assignedAgentId: "a1",
    } as any);
    vi.mocked(getPreferences).mockReturnValue({ taskAssigned: false } as any);
    await processEvent("task.assigned", "h1", { taskId: "t1", actorId: "u1" });
  });

  it("processes task.priority_changed", async () => {
    vi.mocked(isConfigured).mockReturnValue(true);
    vi.mocked(getTaskById).mockReturnValue({
      id: "t1",
      missionId: "m1",
      title: "T",
      assignedAgentId: "a1",
    } as any);
    vi.mocked(getPreferences).mockReturnValue({ taskPriorityChanged: false } as any);
    await processEvent("task.priority_changed", "h1", {
      taskId: "t1",
      oldPriority: "low",
      newPriority: "critical",
    });
  });
});
