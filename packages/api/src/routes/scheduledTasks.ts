import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { humanAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { requireBoardAccess } from '../middleware/team.js';
import * as scheduledTaskRepo from '../repositories/scheduledTask.js';
import * as scheduledTaskService from '../services/scheduledTaskService.js';
import { notFound, forbidden, unauthorized } from '../errors.js';
import { getBoardById } from '../repositories/board.js';
import { isTeamMemberByBoardId } from '../repositories/teamMember.js';

const createScheduledTaskSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  templateId: z.string().optional().nullable(),
  scheduleType: z.enum(['once', 'interval', 'cron']),
  cronExpression: z.string().optional().nullable(),
  intervalMinutes: z.number().int().min(1).optional().nullable(),
  scheduledAt: z.string().optional().nullable(),
  timezone: z.string().optional(),
  featureTitle: z.string().min(1),
  featureDescription: z.string().optional(),
  featurePriority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  featureLabels: z.array(z.string()).optional(),
  featureDomain: z.string().optional().nullable(),
  tasksTemplate: z.array(z.object({
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    requiredDomain: z.string().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    estimatedMinutes: z.number().optional(),
    order: z.number().optional(),
  })).optional(),
});

const updateScheduledTaskSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  scheduleType: z.enum(['once', 'interval', 'cron']).optional(),
  cronExpression: z.string().optional().nullable(),
  intervalMinutes: z.number().int().min(1).optional().nullable(),
  scheduledAt: z.string().optional().nullable(),
  timezone: z.string().optional(),
  featureTitle: z.string().min(1).optional(),
  featureDescription: z.string().optional(),
  featurePriority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  featureLabels: z.array(z.string()).optional(),
  featureDomain: z.string().optional().nullable(),
  tasksTemplate: z.array(z.object({
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    requiredDomain: z.string().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    estimatedMinutes: z.number().optional(),
    order: z.number().optional(),
  })).optional(),
  enabled: z.boolean().optional(),
});

function getUserId(request: FastifyRequest): string {
  if (request.user) return request.user.id;
  if (request.agent) return request.agent.id;
  return 'unknown';
}

function verifyTaskBoardAccess(request: FastifyRequest, boardId: string): void {
  const board = getBoardById(boardId);
  if (!board) {
    throw notFound('Board not found');
  }

  if (request.agent) return;

  if (request.user) {
    if (!board.teamId) return;
    const isMember = isTeamMemberByBoardId(boardId, request.user.id);
    if (isMember) return;
    throw forbidden('You do not have access to this board', 'BOARD_ACCESS_DENIED');
  }

  throw unauthorized('Authentication required');
}

export async function scheduledTaskRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/boards/:id/scheduled-tasks',
    { preHandler: [humanAuth, requireBoardAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const parsed = createScheduledTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid payload', details: parsed.error.flatten() });
      }

      const body = parsed.data;
      const nextRunAt = body.scheduledAt ?? scheduledTaskService.calculateNextRun(
        body.scheduleType,
        body.cronExpression ?? null,
        body.intervalMinutes ?? null,
        body.timezone,
      );

      const schedule = scheduledTaskRepo.createScheduledTask({
        boardId: params.id,
        templateId: body.templateId ?? null,
        name: body.name,
        description: body.description,
        scheduleType: body.scheduleType,
        cronExpression: body.cronExpression ?? null,
        intervalMinutes: body.intervalMinutes ?? null,
        scheduledAt: body.scheduledAt ?? null,
        timezone: body.timezone,
        featureTitle: body.featureTitle,
        featureDescription: body.featureDescription,
        featurePriority: body.featurePriority,
        featureLabels: body.featureLabels,
        featureDomain: body.featureDomain ?? null,
        tasksTemplate: body.tasksTemplate,
        nextRunAt,
        createdBy: getUserId(request),
      });

      return reply.status(201).send({ scheduledTask: schedule });
    }
  );

  fastify.get(
    '/boards/:id/scheduled-tasks',
    { preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request: FastifyRequest) => {
      const params = request.params as { id: string };
      const tasks = scheduledTaskRepo.getScheduledTasksByBoardId(params.id);
      return { scheduledTasks: tasks };
    }
  );

  fastify.get(
    '/scheduled-tasks/:id',
    { preHandler: [agentOrHumanAuth] },
    async (request: FastifyRequest) => {
      const params = request.params as { id: string };
      const schedule = scheduledTaskRepo.getScheduledTaskById(params.id);
      if (!schedule) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      verifyTaskBoardAccess(request, schedule.boardId);
      return { scheduledTask: schedule };
    }
  );

  fastify.patch(
    '/scheduled-tasks/:id',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const existing = scheduledTaskRepo.getScheduledTaskById(params.id);
      if (!existing) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      verifyTaskBoardAccess(request, existing.boardId);

      const parsed = updateScheduledTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid payload', details: parsed.error.flatten() });
      }

      const updated = scheduledTaskRepo.updateScheduledTask(params.id, {
        ...parsed.data,
        ...(parsed.data.scheduleType || parsed.data.cronExpression || parsed.data.intervalMinutes || parsed.data.timezone
          ? {
              nextRunAt: scheduledTaskService.calculateNextRun(
                parsed.data.scheduleType ?? existing.scheduleType,
                parsed.data.cronExpression ?? existing.cronExpression,
                parsed.data.intervalMinutes ?? existing.intervalMinutes,
                parsed.data.timezone ?? existing.timezone,
              ),
            }
          : {}),
      });

      if (!updated) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      return { scheduledTask: updated };
    }
  );

  fastify.delete(
    '/scheduled-tasks/:id',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const existing = scheduledTaskRepo.getScheduledTaskById(params.id);
      if (!existing) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      verifyTaskBoardAccess(request, existing.boardId);

      const deleted = scheduledTaskRepo.deleteScheduledTask(params.id);
      if (!deleted) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      return reply.status(204).send();
    }
  );

  fastify.post(
    '/scheduled-tasks/:id/run',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest) => {
      const params = request.params as { id: string };
      const schedule = scheduledTaskRepo.getScheduledTaskById(params.id);
      if (!schedule) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      verifyTaskBoardAccess(request, schedule.boardId);
      const result = scheduledTaskService.executeScheduledTask(params.id);
      return result;
    }
  );

  fastify.post(
    '/scheduled-tasks/:id/enable',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest) => {
      const params = request.params as { id: string };
      const existing = scheduledTaskRepo.getScheduledTaskById(params.id);
      if (!existing) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      verifyTaskBoardAccess(request, existing.boardId);

      const updated = scheduledTaskRepo.updateScheduledTask(params.id, {
        enabled: true,
        nextRunAt: scheduledTaskService.calculateNextRun(
          existing.scheduleType,
          existing.cronExpression,
          existing.intervalMinutes,
          existing.timezone,
        ),
      });
      if (!updated) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      return { scheduledTask: updated };
    }
  );

  fastify.post(
    '/scheduled-tasks/:id/disable',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest) => {
      const params = request.params as { id: string };
      const existing = scheduledTaskRepo.getScheduledTaskById(params.id);
      if (!existing) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      verifyTaskBoardAccess(request, existing.boardId);

      const updated = scheduledTaskRepo.updateScheduledTask(params.id, { enabled: false });
      if (!updated) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      return { scheduledTask: updated };
    }
  );
}
