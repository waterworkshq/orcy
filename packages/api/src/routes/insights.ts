import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as insightRepo from '../repositories/insight.js';
import * as pulseRepo from '../repositories/pulse.js';
import * as featureRepo from '../repositories/feature.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { badRequest, notFound, unauthorized } from '../errors.js';

function getCallerInfo(request: FastifyRequest): { type: 'human' | 'agent'; id: string } | null {
  if (request.agent) return { type: 'agent', id: request.agent.id };
  if (request.user) return { type: 'human', id: request.user.id };
  return null;
}

const VALID_SIGNAL_TYPES = ['finding', 'blocker', 'offer', 'warning', 'question', 'answer', 'directive', 'context', 'handoff'] as const;

export async function insightsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/boards/:boardId/insights',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { boardId } = (request.params as { boardId: string });
      const body = request.body as { sourcePulseId?: string; relevanceTags?: string[]; subject?: string; body?: string };

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      if (!body.sourcePulseId) {
        throw badRequest('Missing required field: sourcePulseId');
      }

      const sourcePulse = pulseRepo.getPulseById(body.sourcePulseId);
      if (!sourcePulse) {
        throw notFound('Source pulse not found');
      }

      if (sourcePulse.boardId !== boardId) {
        throw badRequest('Source pulse does not belong to this board');
      }

      let sourceMission: string | undefined;
      if (sourcePulse.missionId) {
        const mission = featureRepo.getFeatureById(sourcePulse.missionId);
        sourceMission = mission?.title;
      }

      const insight = insightRepo.createInsight({
        boardId,
        sourcePulseId: body.sourcePulseId,
        sourceMission,
        signalType: sourcePulse.signalType,
        subject: body.subject ?? sourcePulse.subject,
        body: body.body ?? sourcePulse.body,
        relevanceTags: body.relevanceTags ?? [],
        promotedBy: caller.id,
      });

      reply.code(201).send({ insight });
    }
  );

  fastify.get(
    '/boards/:boardId/insights',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { boardId } = (request.params as { boardId: string });
      const query = request.query as { signalType?: string; isActive?: string; limit?: string; offset?: string };

      return insightRepo.getInsightsByBoard(boardId, {
        signalType: query.signalType as pulseRepo.SignalType | undefined,
        isActive: query.isActive !== undefined ? query.isActive === 'true' : undefined,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });
    }
  );

  fastify.delete(
    '/boards/:boardId/insights/:id',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { id } = (request.params as { id: string });

      const insight = insightRepo.getInsightById(id);
      if (!insight) {
        throw notFound('Insight not found');
      }

      insightRepo.deactivateInsight(id);
      reply.code(200).send({ success: true });
    }
  );
}
