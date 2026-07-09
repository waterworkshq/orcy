import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../repositories/pluginEnrollment.js", () => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  listByHabitat: vi.fn(),
  deleteEnrollment: vi.fn(),
}));

vi.mock("../repositories/pluginRun.js", () => ({
  listByHabitat: vi.fn(),
}));

vi.mock("../plugins/pluginManager.js", async (importOriginal) => {
  // v0.28-T5: spread the real module so the exported `CATALOG` (built with the
  // real registries at pluginManager module init) is available to
  // `findContribution`, which delegates id extraction to it. Mock only the two
  // methods the enrollment service actually invokes; keep `CATALOG` real so
  // the test exercises the same single-instance catalog that production uses
  // (no parallel stub catalog).
  const actual = await importOriginal<typeof import("../plugins/pluginManager.js")>();
  return {
    ...actual,
    getPluginManifest: vi.fn(),
    invalidateEnrollmentCache: vi.fn(),
  };
});

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

import * as service from "../services/pluginEnrollmentService.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { AppError } from "../errors.js";
import { z } from "zod";

const detectorManifest = {
  id: "ref-detector",
  version: "1.0.0",
  description: "Reference detector plugin",
  contributions: [
    {
      kind: "signalDetector" as const,
      scope: "habitat" as const,
      detectorId: "ref-detector-1",
      label: "Reference detector",
      detects: "pulseCreated" as const,
      rateLimitDefaults: { maxDetectionsPerMinute: 10, maxSignalsPerHour: 100 },
      requires: [],
    },
  ],
};

const detectorWithSchema = {
  ...detectorManifest,
  id: "schema-detector",
  contributions: [
    {
      kind: "signalDetector" as const,
      scope: "habitat" as const,
      detectorId: "schema-detector-1",
      label: "Schema detector",
      detects: "pulseCreated" as const,
      rateLimitDefaults: { maxDetectionsPerMinute: 10, maxSignalsPerHour: 100 },
      configSchema: z.object({ threshold: z.number().int().positive() }),
      requires: [],
    },
  ],
};

const interceptorManifest = {
  id: "ref-interceptor",
  version: "1.0.0",
  description: "Reference interceptor plugin",
  contributions: [
    {
      kind: "lifecycleInterceptor" as const,
      scope: "habitat" as const,
      interceptorId: "ref-interceptor-1",
      phase: "pre" as const,
      event: "taskSubmitted" as const,
      priority: 100,
      requires: [],
    },
  ],
};

const systemScopedManifest = {
  id: "ref-channel",
  version: "1.0.0",
  description: "System-scoped channel plugin",
  contributions: [
    {
      kind: "notificationChannel" as const,
      scope: "system" as const,
      channelId: "ref-channel-1",
      label: "Reference channel",
      requires: [],
    },
  ],
};

// v0.28-T5: webhookFormatter was one of 4 kinds missing from the old
// id-extraction switch, so enroll-by-formatId used to fall through to
// "not found" instead of the cleaner "cannot enroll system-scoped" error.
// After folding `findContribution` to `CATALOG[c.kind].label(c)`, all 9 kinds
// resolve and the scope check at createEnrollment catches them.
const systemScopedFormatterManifest = {
  id: "ref-formatter",
  version: "1.0.0",
  description: "System-scoped webhook formatter plugin",
  contributions: [
    {
      kind: "webhookFormatter" as const,
      scope: "system" as const,
      formatId: "ref-formatter-1",
      label: "Reference formatter",
      requires: [],
    },
  ],
};

function makeEnrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "enr-1",
    habitatId: "hab-1",
    pluginId: "ref-detector",
    contributionId: "ref-detector-1",
    contributionKind: "signalDetector",
    enabled: 0,
    config: null,
    enrolledBy: "user-1",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    disabledAt: null,
    ...overrides,
  } as any;
}

describe("pluginEnrollmentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.ORCY_DETECTOR_ALLOWLIST;
  });

  afterEach(() => {
    delete process.env.ORCY_DETECTOR_ALLOWLIST;
  });

  describe("createEnrollment", () => {
    it("creates a detector enrollment when allowlist permits", () => {
      process.env.ORCY_DETECTOR_ALLOWLIST = "ref-detector";
      (pluginManager.getPluginManifest as any).mockReturnValue(detectorManifest);
      (enrollmentRepo.create as any).mockReturnValue(
        makeEnrollmentRow({ enabled: 0, enrolledBy: "user-1" }),
      );

      const row = service.createEnrollment(
        "hab-1",
        { pluginId: "ref-detector", contributionId: "ref-detector-1" },
        "user-1",
      );

      expect(enrollmentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          habitatId: "hab-1",
          pluginId: "ref-detector",
          contributionId: "ref-detector-1",
          contributionKind: "signalDetector",
          enabled: 0,
          enrolledBy: "user-1",
        }),
      );
      expect(pluginManager.invalidateEnrollmentCache).toHaveBeenCalledWith("hab-1");
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
      expect(row.id).toBe("enr-1");
    });

    it("creates an interceptor enrollment without allowlist gate", () => {
      (pluginManager.getPluginManifest as any).mockReturnValue(interceptorManifest);
      (enrollmentRepo.create as any).mockReturnValue(
        makeEnrollmentRow({
          pluginId: "ref-interceptor",
          contributionId: "ref-interceptor-1",
          contributionKind: "lifecycleInterceptor",
        }),
      );

      const row = service.createEnrollment(
        "hab-1",
        { pluginId: "ref-interceptor", contributionId: "ref-interceptor-1" },
        "user-1",
      );

      expect(row.id).toBe("enr-1");
      // Interceptors are NOT subject to ORCY_DETECTOR_ALLOWLIST — no env set, still succeeds.
      expect(enrollmentRepo.create).toHaveBeenCalled();
    });

    it("rejects detector enrollment with 403 when plugin not in allowlist", () => {
      process.env.ORCY_DETECTOR_ALLOWLIST = "other-plugin";
      (pluginManager.getPluginManifest as any).mockReturnValue(detectorManifest);

      expect(() =>
        service.createEnrollment(
          "hab-1",
          { pluginId: "ref-detector", contributionId: "ref-detector-1" },
          "user-1",
        ),
      ).toThrow(AppError);

      try {
        service.createEnrollment(
          "hab-1",
          { pluginId: "ref-detector", contributionId: "ref-detector-1" },
          "user-1",
        );
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(403);
        expect((err as AppError).message).toContain("ORCY_DETECTOR_ALLOWLIST");
      }
    });

    it("allows all detectors when ORCY_DETECTOR_ALLOWLIST=*", () => {
      process.env.ORCY_DETECTOR_ALLOWLIST = "*";
      (pluginManager.getPluginManifest as any).mockReturnValue(detectorManifest);
      (enrollmentRepo.create as any).mockReturnValue(makeEnrollmentRow());

      const row = service.createEnrollment(
        "hab-1",
        { pluginId: "ref-detector", contributionId: "ref-detector-1" },
        "user-1",
      );
      expect(row.id).toBe("enr-1");
    });

    it("rejects detector enrollment with 403 when allowlist unset (fail-closed)", () => {
      delete process.env.ORCY_DETECTOR_ALLOWLIST;
      (pluginManager.getPluginManifest as any).mockReturnValue(detectorManifest);

      try {
        service.createEnrollment(
          "hab-1",
          { pluginId: "ref-detector", contributionId: "ref-detector-1" },
          "user-1",
        );
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(403);
      }
    });

    it("rejects system-scoped contribution enrollment with 400", () => {
      (pluginManager.getPluginManifest as any).mockReturnValue(systemScopedManifest);

      try {
        service.createEnrollment(
          "hab-1",
          { pluginId: "ref-channel", contributionId: "ref-channel-1" },
          "user-1",
        );
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toContain("system-scoped");
      }
    });

    // v0.28-T5: pins the bug fix for the 4 previously-missing kinds. Before
    // the catalog fold, `findContribution` only handled 5 kinds — enrolling a
    // webhookFormatter by id returned "not found" instead of the cleaner
    // "Cannot enroll system-scoped contributions". After folding, all 9 kinds
    // resolve via `CATALOG[c.kind].label(c)` and the scope check fires.
    it("resolves webhookFormatter by id and hits the scope error (T5 bug fix)", () => {
      (pluginManager.getPluginManifest as any).mockReturnValue(
        systemScopedFormatterManifest,
      );

      try {
        service.createEnrollment(
          "hab-1",
          { pluginId: "ref-formatter", contributionId: "ref-formatter-1" },
          "user-1",
        );
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(400);
        // Specifically the scope error — not the generic "not found".
        expect((err as AppError).message).toBe("Cannot enroll system-scoped contributions");
      }
    });

    it("rejects invalid config with 400 (Zod schema violation)", () => {
      process.env.ORCY_DETECTOR_ALLOWLIST = "*";
      (pluginManager.getPluginManifest as any).mockReturnValue(detectorWithSchema);

      try {
        service.createEnrollment(
          "hab-1",
          {
            pluginId: "schema-detector",
            contributionId: "schema-detector-1",
            config: { threshold: -5 },
          },
          "user-1",
        );
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).toContain("Config validation failed");
      }
    });

    it("accepts valid config against a contribution's schema", () => {
      process.env.ORCY_DETECTOR_ALLOWLIST = "*";
      (pluginManager.getPluginManifest as any).mockReturnValue(detectorWithSchema);
      (enrollmentRepo.create as any).mockReturnValue(makeEnrollmentRow());

      service.createEnrollment(
        "hab-1",
        {
          pluginId: "schema-detector",
          contributionId: "schema-detector-1",
          config: { threshold: 7 },
        },
        "user-1",
      );
      expect(enrollmentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ config: { threshold: 7 } }),
      );
    });

    it("returns 400 when contribution id is unknown", () => {
      (pluginManager.getPluginManifest as any).mockReturnValue(detectorManifest);

      try {
        service.createEnrollment(
          "hab-1",
          { pluginId: "ref-detector", contributionId: "does-not-exist" },
          "user-1",
        );
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(400);
      }
    });
  });

  describe("updateEnrollment", () => {
    it("toggles enabled and fires plugin.enrollment_toggled SSE", () => {
      (enrollmentRepo.getById as any).mockReturnValue(
        makeEnrollmentRow({ enabled: 0, habitatId: "hab-1" }),
      );
      (enrollmentRepo.update as any).mockReturnValue(
        makeEnrollmentRow({ enabled: 1, habitatId: "hab-1" }),
      );

      const row = service.updateEnrollment("hab-1", "enr-1", { enabled: true });

      expect(enrollmentRepo.update).toHaveBeenCalledWith("enr-1", { enabled: 1 });
      expect(pluginManager.invalidateEnrollmentCache).toHaveBeenCalledWith("hab-1");
      expect(sseBroadcaster.publish).toHaveBeenCalledWith("hab-1", {
        type: "plugin.enrollment_toggled",
        data: {
          habitatId: "hab-1",
          enrollmentId: "enr-1",
          pluginId: "ref-detector",
          enabled: true,
        },
      });
      expect(row.enabled).toBe(1);
    });

    it("returns 404 when enrollment does not exist", () => {
      (enrollmentRepo.getById as any).mockReturnValue(null);

      try {
        service.updateEnrollment("hab-1", "missing", { enabled: true });
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(404);
      }
    });

    it("returns 404 when enrollment belongs to a different habitat", () => {
      (enrollmentRepo.getById as any).mockReturnValue(
        makeEnrollmentRow({ habitatId: "other-hab" }),
      );

      try {
        service.updateEnrollment("hab-1", "enr-1", { enabled: true });
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(404);
      }
    });

    it("does not emit SSE when only config is updated", () => {
      (pluginManager.getPluginManifest as any).mockReturnValue(detectorManifest);
      (enrollmentRepo.getById as any).mockReturnValue(makeEnrollmentRow({ habitatId: "hab-1" }));
      (enrollmentRepo.update as any).mockReturnValue(makeEnrollmentRow());

      service.updateEnrollment("hab-1", "enr-1", { config: { x: 1 } });
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });
  });

  describe("listEnrollments", () => {
    it("lists enrollments for a habitat", () => {
      (enrollmentRepo.listByHabitat as any).mockReturnValue([makeEnrollmentRow()]);

      const rows = service.listEnrollments("hab-1");
      expect(enrollmentRepo.listByHabitat).toHaveBeenCalledWith("hab-1");
      expect(rows).toHaveLength(1);
    });
  });

  describe("listPluginRuns", () => {
    it("forwards filter to repository", () => {
      (runRepo.listByHabitat as any).mockReturnValue([]);

      service.listPluginRuns("hab-1", { pluginId: "ref-detector", status: "succeeded" });
      expect(runRepo.listByHabitat).toHaveBeenCalledWith("hab-1", {
        pluginId: "ref-detector",
        status: "succeeded",
      });
    });
  });

  describe("deleteEnrollment", () => {
    it("deletes and fires plugin.enrollment_removed SSE", () => {
      (enrollmentRepo.getById as any).mockReturnValue(makeEnrollmentRow({ habitatId: "hab-1" }));
      (enrollmentRepo.deleteEnrollment as any).mockReturnValue(true);

      const result = service.deleteEnrollment("hab-1", "enr-1");

      expect(result).toBe(true);
      expect(pluginManager.invalidateEnrollmentCache).toHaveBeenCalledWith("hab-1");
      expect(sseBroadcaster.publish).toHaveBeenCalledWith("hab-1", {
        type: "plugin.enrollment_removed",
        data: { habitatId: "hab-1", enrollmentId: "enr-1", pluginId: "ref-detector" },
      });
    });

    it("returns 404 when enrollment does not exist", () => {
      (enrollmentRepo.getById as any).mockReturnValue(null);

      try {
        service.deleteEnrollment("hab-1", "missing");
        fail("expected throw");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(404);
      }
    });
  });
});

describe("pluginRoutes", () => {
  it("registers 7 routes with agentOrHumanAuth + requireHabitatAccess prehandlers", async () => {
    const { pluginRoutes } = await import("../routes/plugins.js");
    const { agentOrHumanAuth } = await import("../middleware/auth.js");

    const routes: Array<{ method: string; path: string; preHandler: any[] }> = [];
    const fakeFastify: any = {
      post: vi.fn((path: string, opts: any) =>
        routes.push({ method: "POST", path, preHandler: opts?.preHandler ?? [] }),
      ),
      patch: vi.fn((path: string, opts: any) =>
        routes.push({ method: "PATCH", path, preHandler: opts?.preHandler ?? [] }),
      ),
      get: vi.fn((path: string, opts: any) =>
        routes.push({ method: "GET", path, preHandler: opts?.preHandler ?? [] }),
      ),
      delete: vi.fn((path: string, opts: any) =>
        routes.push({ method: "DELETE", path, preHandler: opts?.preHandler ?? [] }),
      ),
    };

    await pluginRoutes(fakeFastify);

    expect(routes).toHaveLength(7);
    for (const r of routes) {
      expect(r.preHandler[0]).toBe(agentOrHumanAuth);
      if (r.path === "/plugins") {
        // Global catalog route: auth only, no habitat scope
        expect(r.preHandler).toHaveLength(1);
      } else {
        // Habitat-scoped routes: agentOrHumanAuth + requireHabitatAccess
        expect(r.preHandler).toHaveLength(2);
        expect(typeof r.preHandler[1]).toBe("function");
      }
    }

    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("POST /habitats/:habitatId/plugins/enrollments");
    expect(paths).toContain("PATCH /habitats/:habitatId/plugins/enrollments/:id");
    expect(paths).toContain("GET /habitats/:habitatId/plugins/enrollments");
    expect(paths).toContain("DELETE /habitats/:habitatId/plugins/enrollments/:id");
    expect(paths).toContain("GET /habitats/:habitatId/plugins/runs");
  });
});

function fail(msg: string): never {
  throw new Error(msg);
}
