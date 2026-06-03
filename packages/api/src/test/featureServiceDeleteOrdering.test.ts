import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMission } from "./factories/feature.js";

vi.mock("../repositories/feature.js", () => ({
  getMissionById: vi.fn(),
  deleteMission: vi.fn(),
  getMissionsByDependency: vi.fn(),
}));

vi.mock("../repositories/event.js", () => ({
  createMissionEvent: vi.fn(),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn(), subscribe: vi.fn() },
}));

import * as missionRepo from "../repositories/feature.js";
import * as eventRepo from "../repositories/event.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { deleteMission } from "../services/featureService.js";

const mockGetMissionById = missionRepo.getMissionById as ReturnType<typeof vi.fn>;
const mockDeleteMission = missionRepo.deleteMission as ReturnType<typeof vi.fn>;
const mockGetMissionsByDependency = missionRepo.getMissionsByDependency as ReturnType<typeof vi.fn>;
const mockPublish = sseBroadcaster.publish as ReturnType<typeof vi.fn>;
const mockCreateMissionEvent = eventRepo.createMissionEvent as ReturnType<typeof vi.fn>;

describe("missionService.deleteMission — SSE broadcast ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates audit event before deleting from DB and broadcasting SSE event", () => {
    mockGetMissionById.mockReturnValue(
      makeMission({ id: "f1", habitatId: "b1", title: "Delete me" }),
    );
    mockGetMissionsByDependency.mockReturnValue([]);
    mockDeleteMission.mockReturnValue(undefined);

    const callOrder: string[] = [];
    mockCreateMissionEvent.mockImplementation(() => {
      callOrder.push("event");
    });
    mockDeleteMission.mockImplementation(() => {
      callOrder.push("delete");
    });
    mockPublish.mockImplementation(() => {
      callOrder.push("broadcast");
    });

    const result = deleteMission("f1", "user-1", "human");

    expect(result).toEqual({ success: true });
    expect(callOrder).toEqual(["event", "delete", "broadcast"]);
    expect(mockCreateMissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "f1",
        actorType: "human",
        actorId: "user-1",
        action: "deleted",
        metadata: expect.objectContaining({ title: "Delete me", habitatId: "b1" }),
      }),
    );
  });

  it("does not broadcast SSE if delete throws", () => {
    mockGetMissionById.mockReturnValue(makeMission({ id: "f1", habitatId: "b1" }));
    mockGetMissionsByDependency.mockReturnValue([]);
    mockDeleteMission.mockImplementation(() => {
      throw new Error("db error");
    });

    expect(() => deleteMission("f1")).toThrow("db error");
    expect(mockCreateMissionEvent).toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns not_found when mission does not exist", () => {
    mockGetMissionById.mockReturnValue(null);

    const result = deleteMission("nonexistent");

    expect(result).toEqual({ success: false, reason: "not_found" });
    expect(mockCreateMissionEvent).not.toHaveBeenCalled();
    expect(mockDeleteMission).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns has_dependents when mission has dependents", () => {
    mockGetMissionById.mockReturnValue(makeMission({ id: "f1", habitatId: "b1" }));
    mockGetMissionsByDependency.mockReturnValue([makeMission({ id: "f2" })]);

    const result = deleteMission("f1");

    expect(result).toEqual({ success: false, reason: "has_dependents" });
    expect(mockCreateMissionEvent).not.toHaveBeenCalled();
    expect(mockDeleteMission).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
