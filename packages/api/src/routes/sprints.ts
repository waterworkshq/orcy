import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as sprintService from '../services/sprintService.js';
import { agentOrHumanAuth, humanAuth } from '../middleware/auth.js';
import { badRequest, notFound } from '../errors.js';
import { z } from 'zod';

const createSprintSchema = z.object({
  name: z.string().min(1).max(200),
  goal: z.string().max(2000).optional(),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  capacityMinutes: z.number().int().nullable().optional(),
  notes: z.string().max(5000).optional(),
});

const updateSprintSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  goal: z.string().max(2000).optional(),
  startDate: z.string().min(1).optional(),
  endDate: z.string().min(1).optional(),
  capacityMinutes: z.number().int().nullable().optional(),
  notes: z.string().max(5000).optional(),
});

const addMissionSchema = z.object({
  missionId: z.string().min(1),
});

export async function sprintRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/sprints',
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const sprints = sprintService.getSprintsForHabitat(request.params.habitatId);
      return { sprints };
    }
  );

  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/sprints/active',
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const sprint = sprintService.getActiveSprint(request.params.habitatId);
      if (!sprint) return { sprint: null };
      return { sprint };
    }
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createSprintSchema> }>(
    '/habitats/:habitatId/sprints',
    { preHandler: humanAuth },
    async (request, reply) => {
      const parsed = createSprintSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const userId = request.user?.id ?? 'unknown';
      try {
        const sprint = sprintService.createSprint(request.params.habitatId, parsed.data, userId);
        reply.code(201).send({ sprint });
      } catch (err: any) {
        if (err.message === 'HABITAT_ALREADY_HAS_ACTIVE_SPRINT') {
          throw badRequest('Habitat already has an active sprint');
        }
        throw err;
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/sprints/:id',
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const sprint = sprintService.getSprint(request.params.id);
      if (!sprint) throw notFound('Sprint not found');
      return { sprint };
    }
  );

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateSprintSchema> }>(
    '/sprints/:id',
    { preHandler: humanAuth },
    async (request) => {
      const parsed = updateSprintSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      try {
        const sprint = sprintService.updateSprint(request.params.id, parsed.data);
        return { sprint };
      } catch (err: any) {
        if (err.message === 'SPRINT_NOT_FOUND') throw notFound('Sprint not found');
        if (err.message === 'CANNOT_MODIFY_ACTIVE_OR_COMPLETED_SPRINT') {
          throw badRequest('Cannot modify name or dates of an active or completed sprint');
        }
        throw err;
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/sprints/:id',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        sprintService.deleteSprint(request.params.id);
        reply.code(204).send();
      } catch (err: any) {
        if (err.message === 'SPRINT_NOT_FOUND') throw notFound('Sprint not found');
        if (err.message === 'CANNOT_DELETE_ACTIVE_SPRINT') {
          throw badRequest('Cannot delete an active sprint');
        }
        throw err;
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/sprints/:id/start',
    { preHandler: humanAuth },
    async (request) => {
      try {
        const sprint = sprintService.startSprint(request.params.id);
        return { sprint };
      } catch (err: any) {
        if (err.message === 'SPRINT_NOT_FOUND') throw notFound('Sprint not found');
        if (err.message === 'SPRINT_NOT_IN_PLANNING') {
          throw badRequest('Sprint is not in planning status');
        }
        throw err;
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/sprints/:id/complete',
    { preHandler: humanAuth },
    async (request) => {
      try {
        const sprint = sprintService.completeSprint(request.params.id);
        return { sprint };
      } catch (err: any) {
        if (err.message === 'SPRINT_NOT_FOUND') throw notFound('Sprint not found');
        if (err.message === 'SPRINT_NOT_ACTIVE') {
          throw badRequest('Sprint is not active');
        }
        throw err;
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/sprints/:id/cancel',
    { preHandler: humanAuth },
    async (request) => {
      try {
        const sprint = sprintService.cancelSprint(request.params.id);
        return { sprint };
      } catch (err: any) {
        if (err.message === 'SPRINT_NOT_FOUND') throw notFound('Sprint not found');
        if (err.message === 'SPRINT_CANNOT_BE_CANCELLED') {
          throw badRequest('Sprint cannot be cancelled');
        }
        throw err;
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: z.infer<typeof addMissionSchema> }>(
    '/sprints/:id/missions',
    { preHandler: humanAuth },
    async (request) => {
      const parsed = addMissionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      try {
        const sprint = sprintService.addMissionToSprint(request.params.id, parsed.data.missionId);
        return { sprint };
      } catch (err: any) {
        if (err.message === 'SPRINT_NOT_FOUND') throw notFound('Sprint not found');
        if (err.message === 'MISSION_NOT_FOUND') throw notFound('Mission not found');
        if (err.message === 'MISSION_NOT_IN_SAME_HABITAT') {
          throw badRequest('Mission does not belong to the same habitat as the sprint');
        }
        if (err.message === 'CAN_ONLY_ADD_TO_PLANNING_SPRINT') {
          throw badRequest('Can only add missions to a planning sprint');
        }
        throw err;
      }
    }
  );

  fastify.delete<{ Params: { id: string; missionId: string } }>(
    '/sprints/:id/missions/:missionId',
    { preHandler: humanAuth },
    async (request) => {
      try {
        const sprint = sprintService.removeMissionFromSprint(request.params.id, request.params.missionId);
        return { sprint };
      } catch (err: any) {
        if (err.message === 'SPRINT_NOT_FOUND') throw notFound('Sprint not found');
        if (err.message === 'CAN_ONLY_REMOVE_FROM_PLANNING_SPRINT') {
          throw badRequest('Can only remove missions from a planning sprint');
        }
        throw err;
      }
    }
  );
}
