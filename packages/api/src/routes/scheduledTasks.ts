import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { requireHabitatAccess } from '../middleware/team.js';
import * as scheduledTaskRepo from '../repositories/scheduledTask.js';
import * as scheduledTaskService from '../services/scheduledTaskService.js';
import { notFound, forbidden, unauthorized } from '../errors.js';
import { getHabitatById } from '../repositories/habitat.js';
import { isTeamMemberByHabitatId } from '../repositories/teamMember.js';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";

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

type ScheduleConfiguration = Pick<scheduledTaskRepo.CreateScheduledTaskInput,
  'scheduleType' | 'cronExpression' | 'intervalMinutes' | 'scheduledAt' | 'timezone'>;

/** Validate schedule semantics independently of a first-run override. */
function validateScheduleConfiguration(schedule: ScheduleConfiguration): string | null {
  try {
    new Intl.DateTimeFormat('en', { timeZone: schedule.timezone ?? 'UTC' });
  } catch {
    return 'Invalid timezone';
  }
  if (schedule.scheduleType === 'once' && schedule.scheduledAt == null) {
    return 'scheduledAt is required for one-time schedules';
  }
  if (schedule.scheduledAt != null &&
      (!schedule.scheduledAt.trim() || !Number.isFinite(new Date(schedule.scheduledAt).getTime()))) {
    return 'scheduledAt must be a valid nonempty date';
  }
  if (schedule.scheduleType === 'interval') {
    const minutes = schedule.intervalMinutes;
    if (minutes == null || !Number.isSafeInteger(minutes) || minutes < 1 ||
        !Number.isFinite(new Date(Date.now() + minutes * 60_000).getTime())) {
      return 'intervalMinutes must be a positive safe integer with a representable next run';
    }
  }
  if (schedule.scheduleType === 'cron') {
    if (!schedule.cronExpression?.trim()) return 'cronExpression is required for cron schedules';
    try {
      CronExpressionParser.parse(schedule.cronExpression, { tz: schedule.timezone ?? 'UTC' }).next();
    } catch {
      return 'Invalid cronExpression or timezone';
    }
  }
  return null;
}

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
  applyDeclaredAuthPolicies(fastify);

  fastify.post(
    '/habitats/:habitatId/scheduled-tasks',
    { preHandler: [requireHabitatAccess], config: { authPolicy: "human" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const parsed = createScheduledTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid payload', details: parsed.error.flatten() });
      }

      const body = parsed.data;
      const scheduleError = validateScheduleConfiguration(body);
      if (scheduleError) {
        return reply.status(400).send({ error: 'Invalid schedule configuration', details: scheduleError });
      }
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
    { preHandler: [requireHabitatAccess], config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest) => {
      const params = request.params as { habitatId: string };
      const tasks = scheduledTaskRepo.getScheduledTasksByHabitatId(params.habitatId);
      return { scheduledTasks: tasks };
    }
  );

  fastify.get(
    '/scheduled-tasks/:id',
    { config: { authPolicy: "local_actor" } },
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
    { config: { authPolicy: "human" } },
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

      // Spread only supplied fields: explicit null clears, absent fields inherit.
      const effective = { ...existing, ...parsed.data };
      const scheduleError = validateScheduleConfiguration(effective);
      if (scheduleError) {
        return reply.status(400).send({ error: 'Invalid schedule configuration', details: scheduleError });
      }

      const updated = scheduledTaskRepo.updateScheduledTask(params.id, {
        ...parsed.data,
        ...(parsed.data.scheduleType || parsed.data.cronExpression || parsed.data.intervalMinutes || parsed.data.timezone
          ? {
              nextRunAt: scheduledTaskService.calculateNextRun(
                effective.scheduleType,
                effective.cronExpression,
                effective.intervalMinutes,
                effective.timezone,
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
    { config: { authPolicy: "human" } },
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
    { config: { authPolicy: "human" } },
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
    { config: { authPolicy: "human" } },
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
    { config: { authPolicy: "human" } },
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
