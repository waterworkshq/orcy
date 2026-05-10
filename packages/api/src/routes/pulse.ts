import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as pulseRepo from '../repositories/pulse.js';
import * as agentRepo from '../repositories/agent.js';
import * as featureRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as taskService from '../services/tasks/index.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

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
        reply.code(400).send({ error: 'Missing required fields: signalType, subject' });
        return;
      }

      if (!VALID_SIGNAL_TYPES.includes(body.signalType as any)) {
        reply.code(400).send({ error: `Invalid signalType. Must be one of: ${VALID_SIGNAL_TYPES.join(', ')}` });
        return;
      }

      const mission = featureRepo.getFeatureById(missionId);
      if (!mission) {
        reply.code(404).send({ error: 'Mission not found' });
        return;
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }

      let toType: 'human' | 'agent' | undefined;
      let toId: string | undefined;

      if (body.toAgentId) {
        toType = 'agent';
        toId = body.toAgentId;
      } else if (body.toAgentName) {
        const resolved = resolveAgentName(body.toAgentName);
        if (!resolved) {
          reply.code(404).send({ error: `Agent not found: ${body.toAgentName}` });
          return;
        }
        toType = 'agent';
        toId = resolved;
      }

      if (body.replyToId) {
        const parent = pulseRepo.getPulseById(body.replyToId);
        if (!parent) {
          reply.code(404).send({ error: 'Reply target pulse not found' });
          return;
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
        reply.code(404).send({ error: 'Mission not found' });
        return;
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
        reply.code(404).send({ error: 'Mission not found' });
        return;
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
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
        reply.code(401).send({ error: 'Authentication required' });
        return;
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
        reply.code(404).send({ error: 'Pulse not found' });
        return;
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }

      if (pulse.fromId !== caller.id) {
        reply.code(403).send({ error: 'Only the author can delete a signal' });
        return;
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
        reply.code(404).send({ error: 'Pulse not found' });
        return;
      }

      return { replies: pulseRepo.getReplies(id) };
    }
  );
}
