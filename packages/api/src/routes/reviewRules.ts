import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import { requireHabitatAccess, checkHabitatAccess } from "../middleware/team.js";
import { badRequest, notFound } from "../errors.js";
import { getTaskById } from "../repositories/task.js";
import { getDb } from "../db/index.js";
import { getMissionById } from "../repositories/mission.js";
import { z } from "zod";
import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import {
  createRuleCommand,
  updateRuleCommand,
  deleteRuleCommand,
  addReviewerCommand,
  removeReviewerCommand,
  listReviewersWithToken,
  resolveCommandActor,
  type ReviewerAddInput,
} from "../services/reviewGovernance.js";

const STRATEGIES = ["domain_expert", "round_robin", "least_loaded", "random", "fixed"] as const;

const createRuleSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.number().min(0).max(1).optional(),
  priority: z.number().int().min(0).optional(),
  matchDomain: z.string().nullable().optional(),
  matchLabels: z.array(z.string()).optional(),
  matchPriority: z.string().nullable().optional(),
  assignmentStrategy: z.enum(STRATEGIES).optional(),
  requiredReviews: z.number().int().min(1).max(10).optional(),
  antiSelfReview: z.number().min(0).max(1).optional(),
  fixedReviewerIds: z.array(z.string()).optional(),
});

// Optional CAS fields are EXPLICIT, never stripped: Zod strips unknown
// keys by default, so each supplied expectation must be a named field or
// it is silently lost before the command ever sees it.
const updateRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.number().min(0).max(1).optional(),
  priority: z.number().int().min(0).optional(),
  matchDomain: z.string().nullable().optional(),
  matchLabels: z.array(z.string()).optional(),
  matchPriority: z.string().nullable().optional(),
  assignmentStrategy: z.enum(STRATEGIES).optional(),
  requiredReviews: z.number().int().min(1).max(10).optional(),
  antiSelfReview: z.number().min(0).max(1).optional(),
  fixedReviewerIds: z.array(z.string()).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

const addReviewerSchema = z.object({
  reviewerId: z.string().min(1),
  reviewerType: z.enum(["human", "agent"]).optional(),
  expectedReviewersToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export function getHabitatIdFromTask(taskId: string): string {
  const task = getTaskById(taskId);
  if (!task) throw notFound("Task not found");
  const mission = getMissionById(task.missionId);
  if (!mission) throw notFound("Mission not found");
  return mission.habitatId;
}

export async function reviewRuleRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/review-rules",
    { preHandler: [requireHabitatAccess], config: { authPolicy: "local_actor" } },
    async (request) => {
      const rules = reviewRuleRepo.getByHabitatId(request.params.habitatId);
      return { reviewRules: rules };
    },
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createRuleSchema> }>(
    "/habitats/:habitatId/review-rules",
    { config: { authPolicy: "local_actor" } },
    async (request, reply) => {
      const parsed = createRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      // Creation has no prior object to CAS; the new row starts at version 1.
      // Authority (review.configure on the target Habitat) is enforced by the
      // command service inside its own reservation.
      const rule = createRuleCommand({
        habitatId: request.params.habitatId,
        actor: resolveCommandActor(request),
        fields: parsed.data,
      });
      reply.code(201).send({ reviewRule: rule });
    },
  );

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateRuleSchema> }>(
    "/review-rules/:id",
    { config: { authPolicy: "local_actor" } },
    async (request) => {
      const parsed = updateRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      // The service re-checks existence/authority inside its own reservation.
      const { expectedVersion, ...fields } = parsed.data;
      const updated = updateRuleCommand({
        ruleId: request.params.id,
        actor: resolveCommandActor(request),
        fields,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      });
      return { reviewRule: updated };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/review-rules/:id",
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      // Optional query CAS for empty-body clients; omitted = legacy LWW.
      // The COMPLETE raw query value is validated: only absence means LWW.
      // An explicitly supplied value — empty string, fractional ('1.5'),
      // trailing junk ('1junk'), or a repeated parameter (Fastify delivers
      // an array) — is a 400, never silently truncated or treated as absent.
      const rawVersion = (request.query as { expectedVersion?: unknown })?.expectedVersion;
      let expectedVersion: number | undefined;
      if (rawVersion !== undefined) {
        if (typeof rawVersion !== "string" || !/^[1-9][0-9]*$/.test(rawVersion)) {
          throw badRequest("expectedVersion must be a positive integer");
        }
        expectedVersion = Number(rawVersion);
        if (!Number.isSafeInteger(expectedVersion)) {
          throw badRequest("expectedVersion must be a positive safe integer");
        }
      }

      deleteRuleCommand({
        ruleId: request.params.id,
        actor: resolveCommandActor(request),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      });
      reply.code(204).send();
    },
  );

  fastify.get<{ Params: { taskId: string } }>(
    "/tasks/:taskId/reviewers",
    { config: { authPolicy: "local_actor" } },
    async (request) => {
      // Object access resolves through the TARGET task's actual
      // Mission/Habitat (never a caller-supplied substitute) and runs the
      // shared membership predicate before any reviewer row is read.
      // Missing Task/Mission 404s come from getHabitatIdFromTask itself.
      const habitatId = getHabitatIdFromTask(request.params.taskId);
      await checkHabitatAccess(request, habitatId);

      // Roster token: the GET exposes the effective current-generation
      // projection plus the deterministic SHA-256 token over the actual rows,
      // their raw + projected statuses and the requirement fields.
      const listing = listReviewersWithToken(request.params.taskId, habitatId, getDb() as never);
      return {
        reviewers: listing.reviewers,
        reviewersToken: listing.token,
      };
    },
  );

  fastify.post<{ Params: { taskId: string }; Body: z.infer<typeof addReviewerSchema> }>(
    "/tasks/:taskId/reviewers",
    { config: { authPolicy: "local_actor" } },
    async (request, reply) => {
      // No membership gate here: the command's evaluator owns authorization
      // (review.assign grant or governance adapter), so a granted non-member
      // must reach it. Existence 404s still come from getHabitatIdFromTask;
      // authority refusal comes from the transaction-bound evaluator.
      getHabitatIdFromTask(request.params.taskId);

      const parsed = addReviewerSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const input: ReviewerAddInput = {
        taskId: request.params.taskId,
        reviewerId: parsed.data.reviewerId,
        reviewerType: parsed.data.reviewerType ?? "human",
        actor: resolveCommandActor(request),
      };
      if (parsed.data.expectedReviewersToken !== undefined) {
        input.expectedReviewersToken = parsed.data.expectedReviewersToken;
      }

      const { reviewer, duplicate } = addReviewerCommand(input);
      if (duplicate) {
        reply.code(200).send({ reviewer });
      } else {
        reply.code(201).send({ reviewer });
      }
    },
  );

  fastify.delete<{ Params: { taskId: string; reviewerId: string } }>(
    "/tasks/:taskId/reviewers/:reviewerId",
    { config: { authPolicy: "local_actor" } },
    async (
      request: FastifyRequest<{ Params: { taskId: string; reviewerId: string } }>,
      reply: FastifyReply,
    ) => {
      // Same as POST: the evaluator owns authorization; no membership gate.
      getHabitatIdFromTask(request.params.taskId);

      const rawToken = (request.query as { expectedReviewersToken?: unknown })
        ?.expectedReviewersToken;
      if (
        rawToken !== undefined &&
        (typeof rawToken !== "string" || !/^[0-9a-f]{64}$/.test(rawToken))
      ) {
        throw badRequest("expectedReviewersToken must be a 64-character hex token");
      }

      removeReviewerCommand({
        taskId: request.params.taskId,
        reviewerId: request.params.reviewerId,
        actor: resolveCommandActor(request),
        ...(typeof rawToken === "string" ? { expectedReviewersToken: rawToken } : {}),
      });
      reply.code(204).send();
    },
  );
}
