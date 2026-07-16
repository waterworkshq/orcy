import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/llm.js", () => ({
  getLLMConfig: vi.fn(),
  callLLM: vi.fn(),
}));
vi.mock("../repositories/task.js", () => ({ getTaskById: vi.fn() }));
vi.mock("../repositories/mission.js", () => ({ getMissionById: vi.fn() }));
vi.mock("../errors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../errors.js")>();
  return { ...actual };
});

import { decomposeMission, decomposeTask } from "../services/decompositionService.js";
import { getLLMConfig, callLLM } from "../lib/llm.js";
import { getMissionById } from "../repositories/mission.js";
import { getTaskById } from "../repositories/task.js";

describe("decompositionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("decomposeMission", () => {
    it("throws when LLM not configured", async () => {
      vi.mocked(getLLMConfig).mockReturnValue(null);
      await expect(decomposeMission("m1")).rejects.toThrow("AI decomposition not configured");
    });

    it("throws when mission not found", async () => {
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getMissionById).mockReturnValue(null);
      await expect(decomposeMission("m1")).rejects.toThrow("Mission not found");
    });

    it("throws when mission has no description", async () => {
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getMissionById).mockReturnValue({ id: "m1", title: "M", description: "  " } as any);
      await expect(decomposeMission("m1")).rejects.toThrow("Add a description");
    });

    it("returns proposals from LLM response", async () => {
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getMissionById).mockReturnValue({
        id: "m1",
        title: "Build API",
        description: "Create REST API",
        acceptanceCriteria: "",
      } as any);
      vi.mocked(callLLM).mockResolvedValue({
        content: JSON.stringify({
          tasks: [{ title: "Setup project", priority: "medium", estimatedMinutes: 60 }],
        }),
      } as any);

      const result = await decomposeMission("m1");

      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].title).toBe("Setup project");
      expect(result.parentMission.id).toBe("m1");
    });

    it("throws on invalid JSON", async () => {
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getMissionById).mockReturnValue({
        id: "m1",
        title: "M",
        description: "desc",
      } as any);
      vi.mocked(callLLM).mockResolvedValue({ content: "not json" } as any);

      await expect(decomposeMission("m1")).rejects.toThrow("Could not understand AI response");
    });

    it("throws on empty task list", async () => {
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getMissionById).mockReturnValue({
        id: "m1",
        title: "M",
        description: "desc",
      } as any);
      vi.mocked(callLLM).mockResolvedValue({ content: JSON.stringify({ tasks: [] }) } as any);

      await expect(decomposeMission("m1")).rejects.toThrow("AI did not return any tasks");
    });

    it("truncates proposals to 20", async () => {
      const tasks = Array.from({ length: 25 }, (_, i) => ({
        title: `Task ${i}`,
        priority: "medium",
        estimatedMinutes: 30,
      }));
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getMissionById).mockReturnValue({
        id: "m1",
        title: "M",
        description: "desc",
      } as any);
      vi.mocked(callLLM).mockResolvedValue({ content: JSON.stringify({ tasks }) } as any);

      const result = await decomposeMission("m1");

      expect(result.proposals).toHaveLength(20);
    });

    it("uses acceptance criteria in prompt", async () => {
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getMissionById).mockReturnValue({
        id: "m1",
        title: "M",
        description: "desc",
        acceptanceCriteria: "Must pass",
      } as any);
      vi.mocked(callLLM).mockResolvedValue({
        content: JSON.stringify({ tasks: [{ title: "T", priority: "low", estimatedMinutes: 15 }] }),
      } as any);

      const result = await decomposeMission("m1");

      expect(result.proposals).toHaveLength(1);
    });
  });

  describe("decomposeTask", () => {
    it("throws when LLM not configured", async () => {
      vi.mocked(getLLMConfig).mockReturnValue(null);
      await expect(decomposeTask("t1")).rejects.toThrow("AI decomposition not configured");
    });

    it("throws when task not found", async () => {
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getTaskById).mockReturnValue(null);
      await expect(decomposeTask("t1")).rejects.toThrow("Task not found");
    });

    it("throws when task has no description", async () => {
      vi.mocked(getLLMConfig).mockReturnValue({ apiKey: "k" } as any);
      vi.mocked(getTaskById).mockReturnValue({
        id: "t1",
        title: "T",
        description: "",
        missionId: "m1",
      } as any);
      await expect(decomposeTask("t1")).rejects.toThrow("Add a description");
    });
  });
});
