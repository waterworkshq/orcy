/**
 * Route-level tests for the `lifecycleSettings` habitat settings surface
 * (transition budget, ticket 1).
 *
 * Exercises the FULL settings flow end-to-end through the real Fastify PATCH
 * route and Zod boundary against the real (sql.js test) database — the strip
 * behavior of the route schema is part of the contract under test, so a
 * service-level call would not discriminate.
 *
 * Coverage:
 *   1. PATCH { lifecycleSettings: { taskTransitionCeiling: 0 } } persists the
 *      explicit opt-out and GET round-trips the blob.
 *   2. A null field value persists null (default-ceiling semantics).
 *   3. A top-level null blob clears the stored blob.
 *   4. Absent field inside a present blob preserves the stored value
 *      (deep-merge discriminator — the CS-20 no-field-default guard).
 *   5. Negative / non-integer / >10_000 ceilings are rejected with 400.
 *   6. Default-null contract: a fresh habitat GETs `lifecycleSettings: null`
 *      and the shared default ceiling constant is 12 (resolver lands in
 *      ticket 2; this pins the contract it consumes).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import { habitatRoutes } from "../routes/habitats.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function setupApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(habitatRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

async function createHabitat(app: FastifyInstance, token: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/habitats",
    headers: { authorization: `Bearer ${token}` },
    payload: { name, defaultColumns: true },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).habitat.id;
}

function patchLifecycleSettings(
  app: FastifyInstance,
  token: string,
  habitatId: string,
  lifecycleSettings: unknown,
) {
  return app.inject({
    method: "PATCH",
    url: `/api/habitats/${habitatId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { lifecycleSettings },
  });
}

async function getHabitatBlob(
  app: FastifyInstance,
  token: string,
  habitatId: string,
): Promise<unknown> {
  const res = await app.inject({
    method: "GET",
    url: `/api/habitats/${habitatId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body).habitat.lifecycleSettings;
}

describe("lifecycleSettings surface (transition budget ticket 1)", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    await initTestDb();
    if (app) await app.close();
    app = await setupApp();
    token = makeToken({ sub: "user-lifecycle-tester", username: "lifecycle-tester", role: "admin" });
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("persists an explicit 0 opt-out and round-trips it via GET", async () => {
    const habitatId = await createHabitat(app, token, "Lifecycle Opt-Out Habitat");

    const patchRes = await patchLifecycleSettings(app, token, habitatId, {
      taskTransitionCeiling: 0,
    });
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).habitat.lifecycleSettings).toEqual({
      taskTransitionCeiling: 0,
    });

    expect(await getHabitatBlob(app, token, habitatId)).toEqual({ taskTransitionCeiling: 0 });
  });

  it("persists a null ceiling (default-ceiling semantics)", async () => {
    const habitatId = await createHabitat(app, token, "Lifecycle Null Habitat");

    const patchRes = await patchLifecycleSettings(app, token, habitatId, {
      taskTransitionCeiling: null,
    });
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).habitat.lifecycleSettings).toEqual({
      taskTransitionCeiling: null,
    });
  });

  it("clears the stored blob on a top-level null", async () => {
    const habitatId = await createHabitat(app, token, "Lifecycle Clear Habitat");
    await patchLifecycleSettings(app, token, habitatId, { taskTransitionCeiling: 7 });

    const patchRes = await patchLifecycleSettings(app, token, habitatId, null);
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).habitat.lifecycleSettings).toBeNull();
  });

  it("preserves the stored field when the blob PATCH omits it (deep-merge)", async () => {
    const habitatId = await createHabitat(app, token, "Lifecycle Merge Habitat");
    await patchLifecycleSettings(app, token, habitatId, { taskTransitionCeiling: 5 });

    // Empty blob object: the field is absent, so the stored value must survive.
    const patchRes = await patchLifecycleSettings(app, token, habitatId, {});
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).habitat.lifecycleSettings).toEqual({
      taskTransitionCeiling: 5,
    });

    // An unrelated PATCH leaves the blob untouched too.
    const renameRes = await app.inject({
      method: "PATCH",
      url: `/api/habitats/${habitatId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Lifecycle Merge Habitat Renamed" },
    });
    expect(renameRes.statusCode).toBe(200);
    expect(JSON.parse(renameRes.body).habitat.lifecycleSettings).toEqual({
      taskTransitionCeiling: 5,
    });
  });

  it("rejects invalid ceilings with 400", async () => {
    const habitatId = await createHabitat(app, token, "Lifecycle Invalid Habitat");

    for (const taskTransitionCeiling of [-1, 1.5, 10_001]) {
      const res = await patchLifecycleSettings(app, token, habitatId, { taskTransitionCeiling });
      expect(res.statusCode, `ceiling ${taskTransitionCeiling} must 400`).toBe(400);
    }
  });

  it("default-null contract: fresh habitat GETs a null blob and the shared default is 12", async () => {
    const habitatId = await createHabitat(app, token, "Lifecycle Default Habitat");
    expect(await getHabitatBlob(app, token, habitatId)).toBeNull();

    // Dynamic import keeps this file loadable pre-implementation so the
    // PATCH-surface RED stays per-test attributable.
    const shared = await import("@orcy/shared");
    expect((shared as Record<string, unknown>).DEFAULT_TASK_TRANSITION_CEILING).toBe(12);
  });
});
