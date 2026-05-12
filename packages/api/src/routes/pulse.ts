import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as pulseRepo from '../repositories/pulse.js';
import * as reactionRepo from '../repositories/pulseReaction.js';
import * as agentRepo from '../repositories/agent.js';
import * as featureRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as taskService from '../services/tasks/index.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { badRequest, unauthorized, notFound, forbidden } from '../errors.js';

function resolveAgentName(name: string): string | null {
  const agent = agentRepo.getAgentByName(name);
  return agent?.id ?? null;
}

function getCallerInfo(request: FastifyRequest): { type: 'human' | 'agent'; id: string } | null {
  if (request.agent) return { type: 'agent', id: request.agent.id };
  if (request.user) return { type: 'human', id: request.user.id };
  return null;
}

const VALID_SIGNAL_TYPES = ['finding', 'blocker', 'offer', 'warning', 'question', 'answer', 'directive', 'context', 'handoff'] as const;

export async function pulseRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/missions/:missionId/pulse',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { missionId } = (request.params as { missionId: string });
      const body = request.body as { signalType?: string; subject?: string; body?: string; taskId?: string; toAgentId?: string; toAgentName?: string; replyToId?: string; metadata?: Record<string, unknown> };

      if (!body.signalType || !body.subject) {
        throw badRequest('Missing required fields: signalType, subject');
      }

      if (!VALID_SIGNAL_TYPES.includes(body.signalType as any)) {
        throw badRequest(`Invalid signalType. Must be one of: ${VALID_SIGNAL_TYPES.join(', ')}`);
      }

      const mission = featureRepo.getFeatureById(missionId);
      if (!mission) {
        throw notFound('Mission not found');
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      let toType: 'human' | 'agent' | undefined;
      let toId: string | undefined;

      if (body.toAgentId) {
        toType = 'agent';
        toId = body.toAgentId;
      } else if (body.toAgentName) {
        const resolved = resolveAgentName(body.toAgentName);
        if (!resolved) {
          throw notFound(`Agent not found: ${body.toAgentName}`);
        }
        toType = 'agent';
        toId = resolved;
      }

      if (body.replyToId) {
        const parent = pulseRepo.getPulseById(body.replyToId);
        if (!parent) {
          throw notFound('Reply target pulse not found');
        }
      }

      const pulse = pulseRepo.createPulse({
        missionId,
        boardId: mission.boardId,
        fromType: caller.type,
        fromId: caller.id,
        toType,
        toId,
        signalType: body.signalType as pulseRepo.SignalType,
        subject: body.subject,
        body: body.body ?? '',
        taskId: body.taskId ?? undefined,
        replyToId: body.replyToId ?? undefined,
        metadata: body.metadata ?? undefined,
      });

      let linkedTask: ReturnType<typeof taskRepo.getTaskById> = null;

      if (body.signalType === 'blocker' && !mission.isArchived) {
        try {
          const task = taskService.createTask({
            featureId: missionId,
            title: `Clear Blocker: ${body.subject}`,
            description: `Auto-generated blocker clearance task.\n\nBlocker: ${body.body ?? ''}\n\nSource signal: ${pulse.id}${body.taskId ? `\nBlocked task: ${body.taskId}` : ''}`,
            priority: 'high',
            labels: ['blocker-clearance'],
            createdBy: 'system',
          });

          pulseRepo.updateLinkedTask(pulse.id, task.id);
          linkedTask = taskRepo.getTaskById(task.id);
        } catch (err) {
          logger.error({ err, missionId, pulseId: pulse.id }, 'Failed to create blocker clearance task');
        }
      }

      try {
        sseBroadcaster.publish(pulse.boardId, {
          type: 'pulse.signal_posted',
          data: {
            pulseId: pulse.id,
            missionId: pulse.missionId,
            signalType: pulse.signalType,
            fromType: pulse.fromType,
            fromId: pulse.fromId,
            subject: pulse.subject,
          },
        });
      } catch { /* SSE failure should not break signal creation */ }

      reply.code(201).send({ pulse, linkedTask: linkedTask ?? undefined });
    }
  );

  fastify.get(
    '/missions/:missionId/pulse',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { missionId } = (request.params as { missionId: string });
      const query = request.query as { signalType?: string; isAuto?: string; since?: string; limit?: string; offset?: string };

      const mission = featureRepo.getFeatureById(missionId);
      if (!mission) {
        throw notFound('Mission not found');
      }

      return pulseRepo.getPulsesByMission(missionId, {
        signalType: query.signalType as pulseRepo.SignalType | undefined,
        isAuto: query.isAuto !== undefined ? query.isAuto === 'true' : undefined,
        since: query.since,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });
    }
  );

  fastify.get(
    '/missions/:missionId/pulse/digest',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { missionId } = (request.params as { missionId: string });

      const mission = featureRepo.getFeatureById(missionId);
      if (!mission) {
        throw notFound('Mission not found');
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      return pulseRepo.getPulseDigest(missionId, caller.type, caller.id);
    }
  );

  fastify.get(
    '/pulse/inbox',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const query = request.query as { signalType?: string; limit?: string; offset?: string };

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      return pulseRepo.getPulsesByTarget(caller.type, caller.id, {
        signalType: query.signalType as pulseRepo.SignalType | undefined,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });
    }
  );

  fastify.delete(
    '/pulse/:id',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { id } = (request.params as { id: string });

      const pulse = pulseRepo.getPulseById(id);
      if (!pulse) {
        throw notFound('Pulse not found');
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      if (pulse.fromId !== caller.id) {
        throw forbidden('Only the author can delete a signal');
      }

      pulseRepo.deletePulse(id);
      reply.code(204).send();
    }
  );

  fastify.get(
    '/pulse/:id/replies',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { id } = (request.params as { id: string });

      const pulse = pulseRepo.getPulseById(id);
      if (!pulse) {
        throw notFound('Pulse not found');
      }

      return { replies: pulseRepo.getReplies(id) };
    }
  );

  fastify.post(
    '/boards/:boardId/pulse',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { boardId } = (request.params as { boardId: string });
      const body = request.body as { signalType?: string; subject?: string; body?: string; taskId?: string; toAgentId?: string; toAgentName?: string; replyToId?: string; metadata?: Record<string, unknown> };

      if (!body.signalType || !body.subject) {
        throw badRequest('Missing required fields: signalType, subject');
      }

      if (!VALID_SIGNAL_TYPES.includes(body.signalType as any)) {
        throw badRequest(`Invalid signalType. Must be one of: ${VALID_SIGNAL_TYPES.join(', ')}`);
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      let toType: 'human' | 'agent' | undefined;
      let toId: string | undefined;

      if (body.toAgentId) {
        toType = 'agent';
        toId = body.toAgentId;
      } else if (body.toAgentName) {
        const resolved = resolveAgentName(body.toAgentName);
        if (!resolved) {
          throw notFound(`Agent not found: ${body.toAgentName}`);
        }
        toType = 'agent';
        toId = resolved;
      }

      if (body.replyToId) {
        const parent = pulseRepo.getPulseById(body.replyToId);
        if (!parent) {
          throw notFound('Reply target pulse not found');
        }
      }

      const pulse = pulseRepo.createPulse({
        boardId,
        scope: 'habitat',
        fromType: caller.type,
        fromId: caller.id,
        toType,
        toId,
        signalType: body.signalType as pulseRepo.SignalType,
        subject: body.subject,
        body: body.body ?? '',
        taskId: body.taskId ?? undefined,
        replyToId: body.replyToId ?? undefined,
        metadata: body.metadata ?? undefined,
      });

      try {
        sseBroadcaster.publish(boardId, {
          type: 'pulse.signal_posted',
          data: {
            pulseId: pulse.id,
            missionId: pulse.missionId,
            signalType: pulse.signalType,
            fromType: pulse.fromType,
            fromId: pulse.fromId,
            subject: pulse.subject,
          },
        });
      } catch { /* SSE failure should not break signal creation */ }

      reply.code(201).send({ pulse });
    }
  );

  fastify.get(
    '/boards/:boardId/pulse',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { boardId } = (request.params as { boardId: string });
      const query = request.query as { signalType?: string; scope?: string; limit?: string; offset?: string };

      return pulseRepo.getPulsesByBoard(boardId, {
        signalType: query.signalType as pulseRepo.SignalType | undefined,
        scope: query.scope as pulseRepo.PulseScope | undefined,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });
    }
  );

  fastify.get(
    '/boards/:boardId/pulse/digest',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { boardId } = (request.params as { boardId: string });

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      return pulseRepo.getHabitatPulseDigest(boardId, caller.type, caller.id);
    }
  );

  fastify.post(
    '/pulse/:id/react',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { id } = (request.params as { id: string });
      const body = request.body as { reaction?: string };

      if (!body.reaction) {
        throw badRequest('Missing required field: reaction');
      }

      const validReactions = ['seen', 'ack', 'question'];
      if (!validReactions.includes(body.reaction)) {
        throw badRequest(`Invalid reaction. Must be one of: ${validReactions.join(', ')}`);
      }

      const pulse = pulseRepo.getPulseById(id);
      if (!pulse) {
        throw notFound('Pulse not found');
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized('Authentication required');
      }

      const result = reactionRepo.toggleReaction({
        pulseId: id,
        reactorType: caller.type,
        reactorId: caller.id,
        reaction: body.reaction as reactionRepo.ReactionType,
      });

      const counts = reactionRepo.getReactionCounts(id);

      reply.code(200).send({ ...result, counts });
    }
  );
}
