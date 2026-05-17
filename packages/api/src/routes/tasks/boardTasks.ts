import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getTasksByBoardId } from '../../repositories/task.js';
import type { TaskSortField } from '../../repositories/task.js';
import { agentOrHumanAuth } from '../../middleware/auth.js';
import { requireBoardAccess } from '../../middleware/team.js';

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

const boardTasksQuerySchema = z.object({
  status: z.enum(['pending', 'claimed', 'in_progress', 'submitted', 'approved', 'rejected', 'done', 'failed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  search: z.string().optional(),
  assignedAgentId: z.string().optional(),
  isArchived: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: z.enum(['priority', 'title', 'status', 'createdAt', 'updatedAt', 'assignedAgentId', 'estimatedMinutes']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

export async function boardTasksRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/tasks',
    {
      schema: { params: habitatIdParamsSchema, querystring: boardTasksQuerySchema },
      preHandler: [agentOrHumanAuth, requireBoardAccess],
    },
    async (request, reply) => {
      const { habitatId } = request.params;
      const query = request.query;

      const sortBy = query.sortBy as TaskSortField | undefined;
      const sortDirection = query.sortDir;

      const assignedAgentId = query.assignedAgentId === '' ? null : query.assignedAgentId;

      const result = getTasksByBoardId(habitatId, {
        status: query.status,
        priority: query.priority,
        search: query.search,
        assignedAgentId,
        isArchived: query.isArchived,
        limit: query.limit,
        offset: query.offset,
        sortBy,
        sortDirection,
      });

      return { tasks: result.tasks, total: result.total };
    }
  );
}
