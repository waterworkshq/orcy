import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as taskService from '../../services/tasks/index.js';
import * as agentService from '../../services/agentService.js';
import { delegateTaskSchema } from '../../models/schemas.js';
import type { DelegateTaskInput } from '../../models/schemas.js';
import { agentAuth } from '../../middleware/auth.js';

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
    async (request, reply) => {
      const parsed = request.body;
      const fromAgentId = request.agent?.id ?? (request.body as { agentId?: string })?.agentId ?? request.user?.id;
      if (!fromAgentId) {
        reply.code(400).send({ error: 'Agent ID required' });
        return;
      }

      const result = taskService.delegateTask(
        request.params.id,
        fromAgentId,
        parsed.toAgentId,
        parsed.reason
      );

      if (!result.success) {
        const statusCode = delegateErrorToStatus(result.reason);
        reply.code(statusCode).send({ error: result.reason, message: result.message });
        return;
      }

      return { task: result.task };
    }
  );
}

export { delegateErrorToStatus };
