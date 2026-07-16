import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoMocks = vi.hoisted(() => ({
  getHabitatWithColumnsAndTasks: vi.fn(),
  getMissionsByHabitatId: vi.fn(),
  getTasksByHabitatId: vi.fn(),
  getEventsByHabitatId: vi.fn(),
  getMissionEventsByHabitatId: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock("../repositories/habitat.js", () => ({
  getHabitatWithColumnsAndTasks: repoMocks.getHabitatWithColumnsAndTasks,
}));
vi.mock("../repositories/mission.js", () => ({
  getMissionsByHabitatId: repoMocks.getMissionsByHabitatId,
}));
vi.mock("../repositories/task.js", () => ({
  getTasksByHabitatId: repoMocks.getTasksByHabitatId,
}));
vi.mock("../repositories/event.js", () => ({
  getEventsByHabitatId: repoMocks.getEventsByHabitatId,
  getMissionEventsByHabitatId: repoMocks.getMissionEventsByHabitatId,
}));
vi.mock("../repositories/agent.js", () => ({
  listAgents: repoMocks.listAgents,
}));

import { generateHabitatSummary } from "../services/boardSummaryService.js";

const NOW = new Date("2026-05-27T12:00:00.000Z");

function iso(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}

function setupSummaryData(tasks: Array<Record<string, unknown>>) {
  repoMocks.getHabitatWithColumnsAndTasks.mockReturnValue({
    habitat: { id: "habitat-1", name: "Summary Habitat", description: "" },
    columns: [{ id: "column-1", name: "Todo", isTerminal: false }],
  });
  repoMocks.getMissionsByHabitatId.mockReturnValue({
    missions: [
      {
        id: "mission-1",
        columnId: "column-1",
        title: "Summary Mission",
        status: "not_started",
        priority: "medium",
        dependsOn: [],
      },
    ],
  });
  repoMocks.getTasksByHabitatId.mockReturnValue({ tasks });
  repoMocks.getEventsByHabitatId.mockReturnValue({ events: [] });
  repoMocks.getMissionEventsByHabitatId.mockReturnValue({ events: [] });
  repoMocks.listAgents.mockReturnValue([]);
}

describe("boardSummaryService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes period average cycle time from completed task timestamps", () => {
    setupSummaryData([
      {
        id: "task-1",
        missionId: "mission-1",
        title: "Cycle A",
        status: "done",
        claimedAt: iso(70),
        completedAt: iso(10),
        priority: "medium",
      },
      {
        id: "task-2",
        missionId: "mission-1",
        title: "Cycle B",
        status: "approved",
        claimedAt: iso(130),
        completedAt: iso(10),
        priority: "medium",
      },
    ]);

    const summary = generateHabitatSummary("habitat-1", { since: "24h", includeDigest: false });

    expect(summary?.recentActivity[0].metrics.avgCycleTimeMinutes).toBe(90);
  });

  it("returns null period average cycle time when no completed task samples exist", () => {
    setupSummaryData([
      {
        id: "task-1",
        missionId: "mission-1",
        title: "Pending",
        status: "pending",
        claimedAt: null,
        completedAt: null,
        priority: "medium",
      },
    ]);

    const summary = generateHabitatSummary("habitat-1", { since: "24h", includeDigest: false });

    expect(summary?.recentActivity[0].metrics.avgCycleTimeMinutes).toBeNull();
  });
});
