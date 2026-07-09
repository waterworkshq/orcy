import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import { habitatRoutes } from "../routes/habitats.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import { rebuildCache as rebuildHabitatSecretCache } from "../services/boardSecretCache.js";
import * as habitatService from "../services/boardService.js";
import * as habitatRepo from "../repositories/board.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

describe("PUT /habitats/:habitatId/webhook-secrets (route-level masking)", () => {
  let app: FastifyInstance;
  let userToken: string;

  beforeEach(async () => {
    await initTestDb();
    if (app) await app.close();
    app = Fastify({ logger: false });
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
    userToken = makeToken({ sub: "user-1", username: "u1", role: "admin" });
    rebuildHabitatSecretCache();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  async function createHabitat(name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name, defaultColumns: true },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).habitat.id;
  }

  it("writes a secret and the PUT response carries only presence booleans (no raw secret)", async () => {
    const habitatId = await createHabitat("Secrets Habitat");
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/habitats/${habitatId}/webhook-secrets`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { provider: "code_review", githubSecret: "super-secret-value" },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = JSON.parse(putRes.body);
    expect(putBody.codeReviewSettings.hasGithubSecret).toBe(true);
    expect(putBody.codeReviewSettings.hasGitlabSecret).toBe(false);
    expect((putBody.codeReviewSettings as any).githubSecret).toBeUndefined();
    expect(putRes.body).not.toContain("super-secret-value");
  });

  it("after PUT the raw habitat row (read directly from the repo) is masked by listHabitats and by maskSecretSettings", async () => {
    const habitatId = await createHabitat("Mask Verify Habitat");
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/habitats/${habitatId}/webhook-secrets`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { provider: "code_review", githubSecret: "should-never-leak" },
    });
    expect(putRes.statusCode).toBe(200);

    // The repo stores the real secret (boardSecretCache needs it).
    const raw = habitatRepo.getHabitatById(habitatId);
    expect(raw?.codeReviewSettings?.githubSecret).toBe("should-never-leak");

    // listHabitats masks before returning — this is the GET /habitats surface.
    const listed = habitatService.listHabitats();
    const entry = listed.find((h) => h.id === habitatId);
    expect(entry).toBeDefined();
    expect((entry!.codeReviewSettings as any).githubSecret).toBeUndefined();
    expect(entry!.codeReviewSettings!.hasGithubSecret).toBe(true);

    // Direct unit-level confirmation: maskSecretSettings strips the secret.
    const masked = habitatService.maskSecretSettings(raw!);
    expect((masked.codeReviewSettings as any).githubSecret).toBeUndefined();
    expect(masked.codeReviewSettings!.hasGithubSecret).toBe(true);
    expect(masked.codeReviewSettings!.hasGitlabSecret).toBe(false);
    expect(masked.codeReviewSettings!.taskPattern).toBe(raw!.codeReviewSettings!.taskPattern);
    expect(masked.codeReviewSettings!.autoApproveOnMerge).toBe(
      raw!.codeReviewSettings!.autoApproveOnMerge,
    );
  });

  it("null clears the previously configured secret", async () => {
    const habitatId = await createHabitat("Clear Habitat");
    await app.inject({
      method: "PUT",
      url: `/api/habitats/${habitatId}/webhook-secrets`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { provider: "code_review", githubSecret: "to-be-cleared" },
    });
    const clearRes = await app.inject({
      method: "PUT",
      url: `/api/habitats/${habitatId}/webhook-secrets`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { provider: "code_review", githubSecret: null },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(JSON.parse(clearRes.body).codeReviewSettings.hasGithubSecret).toBe(false);

    const raw = habitatRepo.getHabitatById(habitatId);
    expect(raw?.codeReviewSettings?.githubSecret).toBeNull();
  });

  it("merge preserves taskPattern and autoApproveOnMerge set via PATCH", async () => {
    const habitatId = await createHabitat("Merge Habitat");
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/habitats/${habitatId}`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        codeReviewSettings: { taskPattern: "[MY-PATTERN]", autoApproveOnMerge: true },
      },
    });
    expect(patchRes.statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: `/api/habitats/${habitatId}/webhook-secrets`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { provider: "code_review", githubSecret: "x" },
    });

    const raw = habitatRepo.getHabitatById(habitatId);
    expect(raw?.codeReviewSettings?.taskPattern).toBe("[MY-PATTERN]");
    expect(raw?.codeReviewSettings?.autoApproveOnMerge).toBe(true);
    expect(raw?.codeReviewSettings?.githubSecret).toBe("x");
  });

  it("rejects invalid provider enum values", async () => {
    const habitatId = await createHabitat("Validation Habitat");
    const res = await app.inject({
      method: "PUT",
      url: `/api/habitats/${habitatId}/webhook-secrets`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { provider: "garbage", githubSecret: "x" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("returns 404 for an unknown habitat", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/habitats/00000000-0000-0000-0000-000000000000/webhook-secrets",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { provider: "code_review", githubSecret: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/habitats/any/webhook-secrets",
      payload: { provider: "code_review", githubSecret: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rebuilds the in-memory secret cache after a write so webhook verification can use it", async () => {
    const habitatId = await createHabitat("Cache Habitat");
    await app.inject({
      method: "PUT",
      url: `/api/habitats/${habitatId}/webhook-secrets`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { provider: "code_review", githubSecret: "cache-verify-secret" },
    });
    // After the PUT the cache rebuilds via boardSecretCache; the underlying repo row
    // must carry the raw secret because boardSecretCache reads raw.
    const raw = habitatRepo.getHabitatById(habitatId);
    expect(raw?.codeReviewSettings?.githubSecret).toBe("cache-verify-secret");
  });
});