import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { humanAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { requireHabitatAccess } from '../middleware/team.js';
import * as prioritizationService from '../services/prioritizationService.js';
import * as taskRepo from '../repositories/task.js';
import * as habitatRepo from '../repositories/board.js';
import { notFound } from '../errors.js';

import type { PrioritizationSettings } from '../models/index.js';
import type { PrioritizationRuleCondition } from '../models/index.js';

const PRIORITY_REPORT_DEFAULT_LIMIT = 500;
const PRIORITY_REPORT_MAX_LIMIT = 2000;

const ruleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_priority'), value: z.string() }),
  z.object({ type: z.literal('bump_priority'), value: z.number() }),
  z.object({ type: z.literal('add_label'), value: z.string() }),
  z.object({ type: z.literal('set_score_bonus'), value: z.number() }),
]);

const nonRecursiveConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('overdue'), byDays: z.number().optional() }),
  z.object({ type: z.literal('sla_approaching'), withinHours: z.number() }),
  z.object({ type: z.literal('due_soon'), withinDays: z.number() }),
  z.object({ type: z.literal('pending_duration'), greaterThanHours: z.number() }),
  z.object({ type: z.literal('dependency_count'), greaterThan: z.number(), direction: z.union([z.literal('blocking'), z.literal('blocked_by')]) }),
  z.object({ type: z.literal('rejection_count'), greaterThan: z.number() }),
  z.object({ type: z.literal('mission_status'), status: z.string() }),
  z.object({ type: z.literal('agent_idle'), greaterThanMinutes: z.number() }),
  z.object({ type: z.literal('label_match'), labels: z.array(z.string()) }),
  z.object({ type: z.literal('priority_is'), priority: z.string() }),
]);

const ruleConditionSchema: z.ZodType<PrioritizationRuleCondition> = z.union([
  nonRecursiveConditionSchema,
  z.object({ type: z.literal('and'), conditions: z.array(z.lazy(() => ruleConditionSchema)) }),
  z.object({ type: z.literal('or'), conditions: z.array(z.lazy(() => ruleConditionSchema)) }),
]);

const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  condition: ruleConditionSchema,
  action: ruleActionSchema,
  priority: z.number(),
});

const updateRulesSchema = z.object({
  enabled: z.boolean().optional(),
  evaluateIntervalMinutes: z.number().int().min(1).optional(),
  rules: z.array(ruleSchema).optional(),
  fallbackToManual: z.boolean().optional(),
});

export async function prioritizationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/habitats/:habitatId/rules',
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const settings = prioritizationService.getPrioritizationRules(params.habitatId);
      return { rules: settings };
    }
  );

  fastify.put(
    '/habitats/:habitatId/rules',
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const parsed = updateRulesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid rules payload', details: parsed.error.flatten() });
      }

      const habitat = habitatRepo.getHabitatById(params.habitatId);
      if (!habitat) {
        throw notFound('Habitat not found', 'HABITAT_NOT_FOUND');
      }

      const current = habitat.prioritizationSettings ?? prioritizationService.getDefaultPrioritizationSettings();
      const updated: PrioritizationSettings = {
        ...current,
        ...parsed.data,
        rules: parsed.data.rules ?? current.rules,
      };

      habitatRepo.updateHabitat(params.habitatId, { prioritizationSettings: updated });
      return { rules: updated };
    }
  );

  fastify.post(
    '/habitats/:habitatId/rules/evaluate',
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const result = prioritizationService.applyPrioritization(params.habitatId);
      return { evaluation: result };
    }
  );

  fastify.get(
    '/habitats/:habitatId/priority-report',
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const query = request.query as { limit?: string };
      const limit = Math.min(
        Math.max(parseInt(query.limit ?? '', 10) || PRIORITY_REPORT_DEFAULT_LIMIT, 1),
        PRIORITY_REPORT_MAX_LIMIT,
      );

      const { tasks: habitatTasks } = taskRepo.getTasksByHabitatId(params.habitatId, { limit });

      const distribution: Record<string, number> = {};
      for (const task of habitatTasks) {
        distribution[task.priority] = (distribution[task.priority] ?? 0) + 1;
      }

      const evaluations = prioritizationService.evaluateRules(params.habitatId);
      const ruleHits: Record<string, number> = {};
      for (const ev of evaluations) {
        ruleHits[ev.ruleName] = (ruleHits[ev.ruleName] ?? 0) + 1;
      }

      return {
        habitatId: params.habitatId,
        totalTasks: habitatTasks.length,
        distribution,
        ruleHits,
        lastEvaluatedAt: new Date().toISOString(),
      };
    }
  );
}
