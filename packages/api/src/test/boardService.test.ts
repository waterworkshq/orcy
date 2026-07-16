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
  createTask: vi.fn(),
}));
const missionRepoMocks = vi.hoisted(() => ({
  getMissionById: vi.fn(),
  getMissionsByHabitatId: vi.fn(),
  getMissionDependencyEdges: vi.fn(() => []),
  createMission: vi.fn(),
  updateMission: vi.fn(),
}));
const eventRepoMocks = vi.hoisted(() => ({ getHabitatStats: vi.fn() }));
const commentRepoMocks = vi.hoisted(() => ({
  getCommentsByTaskId: vi.fn(),
  createComment: vi.fn(),
}));
const templateRepoMocks = vi.hoisted(() => ({
  getTemplatesByHabitatId: vi.fn(),
  createTemplate: vi.fn(),
}));
const filterRepoMocks = vi.hoisted(() => ({ seedBuiltinFilters: vi.fn() }));
const skillRepoMocks = vi.hoisted(() => ({ getOrCreateSkill: vi.fn() }));
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
vi.mock("../repositories/habitatSkill.js", () => skillRepoMocks);
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
  maskSecretSettings,
  setWebhookSecrets,
  createHabitat,
  listHabitats,
  importHabitat,
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
        missions: [
          {
            id: "m1",
            status: "in_progress",
            isArchived: false,
            dependsOn: [],
          },
        ],
        total: 1,
      });
      const r = getHabitatStats("h1");
      expect(r.throughput.today).toBe(3);
      expect(r.wipHealth).toBeDefined();
      expect(r.missionSummary.total).toBe(1);
      expect(r.missionSummary.byStatus.in_progress).toBe(1);
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

  describe("maskSecretSettings", () => {
    it("strips githubSecret and gitlabSecret from codeReviewSettings", () => {
      const masked = maskSecretSettings({
        id: "h1",
        name: "H",
        codeReviewSettings: {
          githubSecret: "super-secret",
          gitlabSecret: "another-secret",
          taskPattern: "[TASK]",
          autoApproveOnMerge: true,
        },
        ciCdSettings: null,
      } as any);
      expect(masked.codeReviewSettings).toEqual({
        hasGithubSecret: true,
        hasGitlabSecret: true,
        taskPattern: "[TASK]",
        autoApproveOnMerge: true,
      });
      expect((masked.codeReviewSettings as any).githubSecret).toBeUndefined();
      expect((masked.codeReviewSettings as any).gitlabSecret).toBeUndefined();
    });

    it("strips secrets from ciCdSettings", () => {
      const masked = maskSecretSettings({
        id: "h1",
        name: "H",
        codeReviewSettings: null,
        ciCdSettings: {
          githubSecret: "ci-secret",
          gitlabSecret: null,
          taskPattern: "[CI]",
        },
      } as any);
      expect(masked.ciCdSettings).toEqual({
        hasGithubSecret: true,
        hasGitlabSecret: false,
        taskPattern: "[CI]",
      });
      expect((masked.ciCdSettings as any).githubSecret).toBeUndefined();
    });

    it("preserves null settings as null", () => {
      const masked = maskSecretSettings({
        id: "h1",
        name: "H",
        codeReviewSettings: null,
        ciCdSettings: null,
      } as any);
      expect(masked.codeReviewSettings).toBeNull();
      expect(masked.ciCdSettings).toBeNull();
    });

    it("does not mutate the input habitat", () => {
      const habitat = {
        id: "h1",
        name: "H",
        codeReviewSettings: {
          githubSecret: "kept",
          gitlabSecret: null,
          taskPattern: "",
          autoApproveOnMerge: false,
        },
        ciCdSettings: null,
      } as any;
      maskSecretSettings(habitat);
      expect(habitat.codeReviewSettings.githubSecret).toBe("kept");
    });
  });

  describe("getHabitat (masking)", () => {
    it("returns masked habitat without secrets", () => {
      habitatRepoMocks.getHabitatWithColumnsAndTasks.mockReturnValue({
        habitat: {
          id: "h1",
          name: "H",
          codeReviewSettings: {
            githubSecret: "leaky",
            gitlabSecret: null,
            taskPattern: "",
            autoApproveOnMerge: false,
          },
          ciCdSettings: null,
        },
        columns: [],
        tasks: [],
      });
      const r = getHabitat("h1")!;
      expect((r.habitat.codeReviewSettings as any).githubSecret).toBeUndefined();
      expect((r.habitat.codeReviewSettings as any).gitlabSecret).toBeUndefined();
      expect(r.habitat.codeReviewSettings!.hasGithubSecret).toBe(true);
      expect(r.habitat.codeReviewSettings!.hasGitlabSecret).toBe(false);
    });
  });

  describe("listHabitats (masking)", () => {
    it("masks secrets across the list", () => {
      habitatRepoMocks.listHabitats.mockReturnValue([
        {
          id: "h1",
          codeReviewSettings: {
            githubSecret: "a",
            gitlabSecret: "b",
            taskPattern: "",
            autoApproveOnMerge: false,
          },
          ciCdSettings: null,
        },
      ] as any);
      const r = listHabitats();
      expect((r[0].codeReviewSettings as any).githubSecret).toBeUndefined();
      expect((r[0].codeReviewSettings as any).gitlabSecret).toBeUndefined();
    });
  });

  describe("createHabitat (masking + SSE)", () => {
    it("masks response and SSE payload", () => {
      habitatRepoMocks.createHabitat.mockReturnValue({
        id: "h1",
        name: "H",
        codeReviewSettings: {
          githubSecret: "raw",
          gitlabSecret: null,
          taskPattern: "",
          autoApproveOnMerge: false,
        },
        ciCdSettings: null,
      } as any);

      const r = createHabitat({ name: "H" });
      expect((r.habitat.codeReviewSettings as any).githubSecret).toBeUndefined();
      expect(r.habitat.codeReviewSettings!.hasGithubSecret).toBe(true);

      const ssePayload = sseMock.mock.calls.find((c: any[]) => c[1]?.type === "habitat.created");
      expect(ssePayload).toBeDefined();
      expect(ssePayload![1].data.codeReviewSettings.githubSecret).toBeUndefined();
      expect(cacheMock.rebuildCache).toHaveBeenCalled();
    });
  });

  describe("updateHabitat (masking + SSE)", () => {
    it("masks response and SSE payload and rebuilds cache", () => {
      habitatRepoMocks.updateHabitat.mockReturnValue({
        id: "h1",
        name: "Updated",
        codeReviewSettings: {
          githubSecret: "secret",
          gitlabSecret: null,
          taskPattern: "",
          autoApproveOnMerge: false,
        },
        ciCdSettings: null,
      } as any);

      const r = updateHabitat("h1", { name: "Updated" } as any)!;
      expect((r.codeReviewSettings as any).githubSecret).toBeUndefined();
      expect(r.codeReviewSettings!.hasGithubSecret).toBe(true);

      const ssePayload = sseMock.mock.calls.find((c: any[]) => c[1]?.type === "habitat.updated");
      expect(ssePayload).toBeDefined();
      expect(ssePayload![1].data.codeReviewSettings.githubSecret).toBeUndefined();
      expect(cacheMock.rebuildCache).toHaveBeenCalled();
    });
  });

  describe("setWebhookSecrets", () => {
    it("writes the secret, returns only presence booleans, fires rebuildCache", () => {
      habitatRepoMocks.getHabitatById
        .mockReturnValueOnce({
          id: "h1",
          codeReviewSettings: null,
          ciCdSettings: null,
        } as any)
        .mockReturnValueOnce({
          id: "h1",
          codeReviewSettings: {
            githubSecret: "raw-secret",
            gitlabSecret: null,
            taskPattern: "",
            autoApproveOnMerge: false,
          },
          ciCdSettings: null,
        } as any);
      habitatRepoMocks.updateHabitat.mockReturnValue({} as any);

      const r = setWebhookSecrets("h1", "code_review", { githubSecret: "raw-secret" });
      expect(r).not.toBeNull();
      expect(r!.codeReviewSettings!.hasGithubSecret).toBe(true);
      expect((r!.codeReviewSettings as any).githubSecret).toBeUndefined();

      expect(habitatRepoMocks.updateHabitat).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({
          codeReviewSettings: expect.objectContaining({ githubSecret: "raw-secret" }),
        }),
      );
      expect(cacheMock.rebuildCache).toHaveBeenCalled();
    });

    it("returns null when habitat is not found", () => {
      habitatRepoMocks.getHabitatById.mockReturnValue(null);
      expect(setWebhookSecrets("missing", "code_review", { githubSecret: "x" })).toBeNull();
      expect(cacheMock.rebuildCache).not.toHaveBeenCalled();
    });

    it("null clears a previously configured secret", () => {
      habitatRepoMocks.getHabitatById
        .mockReturnValueOnce({
          id: "h1",
          codeReviewSettings: {
            githubSecret: "old",
            gitlabSecret: "oldlab",
            taskPattern: "[X]",
            autoApproveOnMerge: true,
          },
          ciCdSettings: null,
        } as any)
        .mockReturnValueOnce({
          id: "h1",
          codeReviewSettings: {
            githubSecret: null,
            gitlabSecret: "oldlab",
            taskPattern: "[X]",
            autoApproveOnMerge: true,
          },
          ciCdSettings: null,
        } as any);
      habitatRepoMocks.updateHabitat.mockReturnValue({} as any);

      const r = setWebhookSecrets("h1", "code_review", { githubSecret: null })!;
      expect(r.codeReviewSettings!.hasGithubSecret).toBe(false);
      expect(r.codeReviewSettings!.hasGitlabSecret).toBe(true);

      expect(habitatRepoMocks.updateHabitat).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({
          codeReviewSettings: expect.objectContaining({
            githubSecret: null,
            gitlabSecret: "oldlab",
            taskPattern: "[X]",
            autoApproveOnMerge: true,
          }),
        }),
      );
    });

    it("omitted fields preserve existing secret values", () => {
      habitatRepoMocks.getHabitatById
        .mockReturnValueOnce({
          id: "h1",
          codeReviewSettings: {
            githubSecret: "kept",
            gitlabSecret: "also-kept",
            taskPattern: "[K]",
            autoApproveOnMerge: true,
          },
          ciCdSettings: null,
        } as any)
        .mockReturnValueOnce({
          id: "h1",
          codeReviewSettings: {
            githubSecret: "new",
            gitlabSecret: "also-kept",
            taskPattern: "[K]",
            autoApproveOnMerge: true,
          },
          ciCdSettings: null,
        } as any);
      habitatRepoMocks.updateHabitat.mockReturnValue({} as any);

      setWebhookSecrets("h1", "code_review", { githubSecret: "new" });

      expect(habitatRepoMocks.updateHabitat).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({
          codeReviewSettings: expect.objectContaining({
            githubSecret: "new",
            gitlabSecret: "also-kept",
            taskPattern: "[K]",
            autoApproveOnMerge: true,
          }),
        }),
      );
    });

    it("targets ciCdSettings when provider is ci_cd", () => {
      habitatRepoMocks.getHabitatById
        .mockReturnValueOnce({
          id: "h1",
          codeReviewSettings: null,
          ciCdSettings: null,
        } as any)
        .mockReturnValueOnce({
          id: "h1",
          codeReviewSettings: null,
          ciCdSettings: {
            githubSecret: "ci-secret",
            gitlabSecret: null,
            taskPattern: "[CI]",
          },
        } as any);
      habitatRepoMocks.updateHabitat.mockReturnValue({} as any);

      const r = setWebhookSecrets("h1", "ci_cd", { githubSecret: "ci-secret" })!;
      expect(r.ciCdSettings!.hasGithubSecret).toBe(true);
      expect(habitatRepoMocks.updateHabitat).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({
          ciCdSettings: expect.objectContaining({ githubSecret: "ci-secret" }),
        }),
      );
    });
  });

  describe("importHabitat", () => {
    const validV2Data = {
      version: 2,
      exportedAt: "2025-01-01T00:00:00Z",
      habitat: {
        name: "Test Habitat",
        description: "A test habitat",
        columns: [
          {
            name: "Todo",
            order: 0,
            wipLimit: null,
            autoAdvance: false,
            requiresClaim: false,
            nextColumnName: null,
            isTerminal: false,
          },
        ],
        missions: [
          {
            title: "Mission 1",
            description: "Desc",
            acceptanceCriteria: "AC",
            priority: "medium",
            labels: [],
            columnName: "Todo",
            status: "backlog",
            dependsOn: [],
            blocks: [],
            dueAt: null,
            tasks: [],
          },
        ],
        comments: [],
        templates: [],
        webhooks: [],
      },
    };

    beforeEach(() => {
      habitatRepoMocks.createHabitat.mockReturnValue({
        id: "new-h1",
        name: "Test Habitat",
        codeReviewSettings: null,
        ciCdSettings: null,
      });
      columnRepoMocks.createColumn.mockReturnValue({ id: "col-1", name: "Todo", order: 0 });
      missionRepoMocks.createMission.mockReturnValue({ id: "m1", title: "Mission 1" });
      taskRepoMocks.getTasksByHabitatId.mockReturnValue({ tasks: [], total: 0 });
    });

    it("imports a valid v2 payload into a new habitat", () => {
      const result = importHabitat(validV2Data as any);
      expect(result).not.toBeNull();
      expect(result!.habitat.id).toBe("new-h1");
      expect(result!.imported.missions).toBe(1);
      expect(habitatRepoMocks.deleteHabitat).not.toHaveBeenCalled();
    });

    it("deletes existing habitat before rebuilding for valid merge", () => {
      habitatRepoMocks.getHabitatById.mockReturnValue({ id: "existing-h1", name: "Old" });
      const result = importHabitat(validV2Data as any, "existing-h1");
      expect(result).not.toBeNull();
      expect(habitatRepoMocks.deleteHabitat).toHaveBeenCalledWith("existing-h1");
    });

    it("throws when existing habitat not found", () => {
      habitatRepoMocks.getHabitatById.mockReturnValue(null);
      expect(() => importHabitat(validV2Data as any, "missing-h1")).toThrow(/not found/);
      expect(habitatRepoMocks.deleteHabitat).not.toHaveBeenCalled();
    });

    it("does NOT delete existing habitat when import payload has no missions or tasks", () => {
      habitatRepoMocks.getHabitatById.mockReturnValue({ id: "existing-h1", name: "Old" });
      const emptyData = {
        ...validV2Data,
        habitat: { ...validV2Data.habitat, missions: [], tasks: [] },
      };
      expect(() => importHabitat(emptyData as any, "existing-h1")).toThrow(
        /no importable missions or tasks.*refusing/,
      );
      expect(habitatRepoMocks.deleteHabitat).not.toHaveBeenCalled();
      expect(habitatRepoMocks.createHabitat).not.toHaveBeenCalled();
    });

    it("imports a v1 payload with features array (normalized to missions)", () => {
      const v1Data = {
        version: 1,
        exportedAt: "2024-01-01T00:00:00Z",
        habitat: {
          name: "V1 Habitat",
          description: "Legacy export",
          columns: [
            {
              name: "Todo",
              order: 0,
              wipLimit: null,
              autoAdvance: false,
              requiresClaim: false,
              nextColumnName: null,
              isTerminal: false,
            },
          ],
          features: [
            {
              title: "Feature 1",
              description: "Legacy feature",
              acceptanceCriteria: "",
              priority: "high",
              labels: ["legacy"],
              columnName: "Todo",
              status: "backlog",
              dependsOn: [],
              blocks: [],
              dueAt: null,
              tasks: [],
            },
          ],
          comments: [],
          templates: [],
          webhooks: [],
        },
      };
      const result = importHabitat(v1Data as any);
      expect(result).not.toBeNull();
      expect(result!.imported.missions).toBe(1);
      expect(missionRepoMocks.createMission).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Feature 1", priority: "high", labels: ["legacy"] }),
      );
    });

    it("imports v2 payload with missions taking precedence over features", () => {
      const mixedData = {
        version: 2,
        exportedAt: "2025-01-01T00:00:00Z",
        habitat: {
          name: "Mixed Habitat",
          description: "",
          columns: [
            {
              name: "Todo",
              order: 0,
              wipLimit: null,
              autoAdvance: false,
              requiresClaim: false,
              nextColumnName: null,
              isTerminal: false,
            },
          ],
          missions: [
            {
              title: "Mission A",
              description: "",
              acceptanceCriteria: "",
              priority: "medium",
              labels: [],
              columnName: "Todo",
              status: "backlog",
              dependsOn: [],
              blocks: [],
              dueAt: null,
              tasks: [],
            },
          ],
          features: [
            {
              title: "Feature B",
              description: "",
              acceptanceCriteria: "",
              priority: "low",
              labels: [],
              columnName: "Todo",
              status: "backlog",
              dependsOn: [],
              blocks: [],
              dueAt: null,
              tasks: [],
            },
          ],
          comments: [],
          templates: [],
          webhooks: [],
        },
      };
      const result = importHabitat(mixedData as any);
      expect(result).not.toBeNull();
      expect(result!.imported.missions).toBe(1);
      expect(missionRepoMocks.createMission).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Mission A" }),
      );
    });
  });
});
