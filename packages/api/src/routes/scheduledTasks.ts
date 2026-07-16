import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { humanAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { requireHabitatAccess } from '../middleware/team.js';
import * as scheduledTaskRepo from '../repositories/scheduledTask.js';
import * as scheduledTaskService from '../services/scheduledTaskService.js';
import { notFound, forbidden, unauthorized } from '../errors.js';
import { getHabitatById } from '../repositories/habitat.js';
import { isTeamMemberByHabitatId } from '../repositories/teamMember.js';

const createScheduledTaskSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  templateId: z.string().optional().nullable(),
  scheduleType: z.enum(['once', 'interval', 'cron']),
  cronExpression: z.string().optional().nullable(),
  intervalMinutes: z.number().int().min(1).optional().nullable(),
  scheduledAt: z.string().optional().nullable(),
  timezone: z.string().optional(),
  missionTitle: z.string().min(1),
  missionDescription: z.string().optional(),
  missionPriority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  missionLabels: z.array(z.string()).optional(),
  missionDomain: z.string().optional().nullable(),
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
  missionTitle: z.string().min(1).optional(),
  missionDescription: z.string().optional(),
  missionPriority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  missionLabels: z.array(z.string()).optional(),
  missionDomain: z.string().optional().nullable(),
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

function verifyTaskHabitatAccess(request: FastifyRequest, habitatId: string): void {
  const habitat = getHabitatById(habitatId);
  if (!habitat) {
    throw notFound('Habitat not found');
  }

  if (request.agent) {
    if (!habitat.teamId) return;
    throw forbidden('Agents cannot access team habitats', 'BOARD_ACCESS_DENIED');
  }

  if (request.user) {
    if (!habitat.teamId) return;
    const isMember = isTeamMemberByHabitatId(habitatId, request.user.id);
    if (isMember) return;
    throw forbidden('You do not have access to this habitat', 'BOARD_ACCESS_DENIED');
  }

  throw unauthorized('Authentication required');
}

export async function scheduledTaskRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/habitats/:habitatId/scheduled-tasks',
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
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
        habitatId: params.habitatId,
        templateId: body.templateId ?? null,
        name: body.name,
        description: body.description,
        scheduleType: body.scheduleType,
        cronExpression: body.cronExpression ?? null,
        intervalMinutes: body.intervalMinutes ?? null,
        scheduledAt: body.scheduledAt ?? null,
        timezone: body.timezone,
        missionTitle: body.missionTitle,
        missionDescription: body.missionDescription,
        missionPriority: body.missionPriority,
        missionLabels: body.missionLabels,
        missionDomain: body.missionDomain ?? null,
        tasksTemplate: body.tasksTemplate,
        nextRunAt,
        createdBy: getUserId(request),
      });

      return reply.status(201).send({ scheduledTask: schedule });
    }
  );

  fastify.get(
    '/habitats/:habitatId/scheduled-tasks',
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request: FastifyRequest) => {
      const params = request.params as { habitatId: string };
      const tasks = scheduledTaskRepo.getScheduledTasksByHabitatId(params.habitatId);
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
      verifyTaskHabitatAccess(request, schedule.habitatId);
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
      verifyTaskHabitatAccess(request, existing.habitatId);

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
      verifyTaskHabitatAccess(request, existing.habitatId);

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
      verifyTaskHabitatAccess(request, schedule.habitatId);
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
      verifyTaskHabitatAccess(request, existing.habitatId);

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
      verifyTaskHabitatAccess(request, existing.habitatId);

      const updated = scheduledTaskRepo.updateScheduledTask(params.id, { enabled: false });
      if (!updated) {
        throw notFound('Scheduled task not found', 'SCHEDULED_TASK_NOT_FOUND');
      }
      return { scheduledTask: updated };
    }
  );
}
