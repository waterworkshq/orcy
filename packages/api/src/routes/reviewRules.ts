import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as reviewRuleRepo from '../repositories/reviewRule.js';
import * as taskReviewerRepo from '../repositories/taskReviewer.js';
import { requireHabitatAccess, checkHabitatAccess } from '../middleware/team.js';
import { badRequest, notFound, forbidden, unauthorized, conflict } from '../errors.js';
import { isTeamMemberByHabitatId } from '../repositories/teamMember.js';
import { getHabitatById } from '../repositories/habitat.js';
import { getTaskById } from '../repositories/task.js';
import * as agentRepo from '../repositories/agent.js';
import * as userRepo from '../repositories/user.js';
import { getMissionById } from '../repositories/mission.js';
import { z } from 'zod';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";

const STRATEGIES = ['domain_expert', 'round_robin', 'least_loaded', 'random', 'fixed'] as const;

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
});

const addReviewerSchema = z.object({
  reviewerId: z.string().min(1),
  reviewerType: z.enum(['human', 'agent']).optional(),
});

function verifyRuleHabitatAccess(request: FastifyRequest, habitatId: string): void {
  const habitat = getHabitatById(habitatId);
  if (!habitat) throw notFound('Habitat not found');

  if (request.agent) {
    if (!habitat.teamId) return;
    throw forbidden('Agents cannot access team habitats', 'BOARD_ACCESS_DENIED');
  }

  if (request.user) {
    if (!habitat.teamId) return;
    if (isTeamMemberByHabitatId(habitatId, request.user.id)) return;
    throw forbidden('You do not have access to this habitat', 'BOARD_ACCESS_DENIED');
  }

  throw unauthorized('Authentication required');
}

function getHabitatIdFromTask(taskId: string): string {
  const task = getTaskById(taskId);
  if (!task) throw notFound('Task not found');
  const mission = getMissionById(task.missionId);
  if (!mission) throw notFound('Mission not found');
  return mission.habitatId;
}

export async function reviewRuleRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/review-rules',
    { preHandler: [requireHabitatAccess], config: { authPolicy: "local_actor" } },
    async (request) => {
      const rules = reviewRuleRepo.getByHabitatId(request.params.habitatId);
      return { reviewRules: rules };
    }
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createRuleSchema> }>(
    '/habitats/:habitatId/review-rules',
    { preHandler: [requireHabitatAccess], config: { authPolicy: "human" } },
    async (request, reply) => {
      const parsed = createRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const rule = reviewRuleRepo.create(request.params.habitatId, parsed.data);
      reply.code(201).send({ reviewRule: rule });
    }
  );

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateRuleSchema> }>(
    '/review-rules/:id',
    { config: { authPolicy: "human" } },
    async (request) => {
      const parsed = updateRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const existing = reviewRuleRepo.getById(request.params.id);
      if (!existing) throw notFound('Review rule not found');

      verifyRuleHabitatAccess(request, existing.habitatId);

      const updated = reviewRuleRepo.update(request.params.id, parsed.data);
      return { reviewRule: updated };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/review-rules/:id',
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const existing = reviewRuleRepo.getById(request.params.id);
      if (!existing) throw notFound('Review rule not found');

      verifyRuleHabitatAccess(request, existing.habitatId);

      reviewRuleRepo.remove(request.params.id);
      reply.code(204).send();
    }
  );

  fastify.get<{ Params: { taskId: string } }>(
    '/tasks/:taskId/reviewers',
    { config: { authPolicy: "local_actor" } },
    async (request) => {
      // Object access resolves through the TARGET task's actual
      // Mission/Habitat (never a caller-supplied substitute) and runs the
      // shared membership predicate before any reviewer row is read.
      // Missing Task/Mission 404s come from getHabitatIdFromTask itself.
      const habitatId = getHabitatIdFromTask(request.params.taskId);
      await checkHabitatAccess(request, habitatId);

      const reviewers = taskReviewerRepo.getByTaskId(request.params.taskId);
      return { reviewers };
    }
  );

  fastify.post<{ Params: { taskId: string }; Body: z.infer<typeof addReviewerSchema> }>(
    '/tasks/:taskId/reviewers',
    { config: { authPolicy: "human" } },
    async (request, reply) => {
      const habitatId = getHabitatIdFromTask(request.params.taskId);
      verifyRuleHabitatAccess(request, habitatId);

      const parsed = addReviewerSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      // Creation validation (typed identity, no coercion). Management stays
      // human-only; TARGET eligibility is deliberately not restricted by the
      // habitat's team membership — agent-typed rows remain creatable on team
      // habitats (authorized humans/server automation can already produce
      // them, and the restoration must make such rows resolvable).
      const reviewerType = parsed.data.reviewerType ?? 'human';
      const task = getTaskById(request.params.taskId);
      if (!task) throw notFound('Task not found');

      if (reviewerType === 'agent') {
        const agent = agentRepo.getAgentById(parsed.data.reviewerId);
        if (!agent) {
          throw badRequest(
            `Reviewer "${parsed.data.reviewerId}" not found in the agent registry`,
          );
        }
        // Typed anti-self: an agent row may not name the task's current
        // assignee. A human id that merely collides with the assignee's id
        // string is NOT self-review.
        if (task.assignedAgentId === parsed.data.reviewerId) {
          throw badRequest('Agent reviewer cannot be the task\'s current assignee (self-review)');
        }
      } else {
        const user = userRepo.getUserById(parsed.data.reviewerId);
        if (!user) {
          throw badRequest(
            `Reviewer "${parsed.data.reviewerId}" not found in the user registry`,
          );
        }
      }

      const existing = taskReviewerRepo.findByTaskAndReviewer(
        request.params.taskId,
        parsed.data.reviewerId
      );
      if (existing) {
        if (existing.reviewerType === reviewerType) {
          // Idempotent duplicate: return the existing row, create nothing.
          reply.code(200).send({ reviewer: existing });
          return;
        }
        throw conflict(
          `Reviewer "${parsed.data.reviewerId}" is already assigned as type "${existing.reviewerType}"`,
        );
      }

      const reviewer = taskReviewerRepo.create(
        request.params.taskId,
        reviewerType,
        parsed.data.reviewerId
      );
      reply.code(201).send({ reviewer });
    }
  );

  fastify.delete<{ Params: { taskId: string; reviewerId: string } }>(
    '/tasks/:taskId/reviewers/:reviewerId',
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { taskId: string; reviewerId: string } }>, reply: FastifyReply) => {
      const habitatId = getHabitatIdFromTask(request.params.taskId);
      verifyRuleHabitatAccess(request, habitatId);

      const reviewer = taskReviewerRepo.findByTaskAndReviewer(request.params.taskId, request.params.reviewerId);
      if (!reviewer) throw notFound('Reviewer assignment not found');

      taskReviewerRepo.remove(reviewer.id);
      reply.code(204).send();
    }
  );
}
