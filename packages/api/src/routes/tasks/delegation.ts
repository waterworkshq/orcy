import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as taskService from '../../services/tasks/index.js';
import { delegateTaskSchema } from '../../models/schemas.js';
import { agentAuth } from '../../middleware/auth.js';
import { badRequest, notFound, forbidden, conflict } from '../../errors.js';

const taskParamsSchema = z.object({ id: z.string() });

function delegateErrorToStatus(reason: string): number {
  if (reason === 'not_found') return 404;
  if (reason === 'capability_mismatch' || reason === 'domain_mismatch') return 403;
  return 409;
}

export async function taskDelegationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/delegate',
    { schema: { params: taskParamsSchema, body: delegateTaskSchema }, preHandler: [agentAuth] },
    async (request, _reply) => {
      const parsed = request.body;
      const fromAgentId = request.agent?.id ?? (request.body as { agentId?: string })?.agentId ?? request.user?.id;
      if (!fromAgentId) {
        throw badRequest('Agent ID required');
      }

      const result = taskService.delegateTask(
        request.params.id,
        fromAgentId,
        parsed.toAgentId,
        parsed.reason
      );

      if (!result.success) {
        const statusCode = delegateErrorToStatus(result.reason);
        if (statusCode === 404) throw notFound(result.reason, { message: result.message });
        if (statusCode === 403) throw forbidden(result.reason, undefined, { message: result.message });
        throw conflict(result.reason, { message: result.message });
      }

      return { task: result.task };
    }
  );
}

export { delegateErrorToStatus };
