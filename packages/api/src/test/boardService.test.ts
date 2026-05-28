import { describe, it, expect, vi, beforeEach } from "vitest";

const habitatRepoMocks = vi.hoisted(() => ({
  createHabitat: vi.fn(),
  getHabitatWithColumnsAndTasks: vi.fn(),
  getHabitatById: vi.fn(),
  listHabitats: vi.fn(),
  updateHabitat: vi.fn(),
  deleteHabitat: vi.fn(),
}));
const columnRepoMocks = vi.hoisted(() => ({
  createDefaultColumns: vi.fn(),
  getColumnsByHabitatId: vi.fn(),
  createColumn: vi.fn(),
  updateColumn: vi.fn(),
}));
const taskRepoMocks = vi.hoisted(() => ({
  getTasksByHabitatId: vi.fn(),
  getTasksByMissionId: vi.fn(),
}));
const missionRepoMocks = vi.hoisted(() => ({
  getMissionById: vi.fn(),
  getMissionsByHabitatId: vi.fn(),
}));
const eventRepoMocks = vi.hoisted(() => ({ getHabitatStats: vi.fn() }));
const commentRepoMocks = vi.hoisted(() => ({ getCommentsByTaskId: vi.fn() }));
const templateRepoMocks = vi.hoisted(() => ({ getTemplatesByHabitatId: vi.fn() }));
const filterRepoMocks = vi.hoisted(() => ({ seedBuiltinFilters: vi.fn() }));
const webhookMocks = vi.hoisted(() => ({
  getWebhookSubscriptions: vi.fn(),
  createWebhookSubscription: vi.fn(),
}));
const missionServiceMocks = vi.hoisted(() => ({
  listMissions: vi.fn(),
  recalculateMissionStatus: vi.fn(),
}));
const cacheMock = vi.hoisted(() => ({ rebuildCache: vi.fn() }));
const sseMock = vi.hoisted(() => vi.fn());
const pluginMock = vi.hoisted(() => ({ emitHabitatCreated: vi.fn(() => Promise.resolve()) }));

vi.mock("../repositories/board.js", () => habitatRepoMocks);
vi.mock("../repositories/column.js", () => columnRepoMocks);
vi.mock("../repositories/task.js", () => taskRepoMocks);
vi.mock("../repositories/feature.js", () => missionRepoMocks);
vi.mock("../repositories/event.js", () => eventRepoMocks);
vi.mock("../repositories/comment.js", () => commentRepoMocks);
vi.mock("../repositories/template.js", () => templateRepoMocks);
vi.mock("../repositories/savedFilter.js", () => filterRepoMocks);
vi.mock("../services/webhookDispatcher.js", () => webhookMocks);
vi.mock("../services/featureService.js", () => missionServiceMocks);
vi.mock("../services/boardSecretCache.js", () => cacheMock);
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: sseMock } }));
vi.mock("../plugins/pluginManager.js", () => pluginMock);
vi.mock("../errors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../errors.js")>();
  return { ...actual };
});

import {
  getHabitat,
  getHabitatStats,
  updateHabitat,
  deleteHabitat,
  exportHabitat,
} from "../services/boardService.js";

describe("boardService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    habitatRepoMocks.listHabitats.mockReturnValue([]);
    missionServiceMocks.listMissions.mockReturnValue({ missions: [], total: 0 });
    missionRepoMocks.getMissionsByHabitatId.mockReturnValue({ missions: [], total: 0 });
    taskRepoMocks.getTasksByMissionId.mockReturnValue([]);
    commentRepoMocks.getCommentsByTaskId.mockReturnValue({ comments: [], total: 0 });
    templateRepoMocks.getTemplatesByHabitatId.mockReturnValue([]);
    webhookMocks.getWebhookSubscriptions.mockReturnValue([]);
  });

  describe("getHabitat", () => {
    it("returns null when habitat not found", () => {
      habitatRepoMocks.getHabitatWithColumnsAndTasks.mockReturnValue(null);
      expect(getHabitat("x")).toBeNull();
    });
    it("returns habitat with missions", () => {
      habitatRepoMocks.getHabitatWithColumnsAndTasks.mockReturnValue({
        habitat: { id: "h1", name: "H" },
        columns: [],
        tasks: [],
      });
      missionServiceMocks.listMissions.mockReturnValue({ missions: [], total: 0 });
      const r = getHabitat("h1")!;
      expect(r.habitat.id).toBe("h1");
    });
  });

  describe("updateHabitat", () => {
    it("updates and broadcasts", () => {
      habitatRepoMocks.updateHabitat.mockReturnValue({ id: "h1", name: "Updated" });
      const r = updateHabitat("h1", { name: "Updated" } as any)!;
      expect(r.name).toBe("Updated");
      expect(cacheMock.rebuildCache).toHaveBeenCalled();
      expect(sseMock).toHaveBeenCalled();
    });
    it("returns null on failure", () => {
      habitatRepoMocks.updateHabitat.mockReturnValue(null);
      expect(updateHabitat("h1", {})).toBeNull();
    });
  });

  describe("deleteHabitat", () => {
    it("deletes and broadcasts", () => {
      deleteHabitat("h1");
      expect(habitatRepoMocks.deleteHabitat).toHaveBeenCalledWith("h1");
      expect(cacheMock.rebuildCache).toHaveBeenCalled();
      expect(sseMock).toHaveBeenCalled();
    });
  });

  describe("getHabitatStats", () => {
    it("returns stats with WIP health", () => {
      eventRepoMocks.getHabitatStats.mockReturnValue({
        cycleTime: null,
        throughput: { today: 3, thisWeek: 3, thisMonth: 3 },
      });
      columnRepoMocks.getColumnsByHabitatId.mockReturnValue([
        { id: "c1", name: "Todo", wipLimit: null, order: 0 },
        { id: "c2", name: "In Progress", wipLimit: 5, order: 1 },
      ]);
      missionRepoMocks.getMissionsByHabitatId.mockReturnValue({
        missions: [{ id: "m1" }],
        total: 1,
      });
      const r = getHabitatStats("h1");
      expect(r.throughput.today).toBe(3);
      expect(r.wipHealth).toBeDefined();
    });
  });

  describe("exportHabitat", () => {
    it("returns null when habitat not found", () => {
      habitatRepoMocks.getHabitatWithColumnsAndTasks.mockReturnValue(null);
      expect(exportHabitat("x")).toBeNull();
    });

    it("exports habitat with columns and missions", () => {
      habitatRepoMocks.getHabitatWithColumnsAndTasks.mockReturnValue({
        habitat: {
          id: "h1",
          name: "H",
          description: "D",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        },
        columns: [
          {
            id: "c1",
            name: "Todo",
            order: 0,
            wipLimit: null,
            autoAdvance: false,
            requiresClaim: false,
            isTerminal: false,
            nextColumnId: null,
          },
        ],
        tasks: [],
      });
      missionRepoMocks.getMissionsByHabitatId.mockReturnValue({ missions: [], total: 0 });
      webhookMocks.getWebhookSubscriptions.mockReturnValue([]);
      templateRepoMocks.getTemplatesByHabitatId.mockReturnValue([]);

      const r = exportHabitat("h1")!;
      expect(r.version).toBe(2);
      expect(r.habitat.name).toBe("H");
      expect(r.habitat.columns).toHaveLength(1);
    });
  });
});
