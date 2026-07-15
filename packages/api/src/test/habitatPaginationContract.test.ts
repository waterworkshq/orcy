import { describe, it, expect, vi, beforeEach } from "vitest";
import { missionQuerySchema } from "../models/schemas.js";

// Contract proof for the Habitat-detail-vs-Mission-list pagination boundary.
//   - GET /habitats/:id returns ALL active missions (no limit applied).
//   - GET /habitats/:id/missions defaults to limit=20, max=100.

const habitatRepoMocks = vi.hoisted(() => ({
  getHabitatWithColumnsAndTasks: vi.fn(),
}));
const missionServiceMocks = vi.hoisted(() => ({
  listMissions: vi.fn(),
}));

vi.mock("../repositories/board.js", () => habitatRepoMocks);
vi.mock("../services/featureService.js", () => missionServiceMocks);
vi.mock("../repositories/habitatSkill.js", () => ({ getOrCreateSkill: vi.fn() }));
vi.mock("../services/boardSecretCache.js", () => ({ rebuildCache: vi.fn() }));
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: vi.fn() } }));

import { getHabitat } from "../services/boardService.js";

describe("Habitat detail vs Mission list — pagination boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Habitat detail returns EVERY active mission via listMissions with isArchived:false only (no limit)", () => {
    const manyMissions = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}` }));
    habitatRepoMocks.getHabitatWithColumnsAndTasks.mockReturnValue({
      habitat: { id: "h1", name: "H", codeReviewSettings: null, ciCdSettings: null },
      columns: [],
    });
    missionServiceMocks.listMissions.mockReturnValue({
      missions: manyMissions,
      total: 150,
    });

    const result = getHabitat("h1")!;
    expect(result.missions).toHaveLength(150);
    // The service must call listMissions WITHOUT a limit so the main board
    // observes the complete active-mission collection.
    expect(missionServiceMocks.listMissions).toHaveBeenCalledWith("h1", {
      isArchived: false,
    });
    expect(missionServiceMocks.listMissions.mock.calls[0][1]?.limit).toBeUndefined();
  });

  it("missionQuerySchema defaults limit=20 offset=0 (browse default)", () => {
    const parsed = missionQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(20);
      expect(parsed.data.offset).toBe(0);
    }
  });

  it("missionQuerySchema caps limit at 100 (browse max)", () => {
    expect(missionQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(missionQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
  });

  it("missionQuerySchema no longer advertises a search filter", () => {
    const parsed = missionQuerySchema.safeParse({ search: "anything" });
    // `search` is not in the schema — extra keys are silently dropped by zod
    // object schemas by default, but the parsed result will not include it.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("search");
    }
  });
});
