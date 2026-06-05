import { describe, expect, it, vi } from "vitest";
import { HABITAT_ACTIONS } from "../tools/habitat-dispatch.js";
import { SPRINT_ACTIONS } from "../tools/sprint-dispatch.js";
import type { KanbanApiClient } from "../api.js";

describe("analytics dispatch actions", () => {
  it("routes habitat analytics actions to the API client", async () => {
    const client = {
      getHabitatPredictions: vi.fn().mockResolvedValue({ forecasts: [], atRiskTasks: [] }),
      getHabitatBottlenecks: vi.fn().mockResolvedValue({ days: 14, findings: [], warnings: [] }),
      getHabitatAgentQuality: vi.fn().mockResolvedValue({ signals: [] }),
    } as unknown as KanbanApiClient;

    await HABITAT_ACTIONS.predictions(client, { boardId: "habitat-1" });
    await HABITAT_ACTIONS.bottlenecks(client, { boardId: "habitat-1", days: 14 });
    await HABITAT_ACTIONS["agent-quality"](client, { boardId: "habitat-1" });

    expect(client.getHabitatPredictions).toHaveBeenCalledWith("habitat-1");
    expect(client.getHabitatBottlenecks).toHaveBeenCalledWith("habitat-1", 14);
    expect(client.getHabitatAgentQuality).toHaveBeenCalledWith("habitat-1");
  });

  it("routes sprint analytics actions and summarizes burndown", async () => {
    const client = {
      getSprintMetrics: vi.fn().mockResolvedValue({ totalTasks: 5 }),
      getSprintBurndown: vi.fn().mockResolvedValue({
        data: [{ date: "2026-06-05" }],
        totalTasks: 5,
        completedTasks: 2,
        remainingTasks: 3,
        averageDailyVelocity: 0.5,
        estimatedCompletionDate: null,
      }),
      getSprintCarryOver: vi.fn().mockResolvedValue({ carriedOverMissions: [] }),
    } as unknown as KanbanApiClient;

    await SPRINT_ACTIONS.get_metrics(client, { sprintId: "sprint-1" });
    const burndown = await SPRINT_ACTIONS.get_burndown(client, { sprintId: "sprint-1" });
    await SPRINT_ACTIONS.get_carry_over(client, { sprintId: "sprint-1" });

    expect(client.getSprintMetrics).toHaveBeenCalledWith("sprint-1");
    expect(client.getSprintBurndown).toHaveBeenCalledWith("sprint-1");
    expect(client.getSprintCarryOver).toHaveBeenCalledWith("sprint-1");
    expect(burndown).toEqual({
      sprintId: "sprint-1",
      totalTasks: 5,
      completedTasks: 2,
      remainingTasks: 3,
      averageDailyVelocity: 0.5,
      estimatedCompletionDate: null,
    });
  });
});
