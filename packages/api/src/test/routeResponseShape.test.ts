import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { habitats } from "../db/schema/index.js";
import { habitatRoutes } from "../routes/habitats.js";
import * as habitatRepo from "../repositories/habitat.js";
import { getDefaultAnomalySettings } from "../services/anomalyService.js";
import { getDefaultAutoAssignSettings } from "../services/autoAssignService.js";
import {
  DEFAULT_RELEASE_SETTINGS,
  DEFAULT_ROADMAP_SETTINGS,
  DEFAULT_TRIAGE_SETTINGS,
} from "@orcy/shared";

// Route-response-shape contract suite (registry-driven). Pins the DECLARED
// shapes of settings blobs at the route boundary: every covered route must
// return every required field of its declared type, end-to-end through the
// Fastify app against a seeded habitat — so a regression to partial shapes
// (declared-shape violations surfacing at raw boundaries) fails CI instead of
// recurring silently. The service-layer class-guard lives in
// habitatSettingsPatch.test.ts; this is its route-layer counterpart.
// Extend by adding a row to BLOB_CONTRACTS (or a new route surface below).

vi.mock("../middleware/auth.js", () => ({
  agentOrHumanAuth: async () => {},
  humanAuth: async () => {},
  agentAuth: async () => {},
  registrationAuth: async () => {},
}));
vi.mock("../middleware/team.js", () => ({ requireHabitatAccess: async () => {} }));
vi.mock("../middleware/rbac.js", () => ({ adminOnly: async () => {} }));

let app: FastifyInstance | null = null;

async function buildApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  await server.register(habitatRoutes);
  await server.ready();
  return server;
}

/**
 * Registry of covered blob contracts: [settings key, legacy-partial seed,
 * required fields of the declared shape]. Each row is driven through the
 * GET detail, GET list, and PATCH response bodies.
 */
const BLOB_CONTRACTS = [
  ["releaseSettings", { autoPromote: false }, Object.keys(DEFAULT_RELEASE_SETTINGS)],
  ["roadmapSettings", { mode: "feature" }, Object.keys(DEFAULT_ROADMAP_SETTINGS)],
  ["autoAssignSettings", { enabled: true }, Object.keys(getDefaultAutoAssignSettings())],
  ["anomalySettings", { enabled: true }, Object.keys(getDefaultAnomalySettings())],
  ["triageSettings", { minClusterSize: 5 }, Object.keys(DEFAULT_TRIAGE_SETTINGS)],
] as const;

function seedHabitatWithLegacyPartial(key: string, partial: Record<string, unknown>): string {
  const habitatId = habitatRepo.createHabitat({ name: `Legacy ${key}` }).id;
  habitatRepo.updateHabitat(
    habitatId,
    { [key]: partial } as unknown as Parameters<typeof habitatRepo.updateHabitat>[1],
  );
  return habitatId;
}

type Injected = { status: number; body: Record<string, unknown> };

async function driveHabitatRoutes(habitatId: string): Promise<{
  detail: Injected;
  list: Injected;
  patch: Injected;
}> {
  app = app ?? (await buildApp());
  const asBody = (raw: { statusCode: number; json: () => unknown }): Injected => ({
    status: raw.statusCode,
    body: raw.json() as Record<string, unknown>,
  });
  const detail = asBody(await app.inject({ method: "GET", url: `/habitats/${habitatId}` }));
  const list = asBody(await app.inject({ method: "GET", url: "/habitats" }));
  const patch = asBody(
    await app.inject({
      method: "PATCH",
      url: `/habitats/${habitatId}`,
      payload: { name: `Renamed ${habitatId}` },
    }),
  );
  return { detail, list, patch };
}

beforeEach(async () => {
  await initTestDb();
  getDb().delete(habitats).run();
});

afterEach(async () => {
  if (app) await app.close();
  app = null;
  closeDb();
});

describe("settings-blob response shapes at the route boundary", () => {
  it.each(BLOB_CONTRACTS)(
    "%s: GET detail, GET list, and PATCH responses carry every required field",
    async (key, partial, required) => {
      const habitatId = seedHabitatWithLegacyPartial(key, partial);
      const { detail, list, patch } = await driveHabitatRoutes(habitatId);

      expect(detail.status).toBe(200);
      expect(list.status).toBe(200);
      expect(patch.status).toBe(200);

      const listBlob = (list.body.habitats as Record<string, unknown>[]).find(
        (h) => h.id === habitatId,
      )?.[key];
      const surfaces: Array<[string, unknown]> = [
        ["GET /habitats/:id", (detail.body.habitat as Record<string, unknown>)?.[key]],
        ["PATCH /habitats/:id", (patch.body.habitat as Record<string, unknown>)?.[key]],
        ["GET /habitats (list item)", listBlob],
      ];

      for (const [surface, blob] of surfaces) {
        expect(blob, `${surface}: ${key} must be present in the response body`).toBeDefined();
        for (const field of required) {
          expect(
            (blob as Record<string, unknown>)[field],
            `${surface}: ${key}.${field} must be present in the response body`,
          ).toBeDefined();
        }
      }
    },
  );

  it("codeReviewSettings: GET detail returns the complete masked shape for a legacy taskPattern-only blob", async () => {
    const habitatId = seedHabitatWithLegacyPartial("codeReviewSettings", { taskPattern: "ORC-" });
    const { detail } = await driveHabitatRoutes(habitatId);

    expect(detail.status).toBe(200);
    expect((detail.body.habitat as Record<string, unknown>).codeReviewSettings).toEqual({
      hasGithubSecret: false,
      hasGitlabSecret: false,
      taskPattern: "ORC-",
      autoApproveOnMerge: false,
    });
  });

  it("null blobs stay null at the route boundary (no default materialization)", async () => {
    const habitatId = habitatRepo.createHabitat({ name: "Null Blob" }).id;
    const { detail } = await driveHabitatRoutes(habitatId);

    expect(detail.status).toBe(200);
    expect((detail.body.habitat as Record<string, unknown>).releaseSettings).toBeNull();
  });
});
