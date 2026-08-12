/**
 * Extraction REST routes — human review/decision surface + agent accepted-finding reads.
 *
 * Human-only routes (`[humanAuth, requireHabitatAccess]`): policy CRUD, review
 * queue/list/detail, accept/reject/request_revision/withdraw, citation refresh,
 * and accepted-finding list with filters.
 *
 * Agent-accessible routes (`[agentOrHumanAuth, requireHabitatAccess]`):
 * `list_accepted` and `get` requiring a current `taskId`. The handler passes
 * `(agentId, taskId, habitatId, filters)` to the repository, which applies the
 * actor-bound predicate — NOT a middleware precheck.
 *
 * Uses AppError (`notFound`/`forbidden`/`conflict`/`badRequest`) — never raw
 * `reply.code().send()`. Zod-validate all inputs.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { humanAuth, agentOrHumanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { notFound } from "../errors.js";
import * as extractionPolicyService from "../services/extractionPolicyService.js";
import * as extractionReviewService from "../services/extractionReviewService.js";
import * as extractionPromotionService from "../services/extractionPromotionService.js";
import { runExtraction } from "../services/extractionRunLifecycle.js";
import {
  listAcceptedFindingsForAgentWithClient,
  getAcceptedFindingForAgentWithClient,
  getWorkItemsByHabitatWithClient,
  getLatestAttemptWithClient,
} from "../repositories/extraction/index.js";
import { getDb } from "../db/index.js";

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

const findingParamsSchema = z.object({
  habitatId: z.string(),
  findingId: z.string(),
});

const policyParamsSchema = z.object({
  habitatId: z.string(),
  policyId: z.string(),
});

// ---------------------------------------------------------------------------
// Zod schemas for bodies
// ---------------------------------------------------------------------------

const createPolicyBodySchema = z.object({
  extractorKey: z.string().min(1),
  sourceTypes: z.array(z.string()).min(1),
  schedule: z.string().min(1),
  windowSeconds: z.number().int().positive(),
  lookbackSeconds: z.number().int().positive(),
  minConfidence: z.number().min(0).max(1).optional().nullable(),
  minSampleSize: z.number().int().positive().optional().nullable(),
  config: z.record(z.unknown()).optional(),
});

const updatePolicyBodySchema = z.object({
  enabled: z.boolean().optional(),
  sourceTypes: z.array(z.string()).min(1).optional(),
  schedule: z.string().min(1).optional(),
  windowSeconds: z.number().int().positive().optional(),
  lookbackSeconds: z.number().int().positive().optional(),
  minConfidence: z.number().min(0).max(1).optional().nullable(),
  minSampleSize: z.number().int().positive().optional().nullable(),
  config: z.record(z.unknown()).optional(),
  expectedVersion: z.number().int().positive(),
});

const decisionBodySchema = z.object({
  expectedDecisionVersion: z.number().int().positive(),
  reason: z.string().optional(),
});

const reviewQueueQuerySchema = z.object({
  findingType: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const humanFindingsQuerySchema = z.object({
  findingType: z.string().optional(),
  domain: z.string().optional(),
  maxAgeSeconds: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const agentFindingsQuerySchema = z.object({
  taskId: z.string().min(1),
  findingType: z.string().optional(),
  domain: z.string().optional(),
  maxAgeSeconds: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(25).optional(),
  maxChars: z.number().int().positive().optional(),
});

const freshRerunBodySchema = z.object({
  reason: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function extractionRoutes(fastify: FastifyInstance): Promise<void> {
  // ──────────────────────────────────────────────────────────────
  // Policy CRUD (human-only)
  // ──────────────────────────────────────────────────────────────

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/policies",
    {
      schema: { params: habitatIdParamsSchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const policies = extractionPolicyService.getPoliciesByHabitat(request.params.habitatId);
      return { policies };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/policies",
    {
      schema: { params: habitatIdParamsSchema, body: createPolicyBodySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request, reply) => {
      const result = extractionPolicyService.createPolicy({
        habitatId: request.params.habitatId,
        extractorKey: request.body.extractorKey,
        sourceTypes: request.body.sourceTypes as never,
        schedule: request.body.schedule,
        windowSeconds: request.body.windowSeconds,
        lookbackSeconds: request.body.lookbackSeconds,
        minConfidence: request.body.minConfidence ?? null,
        minSampleSize: request.body.minSampleSize ?? null,
        config: request.body.config ?? {},
        createdByType: "human",
        createdById: request.user!.id,
      });
      reply.code(201);
      return result;
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/policies/:policyId",
    {
      schema: { params: policyParamsSchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const policy = extractionPolicyService.getPolicy(request.params.policyId);
      if (!policy || policy.habitatId !== request.params.habitatId) {
        throw notFound("Policy not found");
      }
      return { policy };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().patch(
    "/habitats/:habitatId/extraction/policies/:policyId",
    {
      schema: { params: policyParamsSchema, body: updatePolicyBodySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const existing = extractionPolicyService.getPolicy(request.params.policyId);
      if (!existing || existing.habitatId !== request.params.habitatId) {
        throw notFound("Policy not found");
      }
      const result = extractionPolicyService.updatePolicy({
        policyId: request.params.policyId,
        expectedVersion: request.body.expectedVersion,
        enabled: request.body.enabled,
        sourceTypes: request.body.sourceTypes as never | undefined,
        schedule: request.body.schedule,
        windowSeconds: request.body.windowSeconds,
        lookbackSeconds: request.body.lookbackSeconds,
        minConfidence: request.body.minConfidence,
        minSampleSize: request.body.minSampleSize,
        config: request.body.config,
      });
      return result;
    },
  );

  // ──────────────────────────────────────────────────────────────
  // Review queue + finding detail (human-only)
  // ──────────────────────────────────────────────────────────────

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/review/queue",
    {
      schema: { params: habitatIdParamsSchema, querystring: reviewQueueQuerySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const queue = extractionReviewService.getReviewQueue(
        request.params.habitatId,
        {
          findingType: request.query.findingType as never | undefined,
          limit: request.query.limit,
        },
      );
      return { findings: queue };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/findings",
    {
      schema: { params: habitatIdParamsSchema, querystring: humanFindingsQuerySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const findings = extractionReviewService.listAcceptedFindings(
        request.params.habitatId,
        {
          findingType: request.query.findingType as never | undefined,
          domain: request.query.domain,
          maxAgeSeconds: request.query.maxAgeSeconds,
          limit: request.query.limit,
        },
      );
      return { findings };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/findings/:findingId",
    {
      schema: { params: findingParamsSchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      return extractionReviewService.getFindingDetail(
        request.params.habitatId,
        request.params.findingId,
      );
    },
  );

  // ──────────────────────────────────────────────────────────────
  // Decisions (human-only, CAS-protected)
  // ──────────────────────────────────────────────────────────────

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/findings/:findingId/accept",
    {
      schema: { params: findingParamsSchema, body: decisionBodySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const finding = extractionReviewService.acceptFinding({
        habitatId: request.params.habitatId,
        findingId: request.params.findingId,
        reviewerId: request.user!.id,
        expectedDecisionVersion: request.body.expectedDecisionVersion,
        reason: request.body.reason,
      });
      return { finding };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/findings/:findingId/reject",
    {
      schema: { params: findingParamsSchema, body: decisionBodySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const finding = extractionReviewService.rejectFinding({
        habitatId: request.params.habitatId,
        findingId: request.params.findingId,
        reviewerId: request.user!.id,
        expectedDecisionVersion: request.body.expectedDecisionVersion,
        reason: request.body.reason,
      });
      return { finding };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/findings/:findingId/revise",
    {
      schema: { params: findingParamsSchema, body: decisionBodySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      return extractionReviewService.requestRevision({
        habitatId: request.params.habitatId,
        findingId: request.params.findingId,
        reviewerId: request.user!.id,
        expectedDecisionVersion: request.body.expectedDecisionVersion,
        reason: request.body.reason,
      });
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/findings/:findingId/withdraw",
    {
      schema: { params: findingParamsSchema, body: decisionBodySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const finding = extractionReviewService.withdrawFinding({
        habitatId: request.params.habitatId,
        findingId: request.params.findingId,
        reviewerId: request.user!.id,
        expectedDecisionVersion: request.body.expectedDecisionVersion,
        reason: request.body.reason,
      });
      return { finding };
    },
  );

  // ──────────────────────────────────────────────────────────────
  // Citation refresh (human-only)
  // ──────────────────────────────────────────────────────────────

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/findings/:findingId/citations/refresh",
    {
      schema: { params: findingParamsSchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      const citations = extractionReviewService.refreshCitationStates(
        request.params.habitatId,
        request.params.findingId,
      );
      return { citations };
    },
  );

  // ──────────────────────────────────────────────────────────────
  // Promotion eligibility + reservation (human-only)
  // ──────────────────────────────────────────────────────────────

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/findings/:findingId/promotion-eligibility",
    {
      schema: { params: findingParamsSchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
      return extractionPromotionService.checkPromotionEligibility(
        request.params.habitatId,
        request.params.findingId,
      );
    },
  );

  // ──────────────────────────────────────────────────────────────
  // Agent accepted-finding reads (agent-or-human, task-bound predicate)
  // ──────────────────────────────────────────────────────────────

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/agent/findings",
    {
      schema: { params: habitatIdParamsSchema, querystring: agentFindingsQuerySchema },
      preHandler: [agentOrHumanAuth, requireHabitatAccess],
    },
    async (request) => {
      const agentId = request.agent?.id ?? "";
      const { taskId } = request.query;

      const findings = listAcceptedFindingsForAgentWithClient(
        getDb(),
        agentId,
        taskId,
        request.params.habitatId,
        {
          findingType: request.query.findingType as never | undefined,
          domain: request.query.domain,
          maxAgeSeconds: request.query.maxAgeSeconds,
          limit: request.query.limit,
          maxChars: request.query.maxChars,
        },
      );
      return { findings };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/agent/findings/:findingId",
    {
      schema: {
        params: findingParamsSchema,
        querystring: z.object({ taskId: z.string().min(1) }),
      },
      preHandler: [agentOrHumanAuth, requireHabitatAccess],
    },
    async (request) => {
      const agentId = request.agent?.id ?? "";
      const { taskId } = request.query;

      const finding = getAcceptedFindingForAgentWithClient(
        getDb(),
        agentId,
        taskId,
        request.params.habitatId,
        request.params.findingId,
      );

      // Collapsed denial: not-found and forbidden are identical.
      if (!finding) throw notFound("Finding not found");
      return { finding };
    },
  );

  // ──────────────────────────────────────────────────────────────
  // Manual execution controls (human-only)
  // ──────────────────────────────────────────────────────────────

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/policies/:policyId/ensure",
    {
      schema: { params: policyParamsSchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
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

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/policies/:policyId/fresh-rerun",
    {
      schema: { params: policyParamsSchema, body: freshRerunBodySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
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
        freshReason: request.body.reason,
      });
      return { result };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/extraction/policies/:policyId/dry-run",
    {
      schema: { params: policyParamsSchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
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

  // ──────────────────────────────────────────────────────────────
  // Run/work history (human-only, habitat-scoped)
  // ──────────────────────────────────────────────────────────────

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/extraction/runs",
    {
      schema: { params: habitatIdParamsSchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request) => {
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
}
