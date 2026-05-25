import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as insightRepo from '../repositories/insight.js';
import * as pulseRepo from '../repositories/pulse.js';
import * as missionRepo from '../repositories/feature.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { badRequest, notFound, unauthorized, forbidden } from '../errors.js';
import { getCallerInfo } from './pulse-shared.js';

function validateIso8601(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (isNaN(parsed)) throw badRequest('Invalid since parameter: must be ISO 8601');
  return new Date(parsed).toISOString();
}

export async function insightsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/habitats/:habitatId/insights',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { habitatId } = (request.params as { habitatId: string });
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

      if (body.subject !== undefined && (typeof body.subject !== 'string' || body.subject.length > 500)) {
        throw badRequest('Subject must be a string up to 500 characters');
      }
      if (body.body !== undefined && typeof body.body !== 'string') {
        throw badRequest('Body must be a string');
      }
      if (body.body !== undefined && body.body.length > 50_000) {
        throw badRequest('Body exceeds maximum length');
      }

      if (sourcePulse.habitatId !== habitatId) {
        throw badRequest('Source pulse does not belong to this habitat');
      }

      let sourceMission: string | undefined;
      if (sourcePulse.missionId) {
        const mission = missionRepo.getMissionById(sourcePulse.missionId);
        sourceMission = mission?.title;
      }

      const insight = insightRepo.createInsight({
        habitatId: habitatId,
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
    '/habitats/:habitatId/insights',
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const { habitatId } = (request.params as { habitatId: string });
      const query = request.query as { signalType?: string; isActive?: string; limit?: string; offset?: string };

      const result = insightRepo.getInsightsByHabitat(habitatId, {
        signalType: query.signalType as pulseRepo.SignalType | undefined,
        isActive: query.isActive !== undefined ? query.isActive === 'true' : undefined,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });

      return { items: result.insights, total: result.total };
    }
  );

  fastify.delete(
    '/habitats/:habitatId/insights/:insightId',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { habitatId, insightId } = (request.params as { habitatId: string; insightId: string });

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      const insight = insightRepo.getInsightById(insightId);
      if (!insight) {
        throw notFound('Insight not found');
      }

      if (insight.habitatId !== habitatId) {
        throw notFound('Insight not found');
      }

      if (insight.promotedBy !== caller.id) {
        throw forbidden('Only the promoter can deactivate an insight');
      }

      insightRepo.deactivateInsight(insightId);
      reply.code(200).send({ success: true });
    }
  );
}
