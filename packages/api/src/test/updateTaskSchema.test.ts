import { describe, it, expect } from "vitest";
import { updateTaskSchema } from "../models/schemas.js";

describe("updateTaskSchema — PATCH /tasks/:id metadata-only narrowing", () => {
  describe("accepted metadata fields", () => {
    it("accepts priority update", () => {
      const result = updateTaskSchema.safeParse({ priority: "high" });
      expect(result.success).toBe(true);
    });

    it("accepts title update", () => {
      const result = updateTaskSchema.safeParse({ title: "New title" });
      expect(result.success).toBe(true);
    });

    it("accepts multiple metadata fields", () => {
      const result = updateTaskSchema.safeParse({
        title: "Updated",
        description: "New desc",
        priority: "critical",
        requiredDomain: "frontend",
        requiredCapabilities: ["typescript", "react"],
        estimatedMinutes: 120,
        version: 3,
      });
      expect(result.success).toBe(true);
    });

    it("accepts result and artifacts", () => {
      const result = updateTaskSchema.safeParse({
        result: "Done",
        artifacts: [{ type: "commit", url: "https://example.com/abc", description: "fix" }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("rejects lifecycle fields", () => {
    it('rejects status: "claimed"', () => {
      const result = updateTaskSchema.safeParse({ status: "claimed" });
      expect(result.success).toBe(false);
    });

    it('rejects status: "in_progress"', () => {
      const result = updateTaskSchema.safeParse({ status: "in_progress" });
      expect(result.success).toBe(false);
    });

    it('rejects status: "done"', () => {
      const result = updateTaskSchema.safeParse({ status: "done" });
      expect(result.success).toBe(false);
    });

    it("rejects rejectedCount", () => {
      const result = updateTaskSchema.safeParse({ rejectedCount: 5 });
      expect(result.success).toBe(false);
    });

    it("rejects rejectionReason", () => {
      const result = updateTaskSchema.safeParse({ rejectionReason: "bad" });
      expect(result.success).toBe(false);
    });

    it("rejects status mixed with valid metadata", () => {
      const result = updateTaskSchema.safeParse({ title: "Updated", status: "claimed" });
      expect(result.success).toBe(false);
    });
  });
});
