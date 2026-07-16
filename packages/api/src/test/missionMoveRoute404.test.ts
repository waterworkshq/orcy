import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { initTestDb, closeDb } from "../db/index.js";
import { missionRoutes } from "../routes/missions.js";
import * as habitatService from "../services/boardService.js";
import * as missionRepo from "../repositories/mission.js";

// M4 / route-facing 404 contract — the `/missions/:id/move` route collapses
// both not-found-mission and invalid-target-column into a 404 so a caller
// cannot enumerate which side of the move was missing. Auth middleware is
// stubbed so the route handler, the real service, and the real repository
// (against a real test DB) are the only code under test.

vi.mock("../middleware/auth.js", () => ({
  agentOrHumanAuth: async () => {},
  humanAuth: async () => {},
}));

vi.mock("../middleware/team.js", () => ({
  requireHabitatAccess: async () => {},
  requireMissionAccess: async () => {},
}));

let app: FastifyInstance | null = null;

async function buildApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  await server.register(missionRoutes);
  await server.ready();
  return server;
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  if (app) await app.close();
  app = null;
  closeDb();
});

describe("M4 — /missions/:missionId/move route 404 is non-enumerating", () => {
  it("returns 404 for a nonexistent mission (notFound collapses to 404)", async () => {
    const { columns } = habitatService.createHabitat({ name: "Habitat A", defaultColumns: true });
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/missions/00000000-0000-4000-8000-000000000000/move`,
      payload: { columnId: columns[1].id, expectedVersion: 1 },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns the same 404 status for a cross-habitat target column (invalidTarget collapses to 404)", async () => {
    const { habitat: habA, columns: colsA } = habitatService.createHabitat({
      name: "Habitat A",
      defaultColumns: true,
    });
    const other = habitatService.createHabitat({ name: "Habitat B", defaultColumns: true });
    const mission = missionRepo.createMission({
      habitatId: habA.id,
      columnId: colsA[0].id,
      title: "Owner Mission",
      createdBy: "tester",
    });

    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/missions/${mission.id}/move`,
      payload: { columnId: other.columns[0].id, expectedVersion: mission.version },
    });

    // Same status as the not-found case — the route does not enumerate whether
    // the mission or the target column was the missing/foreign side.
    expect(res.statusCode).toBe(404);
  });
});
