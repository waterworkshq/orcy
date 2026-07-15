import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMissionSchema,
  updateMissionSchema,
  missionQuerySchema,
  moveMissionSchema,
  createTaskInMissionSchema,
} from "../models/schemas.js";

describe("Mission Zod Schemas", () => {
  describe("createMissionSchema", () => {
    it("accepts valid minimal input", () => {
      const result = createMissionSchema.safeParse({ title: "My Mission" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("My Mission");
        expect(result.data.description).toBe("");
        expect(result.data.acceptanceCriteria).toBe("");
        expect(result.data.priority).toBe("medium");
        expect(result.data.labels).toEqual([]);
        expect(result.data.dependsOn).toEqual([]);
        expect(result.data.blocks).toEqual([]);
      }
    });

    it("accepts full valid input", () => {
      const input = {
        title: "Full Mission",
        description: "A detailed description",
        acceptanceCriteria: "AC1, AC2",
        priority: "critical",
        labels: ["backend", "api"],
        dependsOn: ["00000000-0000-0000-0000-000000000001"],
        blocks: ["00000000-0000-0000-0000-000000000002"],
        dueAt: "2026-05-01T00:00:00Z",
        slaMinutes: 120,
        columnId: "00000000-0000-0000-0000-000000000003",
      };
      const result = createMissionSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("rejects empty title", () => {
      const result = createMissionSchema.safeParse({ title: "" });
      expect(result.success).toBe(false);
    });

    it("rejects title over 500 chars", () => {
      const result = createMissionSchema.safeParse({ title: "x".repeat(501) });
      expect(result.success).toBe(false);
    });

    it("rejects invalid priority", () => {
      const result = createMissionSchema.safeParse({ title: "Mission", priority: "urgent" });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUID dependsOn", () => {
      const result = createMissionSchema.safeParse({ title: "Mission", dependsOn: ["not-a-uuid"] });
      expect(result.success).toBe(false);
    });

    it("rejects negative slaMinutes", () => {
      const result = createMissionSchema.safeParse({ title: "Mission", slaMinutes: -5 });
      expect(result.success).toBe(false);
    });

    it("rejects non-datetime dueAt", () => {
      const result = createMissionSchema.safeParse({ title: "Mission", dueAt: "not-a-date" });
      expect(result.success).toBe(false);
    });
  });

  describe("updateMissionSchema", () => {
    it("accepts partial update", () => {
      const result = updateMissionSchema.safeParse({ title: "Updated" });
      expect(result.success).toBe(true);
    });

    it("accepts nullable dueAt", () => {
      const result = updateMissionSchema.safeParse({ dueAt: null });
      expect(result.success).toBe(true);
    });

    it("accepts nullable slaMinutes", () => {
      const result = updateMissionSchema.safeParse({ slaMinutes: null });
      expect(result.success).toBe(true);
    });

    it("accepts version for optimistic locking", () => {
      const result = updateMissionSchema.safeParse({ title: "Updated", version: 3 });
      expect(result.success).toBe(true);
    });

    it("rejects empty title", () => {
      const result = updateMissionSchema.safeParse({ title: "" });
      expect(result.success).toBe(false);
    });

    it("rejects description over 10000 chars", () => {
      const result = updateMissionSchema.safeParse({ description: "x".repeat(10001) });
      expect(result.success).toBe(false);
    });
  });

  describe("missionQuerySchema", () => {
    it("applies defaults", () => {
      const result = missionQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it("accepts valid status filter", () => {
      const result = missionQuerySchema.safeParse({ status: "in_progress" });
      expect(result.success).toBe(true);
    });

    it("rejects invalid status", () => {
      const result = missionQuerySchema.safeParse({ status: "unknown" });
      expect(result.success).toBe(false);
    });

    it("coerces string limit to number", () => {
      const result = missionQuerySchema.safeParse({ limit: "50" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
      }
    });

    it("rejects limit over 100", () => {
      const result = missionQuerySchema.safeParse({ limit: 200 });
      expect(result.success).toBe(false);
    });
  });

  describe("moveMissionSchema", () => {
    it("accepts valid columnId and expectedVersion", () => {
      const result = moveMissionSchema.safeParse({
        columnId: "00000000-0000-0000-0000-000000000001",
        expectedVersion: 3,
      });
      expect(result.success).toBe(true);
    });

    it("rejects non-UUID columnId", () => {
      const result = moveMissionSchema.safeParse({
        columnId: "not-a-uuid",
        expectedVersion: 3,
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing columnId", () => {
      const result = moveMissionSchema.safeParse({ expectedVersion: 3 });
      expect(result.success).toBe(false);
    });

    it("rejects missing expectedVersion", () => {
      const result = moveMissionSchema.safeParse({
        columnId: "00000000-0000-0000-0000-000000000001",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-positive expectedVersion", () => {
      const result = moveMissionSchema.safeParse({
        columnId: "00000000-0000-0000-0000-000000000001",
        expectedVersion: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createTaskInMissionSchema", () => {
    it("accepts valid minimal input", () => {
      const result = createTaskInMissionSchema.safeParse({ title: "My Task" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("My Task");
        expect(result.data.description).toBe("");
        expect(result.data.priority).toBe("medium");
        expect(result.data.requiredCapabilities).toEqual([]);
        expect(result.data.dependsOn).toEqual([]);
        expect(result.data.order).toBe(0);
      }
    });

    it("accepts full input", () => {
      const input = {
        title: "Task with details",
        description: "A description",
        priority: "high",
        requiredDomain: "backend",
        requiredCapabilities: ["typescript", "node"],
        estimatedMinutes: 120,
        dependsOn: ["00000000-0000-0000-0000-000000000001"],
        order: 5,
      };
      const result = createTaskInMissionSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("rejects empty title", () => {
      const result = createTaskInMissionSchema.safeParse({ title: "" });
      expect(result.success).toBe(false);
    });

    it("rejects title over 500 chars", () => {
      const result = createTaskInMissionSchema.safeParse({ title: "x".repeat(501) });
      expect(result.success).toBe(false);
    });

    it("rejects invalid priority", () => {
      const result = createTaskInMissionSchema.safeParse({ title: "Task", priority: "urgent" });
      expect(result.success).toBe(false);
    });

    it("rejects negative estimatedMinutes", () => {
      const result = createTaskInMissionSchema.safeParse({ title: "Task", estimatedMinutes: -10 });
      expect(result.success).toBe(false);
    });
  });
});
