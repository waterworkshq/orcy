import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { humanAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { requireBoardAccess } from '../middleware/team.js';
import * as prioritizationService from '../services/prioritizationService.js';
import * as taskRepo from '../repositories/task.js';
import * as boardRepo from '../repositories/board.js';
import { notFound } from '../errors.js';

import type { PrioritizationSettings } from '../models/index.js';

const PRIORITY_REPORT_DEFAULT_LIMIT = 500;
const PRIORITY_REPORT_MAX_LIMIT = 2000;

const updateRulesSchema = z.object({
  enabled: z.boolean().optional(),
  evaluateIntervalMinutes: z.number().int().min(1).optional(),
  rules: z.array(z.record(z.unknown())).optional(),
  fallbackToManual: z.boolean().optional(),
});

export async function prioritizationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/boards/:id/rules',
    { preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const settings = prioritizationService.getPrioritizationRules(params.id);
      return { rules: settings };
    }
  );

  fastify.put(
    '/boards/:id/rules',
    { preHandler: [humanAuth, requireBoardAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const parsed = updateRulesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid rules payload', details: parsed.error.flatten() });
      }

      const board = boardRepo.getBoardById(params.id);
      if (!board) {
        throw notFound('Board not found', 'BOARD_NOT_FOUND');
      }

      const current = board.prioritizationSettings ?? prioritizationService.getDefaultPrioritizationSettings();
      const updated: PrioritizationSettings = {
        ...current,
        ...parsed.data,
        rules: parsed.data.rules ? (parsed.data.rules as unknown as PrioritizationSettings['rules']) : current.rules,
      };

      boardRepo.updateBoard(params.id, { prioritizationSettings: updated });
      return { rules: updated };
    }
  );

  fastify.post(
    '/boards/:id/rules/evaluate',
    { preHandler: [humanAuth, requireBoardAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const result = prioritizationService.applyPrioritization(params.id);
      return { evaluation: result };
    }
  );

  fastify.get(
    '/boards/:id/priority-report',
    { preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const query = request.query as { limit?: string };
      const limit = Math.min(
        Math.max(parseInt(query.limit ?? '', 10) || PRIORITY_REPORT_DEFAULT_LIMIT, 1),
        PRIORITY_REPORT_MAX_LIMIT,
      );

      const { tasks: boardTasks } = taskRepo.getTasksByBoardId(params.id, { limit });

      const distribution: Record<string, number> = {};
      for (const task of boardTasks) {
        distribution[task.priority] = (distribution[task.priority] ?? 0) + 1;
      }

      const evaluations = prioritizationService.evaluateRules(params.id);
      const ruleHits: Record<string, number> = {};
      for (const ev of evaluations) {
        ruleHits[ev.ruleName] = (ruleHits[ev.ruleName] ?? 0) + 1;
      }

      return {
        boardId: params.id,
        totalTasks: boardTasks.length,
        distribution,
        ruleHits,
        lastEvaluatedAt: new Date().toISOString(),
      };
    }
  );
}
