import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as runRepo from "../repositories/pluginRun.js";
import type { PluginRunStatus } from "../repositories/pluginRun.js";
import { pluginEnrollments, pluginRuns } from "../db/schema/index.js";

function setupHabitat() {
  return habitatRepo.createHabitat({ name: "Plugin Habitat" });
}

function makeEnrollmentInput(
  habitatId: string,
  overrides: Partial<Parameters<typeof enrollmentRepo.create>[0]> = {},
) {
  return {
    habitatId,
    pluginId: overrides.pluginId ?? "detector-regex-frustration",
    contributionId: overrides.contributionId ?? "frustration-detector",
    contributionKind: overrides.contributionKind ?? "signalDetector",
    enabled: overrides.enabled ?? 1,
    config: overrides.config ?? { threshold: 0.7 },
    enrolledBy: overrides.enrolledBy ?? "human-1",
  };
}

function makeRunInput(
  habitatId: string,
  overrides: Partial<Parameters<typeof runRepo.startRun>[0]> = {},
) {
  return {
    habitatId,
    pluginId: overrides.pluginId ?? "detector-regex-frustration",
    contributionId: overrides.contributionId ?? "frustration-detector",
    contributionKind: overrides.contributionKind ?? "signalDetector",
    triggerEventId: overrides.triggerEventId ?? "pulse-1",
    triggerType: overrides.triggerType ?? "pulseCreated",
  };
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

describe("pluginEnrollment repo", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(pluginEnrollments).run();
    db.delete(pluginRuns).run();
  });

  describe("table migration (T-P2-6)", () => {
    it("plugin_enrollments table exists and accepts inserts", () => {
      const { id } = setupHabitat();
      const created = enrollmentRepo.create(makeEnrollmentInput(id));
      expect(created.id).toBeTruthy();
      expect(created.habitatId).toBe(id);
    });

    it("plugin_runs table exists and accepts inserts", () => {
      const { id } = setupHabitat();
      const run = runRepo.startRun(makeRunInput(id));
      expect(run.id).toBeTruthy();
      expect(run.habitatId).toBe(id);
    });
  });

  describe("create + getById", () => {
    it("inserts with defaults (enabled=0 when omitted, uuid generated)", () => {
      const { id } = setupHabitat();
      const created = enrollmentRepo.create({
        habitatId: id,
        pluginId: "p1",
        contributionId: "c1",
        contributionKind: "signalDetector",
        enrolledBy: "human-1",
      });
      expect(created.enabled).toBe(0);
      expect(created.enrolledAt).toBeTruthy();
      expect(created.disabledAt).toBeNull();

      const fetched = enrollmentRepo.getById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.pluginId).toBe("p1");
    });

    it("getById returns null for unknown id", () => {
      expect(enrollmentRepo.getById("does-not-exist")).toBeNull();
    });

    it("persists JSON config", () => {
      const { id } = setupHabitat();
      const created = enrollmentRepo.create(
        makeEnrollmentInput(id, { config: { rules: ["a", "b"], threshold: 0.9 } }),
      );
      expect(created.config).toEqual({ rules: ["a", "b"], threshold: 0.9 });
    });
  });

  describe("update (toggle enabled)", () => {
    it("toggles enabled 1 → 0 and stamps disabledAt", () => {
      const { id } = setupHabitat();
      const created = enrollmentRepo.create(makeEnrollmentInput(id, { enabled: 1 }));
      expect(created.disabledAt).toBeNull();

      const updated = enrollmentRepo.update(created.id, { enabled: 0 });
      expect(updated).not.toBeNull();
      expect(updated!.enabled).toBe(0);
      expect(updated!.disabledAt).not.toBeNull();
    });

    it("re-enabling clears disabledAt", () => {
      const { id } = setupHabitat();
      const created = enrollmentRepo.create(makeEnrollmentInput(id, { enabled: 1 }));
      enrollmentRepo.update(created.id, { enabled: 0 });
      const reEnabled = enrollmentRepo.update(created.id, { enabled: 1 });
      expect(reEnabled!.enabled).toBe(1);
      expect(reEnabled!.disabledAt).toBeNull();
    });

    it("update returns null for unknown id", () => {
      expect(enrollmentRepo.update("missing", { enabled: 1 })).toBeNull();
    });

    it("patches config without touching enabled", () => {
      const { id } = setupHabitat();
      const created = enrollmentRepo.create(makeEnrollmentInput(id, { enabled: 1 }));
      const updated = enrollmentRepo.update(created.id, { config: { new: true } });
      expect(updated!.config).toEqual({ new: true });
      expect(updated!.enabled).toBe(1);
    });
  });

  describe("listEnabledByHabitat", () => {
    it("returns only enabled=1 enrollments for the habitat", () => {
      const { id } = setupHabitat();
      enrollmentRepo.create(makeEnrollmentInput(id, { contributionId: "c1", enabled: 1 }));
      enrollmentRepo.create(makeEnrollmentInput(id, { contributionId: "c2", enabled: 0 }));
      enrollmentRepo.create(makeEnrollmentInput(id, { contributionId: "c3", enabled: 1 }));

      const enabled = enrollmentRepo.listEnabledByHabitat(id);
      expect(enabled).toHaveLength(2);
      expect(enabled.map((e) => e.contributionId).sort()).toEqual(["c1", "c3"]);
    });

    it("does not leak enrollments from other habitats", () => {
      const a = setupHabitat();
      const b = setupHabitat();
      enrollmentRepo.create(makeEnrollmentInput(a.id, { enabled: 1 }));
      enrollmentRepo.create(makeEnrollmentInput(b.id, { enabled: 1 }));
      expect(enrollmentRepo.listEnabledByHabitat(a.id)).toHaveLength(1);
    });
  });

  describe("listByHabitat", () => {
    it("returns all enrollments regardless of enabled state", () => {
      const { id } = setupHabitat();
      enrollmentRepo.create(makeEnrollmentInput(id, { contributionId: "c1", enabled: 1 }));
      enrollmentRepo.create(makeEnrollmentInput(id, { contributionId: "c2", enabled: 0 }));
      expect(enrollmentRepo.listByHabitat(id)).toHaveLength(2);
    });
  });

  describe("listByPlugin", () => {
    it("returns enrollments across habitats for one plugin id", () => {
      const a = setupHabitat();
      const b = setupHabitat();
      enrollmentRepo.create(
        makeEnrollmentInput(a.id, { pluginId: "shared-plugin", contributionId: "c1" }),
      );
      enrollmentRepo.create(
        makeEnrollmentInput(b.id, { pluginId: "shared-plugin", contributionId: "c2" }),
      );
      enrollmentRepo.create(
        makeEnrollmentInput(a.id, { pluginId: "other-plugin", contributionId: "c3" }),
      );

      const rows = enrollmentRepo.listByPlugin("shared-plugin");
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.pluginId === "shared-plugin")).toBe(true);
    });
  });

  describe("deleteEnrollment", () => {
    it("removes a row and returns true", () => {
      const { id } = setupHabitat();
      const created = enrollmentRepo.create(makeEnrollmentInput(id));
      expect(enrollmentRepo.deleteEnrollment(created.id)).toBe(true);
      expect(enrollmentRepo.getById(created.id)).toBeNull();
    });

    it("returns false for unknown id", () => {
      expect(enrollmentRepo.deleteEnrollment("missing")).toBe(false);
    });
  });
});

describe("pluginRun repo", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(pluginEnrollments).run();
    db.delete(pluginRuns).run();
  });

  describe("startRun", () => {
    it("inserts with status running and computes fingerprint", () => {
      const { id } = setupHabitat();
      const run = runRepo.startRun(makeRunInput(id));
      expect(run.status).toBe("running");
      expect(run.fingerprint).toContain(id);
      expect(run.fingerprint).toContain("pulseCreated");
      expect(run.startedAt).toBeTruthy();
      expect(run.finishedAt).toBeNull();
      expect(run.signalsEmitted).toBeNull();
    });
  });

  describe("finishRun", () => {
    it("transitions to succeeded with signal count", () => {
      const { id } = setupHabitat();
      const run = runRepo.startRun(makeRunInput(id));
      const finished = runRepo.finishRun(run.id, "succeeded", 3);
      expect(finished).not.toBeNull();
      expect(finished!.status).toBe("succeeded");
      expect(finished!.signalsEmitted).toBe(3);
      expect(finished!.finishedAt).not.toBeNull();
    });

    it("transitions to failed with error message", () => {
      const { id } = setupHabitat();
      const run = runRepo.startRun(makeRunInput(id));
      const finished = runRepo.finishRun(run.id, "failed", undefined, "boom");
      expect(finished!.status).toBe("failed");
      expect(finished!.error).toBe("boom");
      expect(finished!.signalsEmitted).toBeNull();
    });

    it("returns null for unknown id", () => {
      expect(runRepo.finishRun("missing", "succeeded", 0)).toBeNull();
    });

    it("accepts every PluginRunStatus value (ADR-0039 finishRun narrowing)", () => {
      const validStatuses: PluginRunStatus[] = [
        "running",
        "succeeded",
        "failed",
        "rate_limited",
        "skipped",
      ];
      const { id } = setupHabitat();
      for (const status of validStatuses) {
        const run = runRepo.startRun(makeRunInput(id, { contributionId: `c-${status}` }));
        const finished = runRepo.finishRun(run.id, status);
        expect(finished!.status).toBe(status);
      }
    });

    // MAJOR 5: active compile-time narrowing assertion — invalid status rejected
    // by TypeScript. This function is never called at runtime; it exists solely
    // for the @ts-expect-error directive, verified by `tsc --noEmit`.
    function _compileTimeNarrowingCheck(): void {
      // @ts-expect-error — "pending" is not a valid PluginRunStatus
      runRepo.finishRun("x", "pending");
    }
    void _compileTimeNarrowingCheck;
  });

  describe("listByHabitat", () => {
    it("returns runs newest-first", () => {
      const { id } = setupHabitat();
      const r1 = runRepo.startRun({ ...makeRunInput(id), startedAt: "2026-01-01T00:00:00.000Z" });
      const r2 = runRepo.startRun({ ...makeRunInput(id), startedAt: "2026-02-01T00:00:00.000Z" });
      const r3 = runRepo.startRun({ ...makeRunInput(id), startedAt: "2026-03-01T00:00:00.000Z" });

      const rows = runRepo.listByHabitat(id);
      expect(rows.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    });

    it("filters by pluginId", () => {
      const { id } = setupHabitat();
      runRepo.startRun(makeRunInput(id, { pluginId: "p-a", contributionId: "c1" }));
      runRepo.startRun(makeRunInput(id, { pluginId: "p-b", contributionId: "c2" }));

      expect(runRepo.listByHabitat(id, { pluginId: "p-a" })).toHaveLength(1);
    });

    it("filters by status", () => {
      const { id } = setupHabitat();
      const r1 = runRepo.startRun(makeRunInput(id, { contributionId: "c1" }));
      runRepo.startRun(makeRunInput(id, { contributionId: "c2" }));
      runRepo.finishRun(r1.id, "succeeded", 1);

      const succeeded = runRepo.listByHabitat(id, { status: "succeeded" });
      expect(succeeded).toHaveLength(1);
      expect(succeeded[0].id).toBe(r1.id);
    });

    it("filters by since (inclusive)", () => {
      const { id } = setupHabitat();
      runRepo.startRun({
        ...makeRunInput(id),
        startedAt: "2026-01-01T00:00:00.000Z",
        contributionId: "c1",
      });
      runRepo.startRun({
        ...makeRunInput(id),
        startedAt: "2026-06-01T00:00:00.000Z",
        contributionId: "c2",
      });

      const since = runRepo.listByHabitat(id, { since: "2026-03-01T00:00:00.000Z" });
      expect(since).toHaveLength(1);
      expect(since[0].contributionId).toBe("c2");
    });

    it("respects limit", () => {
      const { id } = setupHabitat();
      for (let i = 0; i < 5; i++) {
        runRepo.startRun(makeRunInput(id, { contributionId: `c${i}`, triggerEventId: `p${i}` }));
      }
      expect(runRepo.listByHabitat(id, { limit: 2 })).toHaveLength(2);
    });

    it("does not leak runs from other habitats", () => {
      const a = setupHabitat();
      const b = setupHabitat();
      runRepo.startRun(makeRunInput(a.id));
      runRepo.startRun(makeRunInput(b.id));
      expect(runRepo.listByHabitat(a.id)).toHaveLength(1);
    });
  });
});
