import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMission } from "./factories/mission.js";
import type { Column } from "../models/index.js";

// Contract: versioned Mission move + auto-advance use repository OCC.
// Stale expectedVersion produces NO write, NO SSE event, and surfaces a
// staleVersion result the route translates to 409 VERSION_CONFLICT.

const publisherMock = vi.hoisted(() => ({ publish: vi.fn() }));
const createMissionEventMock = vi.hoisted(() => vi.fn());

vi.mock("../repositories/mission.js", () => ({
  updateMission: vi.fn(),
  getMissionById: vi.fn(),
  moveMission: vi.fn(),
}));

vi.mock("../repositories/task.js", () => ({
  getTasksByMissionId: vi.fn(() => []),
}));

vi.mock("../repositories/column.js", () => ({
  getColumnsByHabitatId: vi.fn(),
  getColumnById: vi.fn(() => ({ id: "to-col", habitatId: "h1" })),
}));

vi.mock("../repositories/event.js", () => ({
  createMissionEvent: createMissionEventMock,
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: publisherMock,
}));

import * as missionRepo from "../repositories/mission.js";
import * as columnRepo from "../repositories/column.js";
import { moveMissionToColumn, autoAdvanceMissionColumn } from "../services/featureService.js";

const mockMoveMission = vi.mocked(missionRepo.moveMission);
const mockGetMissionById = vi.mocked(missionRepo.getMissionById);
const mockGetColumns = vi.mocked(columnRepo.getColumnsByHabitatId);

const twoColumns: Column[] = [
  {
    id: "from-col",
    habitatId: "h1",
    name: "Todo",
    order: 0,
    wipLimit: null,
    autoAdvance: false,
    requiresClaim: true,
    nextColumnId: "to-col",
    isTerminal: false,
  },
  {
    id: "to-col",
    habitatId: "h1",
    name: "In Progress",
    order: 1,
    wipLimit: null,
    autoAdvance: false,
    requiresClaim: true,
    nextColumnId: null,
    isTerminal: false,
  },
];

describe("missionService.moveMissionToColumn — versioned move contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMissionById.mockReturnValue(
      makeMission({ id: "m1", habitatId: "h1", columnId: "from-col", version: 5 }),
    );
  });

  it("passes expectedVersion through to the repo and returns { mission } on match", () => {
    const moved = makeMission({ id: "m1", habitatId: "h1", columnId: "to-col", version: 6 });
    mockMoveMission.mockReturnValue({ success: true, mission: moved });

    const result = moveMissionToColumn("m1", "to-col", "user-1", "human", 5);

    expect(result).toEqual({ mission: moved });
    expect(mockMoveMission).toHaveBeenCalledWith("m1", "to-col", 5);
  });

  it("returns { staleVersion, currentVersion } on version mismatch WITHOUT emitting events", () => {
    mockMoveMission.mockReturnValue({
      success: false,
      versionMismatch: true,
      currentVersion: 9,
    });

    const result = moveMissionToColumn("m1", "to-col", "user-1", "human", 5);

    expect(result).toEqual({ staleVersion: true, currentVersion: 9 });
    expect(publisherMock.publish).not.toHaveBeenCalled();
    expect(createMissionEventMock).not.toHaveBeenCalled();
  });

  it("returns { notFound } when the mission is missing", () => {
    mockGetMissionById.mockReturnValue(null);
    const result = moveMissionToColumn("m1", "to-col", "user-1", "human", 5);
    expect(result).toEqual({ notFound: true });
  });

  it("propagates the supplied expectedVersion to the repo", () => {
    const moved = makeMission({ id: "m1", columnId: "to-col", version: 8 });
    mockMoveMission.mockReturnValue({ success: true, mission: moved });
    moveMissionToColumn("m1", "to-col", "user-1", "human", 7);
    expect(mockMoveMission).toHaveBeenCalledWith("m1", "to-col", 7);
  });
});

describe("missionService.autoAdvanceMissionColumn — repo OCC contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetColumns.mockReturnValue(twoColumns);
  });

  it("supplies the observed mission.version and emits events on a successful auto-advance", () => {
    const observed = makeMission({
      id: "m1",
      habitatId: "h1",
      columnId: "from-col",
      version: 4,
    });
    const advanced = makeMission({
      id: "m1",
      habitatId: "h1",
      columnId: "to-col",
      version: 5,
    });
    mockMoveMission.mockReturnValue({ success: true, mission: advanced });

    const result = autoAdvanceMissionColumn(observed, "in_progress");

    expect(result).toEqual({ mission: advanced, columnChanged: true });
    expect(mockMoveMission).toHaveBeenCalledWith("m1", "to-col", 4);
    expect(publisherMock.publish).toHaveBeenCalledWith("h1", {
      type: "mission.moved",
      data: { missionId: "m1", fromColumnId: "from-col", toColumnId: "to-col" },
    });
  });

  it("returns { staleVersion, currentVersion } when a concurrent manual move committed first, with NO write and NO mission.moved/updated event", () => {
    const observed = makeMission({
      id: "m1",
      habitatId: "h1",
      columnId: "from-col",
      version: 4,
    });
    mockMoveMission.mockReturnValue({
      success: false,
      versionMismatch: true,
      currentVersion: 8,
    });

    const result = autoAdvanceMissionColumn(observed, "in_progress");

    expect(result).toEqual({ staleVersion: true, currentVersion: 8 });
    expect(publisherMock.publish).not.toHaveBeenCalled();
    expect(createMissionEventMock).not.toHaveBeenCalled();
  });
});
