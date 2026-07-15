import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import * as habitatRepo from "../repositories/board.js";
import * as runRepo from "../repositories/pluginRun.js";
import {
  scanStalePluginRuns,
  type StalePluginRun,
} from "../services/pluginEnrollmentService.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(): string {
  return jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

function makeRunInput(
  habitatId: string,
  overrides: Partial<Parameters<typeof runRepo.startRun>[0]> = {},
) {
  return {
    habitatId,
    pluginId: overrides.pluginId ?? "stale-run-plugin",
    contributionId: overrides.contributionId ?? "stale-detector",
    contributionKind: overrides.contributionKind ?? "signalDetector",
    triggerEventId: overrides.triggerEventId ?? "pulse-1",
    triggerType: overrides.triggerType ?? "pulseCreated",
    startedAt: overrides.startedAt,
  };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(pluginRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

describe("stale plugin run operational surfacing", () => {
  it("requires auth and returns only the habitat's stale runs", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Stale Run Habitat" });
      const otherHabitat = habitatRepo.createHabitat({ name: "Other Stale Run Habitat" });
      const stale = runRepo.startRun(
        makeRunInput(habitat.id, {
          contributionId: "old-running",
          triggerEventId: "old-event",
          startedAt: minutesAgo(60),
        }),
      );
      runRepo.startRun(
        makeRunInput(habitat.id, {
          contributionId: "fresh-running",
          triggerEventId: "fresh-event",
          startedAt: minutesAgo(5),
        }),
      );
      runRepo.startRun(
        makeRunInput(otherHabitat.id, {
          contributionId: "other-old-running",
          triggerEventId: "other-old-event",
          startedAt: minutesAgo(60),
        }),
      );

      const anonymous = await app.inject({
        method: "GET",
        url: `/api/habitats/${habitat.id}/plugins/stale-runs?thresholdMinutes=30`,
      });
      expect(anonymous.statusCode).toBe(401);

      const response = await app.inject({
        method: "GET",
        url: `/api/habitats/${habitat.id}/plugins/stale-runs?thresholdMinutes=30`,
        headers: { authorization: `Bearer ${makeToken()}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { staleRuns: StalePluginRun[] };
      expect(body.staleRuns).toHaveLength(1);
      expect(body.staleRuns[0]).toMatchObject({
        id: stale.id,
        habitatId: habitat.id,
        status: "running",
      });
      expect(body.staleRuns[0].elapsedMinutes).toBeGreaterThanOrEqual(60);
    } finally {
      await app.close();
    }
  });

  it("warns once per stale run and does not mutate plugin run statuses", () => {
    const habitat = habitatRepo.createHabitat({ name: "Scan Stale Run Habitat" });
    const stale = runRepo.startRun(
      makeRunInput(habitat.id, {
        contributionId: "old-running",
        triggerEventId: "old-event",
        startedAt: minutesAgo(60),
      }),
    );
    const terminal = runRepo.startRun(
      makeRunInput(habitat.id, {
        contributionId: "old-succeeded",
        triggerEventId: "succeeded-event",
        startedAt: minutesAgo(60),
      }),
    );
    runRepo.finishRun(terminal.id, "succeeded");
    const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];

    const count = scanStalePluginRuns(30, {
      warn(data: Record<string, unknown>, message: string) {
        warnings.push({ data, message });
      },
    });

    expect(count).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      data: expect.objectContaining({
        pluginId: stale.pluginId,
        contributionKind: stale.contributionKind,
        contributionId: stale.contributionId,
        triggerType: stale.triggerType,
        triggerEventId: stale.triggerEventId,
        runId: stale.id,
        startedAt: stale.startedAt,
        elapsedMinutes: expect.any(Number),
      }),
      message: "Stale plugin run detected",
    });
    expect(runRepo.getById(stale.id)?.status).toBe("running");
    expect(runRepo.getById(terminal.id)?.status).toBe("succeeded");
  });

  it("continues scanning when an individual warning cannot be emitted", () => {
    const habitat = habitatRepo.createHabitat({ name: "Resilient Stale Run Scan Habitat" });
    runRepo.startRun(
      makeRunInput(habitat.id, {
        contributionId: "first-old-running",
        triggerEventId: "first-event",
        startedAt: minutesAgo(90),
      }),
    );
    runRepo.startRun(
      makeRunInput(habitat.id, {
        contributionId: "second-old-running",
        triggerEventId: "second-event",
        startedAt: minutesAgo(60),
      }),
    );
    let calls = 0;

    const count = scanStalePluginRuns(30, {
      warn() {
        calls++;
        if (calls === 1) throw new Error("logger unavailable");
      },
    });

    expect(count).toBe(2);
    expect(calls).toBe(2);
  });
});
