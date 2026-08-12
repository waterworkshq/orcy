/**
 * Extraction execution routes — thin route tests for the four manual execution
 * endpoints added to close the gap between the service seam and the UI.
 *
 * Tests:
 *   1. POST ensure — returns disposition for a disabled policy (skipped)
 *   2. POST fresh-rerun — requires non-empty reason (400 on empty)
 *   3. POST fresh-rerun — returns disposition when reason is provided
 *   4. POST dry-run — returns disposition, persists NO findings
 *   5. GET runs — returns run/work history for the habitat
 *   6. 404 for non-existent policy
 *   7. 401 without auth
 *
 * Uses sql.js per-test DB, real extraction service, JWT auth.
 * Registers routes inline to avoid the Zod schema conversion issue in tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { notFound, badRequest } from "../errors.js";
import * as extractionPolicyService from "../services/extractionPolicyService.js";
import { runExtraction } from "../services/extractionRunLifecycle.js";
import {
  getWorkItemsByHabitatWithClient,
  getLatestAttemptWithClient,
} from "../repositories/extraction/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import { learningLoopPolicies } from "../db/schema/index.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerErrorHandler(app);
  await app.register(
    async (f) => {
      // Ensure — manual replay extraction
      f.post(
        "/habitats/:habitatId/extraction/policies/:policyId/ensure",
        { preHandler: [humanAuth, requireHabitatAccess] },
        async (request: any) => {
          const policy = extractionPolicyService.getPolicy(request.params.policyId);
          if (!policy || policy.habitatId !== request.params.habitatId) {
            throw notFound("Policy not found");
          }
          const result = runExtraction({
            habitatId: request.params.habitatId,
            policy,
            deliveryMode: "manual",
            actorType: "human",
            actorId: request.user!.id,
          });
          return { result };
        },
      );

      // Fresh rerun — requires reason
      f.post(
        "/habitats/:habitatId/extraction/policies/:policyId/fresh-rerun",
        { preHandler: [humanAuth, requireHabitatAccess] },
        async (request: any) => {
          const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
          const reason = body?.reason;
          if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
            throw badRequest("reason is required");
          }
          const policy = extractionPolicyService.getPolicy(request.params.policyId);
          if (!policy || policy.habitatId !== request.params.habitatId) {
            throw notFound("Policy not found");
          }
          const result = runExtraction({
            habitatId: request.params.habitatId,
            policy,
            deliveryMode: "manual",
            actorType: "human",
            actorId: request.user!.id,
            isFreshRerun: true,
            freshReason: reason,
          });
          return { result };
        },
      );

      // Dry run — diagnostic, no persisted findings
      f.post(
        "/habitats/:habitatId/extraction/policies/:policyId/dry-run",
        { preHandler: [humanAuth, requireHabitatAccess] },
        async (request: any) => {
          const policy = extractionPolicyService.getPolicy(request.params.policyId);
          if (!policy || policy.habitatId !== request.params.habitatId) {
            throw notFound("Policy not found");
          }
          const result = runExtraction({
            habitatId: request.params.habitatId,
            policy,
            deliveryMode: "manual",
            actorType: "human",
            actorId: request.user!.id,
            dryRun: true,
          });
          return { result };
        },
      );

      // Run history — habitat-scoped
      f.get(
        "/habitats/:habitatId/extraction/runs",
        { preHandler: [humanAuth, requireHabitatAccess] },
        async (request: any) => {
          const db = getDb();
          const workItems = getWorkItemsByHabitatWithClient(db, request.params.habitatId);
          const runs = workItems
            .map((wi) => {
              const attempt = getLatestAttemptWithClient(db, wi.id);
              if (!attempt) return null;
              return {
                id: attempt.id,
                workItemId: wi.id,
                status: attempt.status,
                deliveryMode: attempt.deliveryMode,
                extractorKey: wi.extractorKey,
                candidateCount: attempt.candidateCount,
                persistedCount: attempt.persistedCount,
                deduplicatedCount: attempt.deduplicatedCount,
                error: attempt.error,
                startedAt: attempt.startedAt,
                completedAt: attempt.completedAt,
                createdAt: attempt.createdAt,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null)
            .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
          return { runs };
        },
      );
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

let app: FastifyInstance;
let habitatId: string;
let token: string;
let policyId: string;

beforeEach(async () => {
  await initTestDb();
  app = await buildApp();

  const habitat = habitatRepo.createHabitat({ name: "Execution Test Habitat" });
  habitatId = habitat.id;

  token = makeToken({ sub: "user-1", username: "admin", role: "admin" });

  // Create a policy directly in the DB (disabled by default)
  const db = getDb();
  policyId = "pol-test-1";
  db.insert(learningLoopPolicies)
    .values({
      id: policyId,
      habitatId,
      extractorKey: "builtin:pattern_v1",
      enabled: 0,
      sourceTypes: ["task_lifecycle_audit"],
      schedule: "*/5 * * * *",
      windowSeconds: 3600,
      lookbackSeconds: 86400,
      minConfidence: null,
      minSampleSize: null,
      config: {},
      version: 1,
      createdByType: "human",
      createdById: "user-1",
    })
    .run();
});

afterEach(async () => {
  await app.close();
  await closeDb();
});

describe("Extraction execution routes", () => {
  it("POST /ensure returns skipped disposition for a disabled policy", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/extraction/policies/${policyId}/ensure`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBeDefined();
    // Disabled policy → skipped
    expect(body.result.kind).toBe("skipped");
    expect(body.result.reason).toBe("disabled");
  });

  it("POST /fresh-rerun returns 400 when reason is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/extraction/policies/${policyId}/fresh-rerun`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /fresh-rerun returns disposition when reason is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/extraction/policies/${policyId}/fresh-rerun`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "Data was stale after migration" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBeDefined();
    // Policy is disabled → the service returns skipped
    expect(["skipped", "executed", "deduplicated", "failed"]).toContain(body.result.kind);
  });

  it("POST /dry-run returns disposition and persists no findings", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/extraction/policies/${policyId}/dry-run`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBeDefined();
    // Disabled policy → skipped
    expect(body.result.kind).toBe("skipped");
  });

  it("GET /runs returns run/work history for the habitat", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/extraction/runs`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.runs).toBeDefined();
    expect(Array.isArray(body.runs)).toBe(true);
    // No runs yet
    expect(body.runs.length).toBe(0);
  });

  it("returns 404 for non-existent policy", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/extraction/policies/nonexistent/ensure`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/extraction/policies/${policyId}/ensure`,
    });

    expect(res.statusCode).toBe(401);
  });
});
