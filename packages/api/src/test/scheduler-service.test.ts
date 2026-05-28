import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ getDb: vi.fn() }));
vi.mock("../db/schema/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/schema/index.js")>();
  return { ...actual };
});
vi.mock("../db/dialect-helpers.js", () => ({ nowExpr: vi.fn(() => ({ _type: "nowExpr" })) }));
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: vi.fn() } }));
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_c, _v) => ({ _type: "eq" })),
    and: vi.fn((..._c) => ({ _type: "and" })),
    or: vi.fn((..._c) => ({ _type: "or" })),
    notInArray: vi.fn((_c, _v) => ({ _type: "notIn" })),
    sql: vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => ({ _type: "sql" })),
  };
});

import { getDb } from "../db/index.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { checkOverdueTasks } from "../services/scheduler.js";

describe("scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkOverdueTasks", () => {
    it("publishes overdue events for new overdue tasks", () => {
      const mockSelect = vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ all: vi.fn(() => [{ id: "task-1", habitatId: "hab-1" }]) })),
          })),
        })),
      }));
      vi.mocked(getDb).mockReturnValue({ select: mockSelect } as any);

      const notified = new Set<string>();
      const onError = vi.fn();
      const published = checkOverdueTasks(notified, onError);

      expect(published).toBe(1);
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "hab-1",
        expect.objectContaining({ type: "task.overdue" }),
      );
      expect(notified.has("task-1")).toBe(true);
    });

    it("does not republish for already notified tasks", () => {
      const mockSelect = vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ all: vi.fn(() => [{ id: "task-1", habitatId: "hab-1" }]) })),
          })),
        })),
      }));
      vi.mocked(getDb).mockReturnValue({ select: mockSelect } as any);

      const notified = new Set(["task-1"]);
      const onError = vi.fn();
      const published = checkOverdueTasks(notified, onError);

      expect(published).toBe(0);
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });

    it("removes resolved tasks from notified set", () => {
      const mockSelect = vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ all: vi.fn(() => [{ id: "task-2", habitatId: "hab-1" }]) })),
          })),
        })),
      }));
      vi.mocked(getDb).mockReturnValue({ select: mockSelect } as any);

      const notified = new Set(["task-1", "task-2"]);
      const onError = vi.fn();
      checkOverdueTasks(notified, onError);

      expect(notified.has("task-1")).toBe(false);
      expect(notified.has("task-2")).toBe(true);
    });

    it("calls onError and returns 0 on DB failure", () => {
      vi.mocked(getDb).mockImplementation(() => {
        throw new Error("DB crash");
      });

      const notified = new Set<string>();
      const onError = vi.fn();
      const published = checkOverdueTasks(notified, onError);

      expect(published).toBe(0);
      expect(onError).toHaveBeenCalled();
    });
  });
});
