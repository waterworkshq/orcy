import { describe, it, expect, vi, beforeEach } from "vitest";
import { composeMissionContext } from "../services/mission-context.js";
import type { MissionContextClients } from "../services/mission-context.js";

describe("composeMissionContext", () => {
  const buildMissionDetails = (overrides: Record<string, unknown> = {}) => ({
    mission: {
      id: "m1",
      title: "Mission",
      habitatId: "h1",
      labels: ["alpha"],
    },
    tasks: [
      {
        id: "t1",
        title: "Task 1",
        status: "pending",
        result: null,
        artifacts: [],
        assignedAgentId: null,
      },
    ],
    dependencies: {
      dependsOn: ["m2", "m3"],
      blocks: ["m4"],
    },
    ...overrides,
  });

  let clients: MissionContextClients;

  beforeEach(() => {
    clients = {
      mission: {
        getMissionDetails: vi.fn().mockResolvedValue(buildMissionDetails()),
        getMission: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({ mission: { id, title: `Mission ${id}` } }),
        ),
      },
      pulse: {
        getPulseDigest: vi.fn().mockResolvedValue({ digest: "pulse data" }),
      },
      insight: {
        getRelevantInsights: vi.fn().mockResolvedValue([]),
      },
      skill: {
        getHabitatSkill: vi.fn().mockResolvedValue({ skill: null }),
      },
    } as unknown as MissionContextClients;
  });

  it("composes a mission context from all sources", async () => {
    (clients.mission.getMission as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      Promise.resolve({ mission: { id, title: `Mission ${id}` } }),
    );

    const ctx = await composeMissionContext(clients, "m1");

    expect(ctx.mission.id).toBe("m1");
    expect(ctx.tasks).toHaveLength(1);
    expect(ctx.dependencies.map((d) => d.id)).toEqual(["m2", "m3"]);
    expect(ctx.blocking.map((b) => b.id)).toEqual(["m4"]);
    expect(ctx.pulse).toEqual({ digest: "pulse data" });
    expect(ctx.projectInsights).toEqual([]);
    expect(ctx.skill).toBeUndefined();
  });

  it("filters out dependencies that fail to fetch (with warn log)", async () => {
    (clients.mission.getMission as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === "m3") return Promise.reject(new Error("not found"));
      return Promise.resolve({ mission: { id, title: `Mission ${id}` } });
    });

    const ctx = await composeMissionContext(clients, "m1");
    expect(ctx.dependencies.map((d) => d.id)).toEqual(["m2"]);
  });

  it("returns pulse undefined when pulse fetch fails", async () => {
    (clients.pulse.getPulseDigest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("pulse down"),
    );

    const ctx = await composeMissionContext(clients, "m1");
    expect(ctx.pulse).toBeUndefined();
  });

  it("does not call getRelevantInsights when no labels", async () => {
    (clients.mission.getMissionDetails as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildMissionDetails({
        mission: { id: "m1", title: "Mission", habitatId: "h1", labels: [] },
      }),
    );

    await composeMissionContext(clients, "m1");
    expect(clients.insight.getRelevantInsights).not.toHaveBeenCalled();
  });

  it("builds relevance tags from mission labels", async () => {
    (clients.insight.getRelevantInsights as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "i1", tags: ["label:alpha"] },
    ]);

    await composeMissionContext(clients, "m1");
    expect(clients.insight.getRelevantInsights).toHaveBeenCalledWith("h1", ["label:alpha"]);
  });

  it("normalizes mission id with feat- prefix stripped", async () => {
    await composeMissionContext(clients, "feat-m1");
    expect(clients.mission.getMissionDetails).toHaveBeenCalledWith("m1");
  });
});
