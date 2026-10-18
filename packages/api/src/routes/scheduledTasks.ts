import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parseScheduledAt, validateScheduleConfiguration } from '../services/scheduledTaskConfiguration.js';
import { editScheduledTask } from '../services/scheduledTaskEditing.js';
import { requireHabitatAccess } from '../middleware/team.js';
import * as scheduledTaskRepo from '../repositories/scheduledTask.js';
import * as scheduledTaskService from '../services/scheduledTaskService.js';
import { notFound, forbidden, unauthorized, badRequest, isAppError } from '../errors.js';
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

const manualRunSchema = z.object({
  expectedScheduledFor: z.string().min(1).refine((value) => value.trim().length > 0 && Number.isFinite(parseScheduledAt(value).getTime()), "Invalid occurrence timestamp").optional(),
}).strict();

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
      // Due pointers are compared as UTC ISO text; retain the submitted scheduledAt separately.
      const nextRunAt = body.scheduledAt != null
        ? parseScheduledAt(body.scheduledAt).toISOString()
        : scheduledTaskService.calculateNextRun(
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

      const updated = editScheduledTask(params.id, parsed.data,
        (schedule) => verifyTaskHabitatAccess(request, schedule.habitatId));
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
      const parsed = manualRunSchema.safeParse(request.body === undefined ? {} : request.body);
      if (!parsed.success) throw badRequest("Invalid manual run payload", parsed.error.flatten());
      try {
        return scheduledTaskService.runScheduledTaskNow(params.id,
          (schedule) => verifyTaskHabitatAccess(request, schedule.habitatId), { ...parsed.data, actorId: request.user!.id });
      } catch (error) {
        // Bodyless legacy clients retain their admission failure envelope.
        // Schema, authority, missing resources and infrastructure keep HTTP errors.
        if (parsed.data.expectedScheduledFor === undefined && isAppError(error) &&
            error instanceof scheduledTaskService.ManualScheduleAdmissionError) {
          return { success: false, error: error.message };
        }
        throw error;
      }
    }
  );

  fastify.post(
    '/scheduled-tasks/:id/enable',
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest) => {
      const params = request.params as { id: string };
      const updated = editScheduledTask(params.id, { enabled: true },
        (schedule) => verifyTaskHabitatAccess(request, schedule.habitatId));
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
