import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as agentService from '../services/agentService.js';
import { getAgentStats, getAllAgentStats } from '../repositories/event.js';
import {
  createAgentSchema,
  updateAgentSchema,
  heartbeatSchema,
} from '../models/schemas.js';
import type {
  CreateAgentInput,
  UpdateAgentInput,
  HeartbeatInput,
} from '../models/schemas.js';
import { agentAuth, registrationAuth, humanAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import { badRequest, notFound } from '../errors.js';
import { getSuggestionsForAgent } from '../services/taskSuggestion.js';

/**
 * Agent registration, heartbeat, status updates, and per-agent / aggregate stats.
 */
export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /agents - List all registered agents. Auth: agentOrHumanAuth. Returns { agents } */
  fastify.get('/agents', { preHandler: agentOrHumanAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { status?: string; domain?: string; include?: string };
    if (query.include === 'currentTask') {
      const agents = agentService.listAgentsWithTasks(query.status, query.domain);
      return { agents };
    }
    const agents = agentService.listAgents(query.status, query.domain);
    return { agents };
  });

  /** POST /agents - Register a new agent. Auth: registrationAuth. Returns { agent, apiKey } */
  fastify.post<{ Body: CreateAgentInput }>(
    '/agents',
    { preHandler: registrationAuth },
    async (request: FastifyRequest<{ Body: CreateAgentInput }>, reply: FastifyReply) => {
      const parsed = createAgentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const { agent, plainApiKey } = agentService.createAgent(parsed.data);
      reply.code(201).send({ agent, apiKey: plainApiKey });
    }
  );

  /** GET /agents/:id - Get agent details with current task. Auth: agentOrHumanAuth. Returns agent+task or 404 */
  fastify.get<{ Params: { id: string } }>(
    '/agents/:id',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const result = agentService.getAgentWithTask(request.params.id);
      if (!result) {
        throw notFound('Agent not found');
      }
      return result;
    }
  );

  /** PATCH /agents/:id - Update an agent. Auth: humanAuth + adminOnly. Returns { agent } or 404 */
  fastify.patch<{ Params: { id: string }; Body: UpdateAgentInput }>(
    '/agents/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateAgentInput }>, reply: FastifyReply) => {
      const parsed = updateAgentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const agent = agentService.updateAgent(request.params.id, parsed.data);
      if (!agent) {
        throw notFound('Agent not found');
      }
      return { agent };
    }
  );

  /** DELETE /agents/:id - Delete an agent. Auth: humanAuth + adminOnly. Returns 204 */
  fastify.delete<{ Params: { id: string } }>(
    '/agents/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      agentService.deleteAgent(request.params.id);
      reply.code(204).send();
    }
  );

  /** POST /agents/:id/heartbeat - Send agent heartbeat. Auth: agentAuth. Returns heartbeat result or 404 */
  fastify.post<{ Params: { id: string }; Body: HeartbeatInput }>(
    '/agents/:id/heartbeat',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: HeartbeatInput }>, reply: FastifyReply) => {
      const parsed = heartbeatSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const agentId = request.agent?.id ?? request.params.id;
      const result = agentService.heartbeat(agentId, parsed.data.taskId);
      if (!result) {
        throw notFound('Agent not found');
      }
      return result;
    }
  );

  /** GET /agents/:id/stats - Get stats for a specific agent. Auth: agentOrHumanAuth. Returns stats or 404 */
  fastify.get<{ Params: { id: string } }>(
    '/agents/:id/stats',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const stats = getAgentStats(request.params.id);
      if (!stats) {
        throw notFound('Agent not found');
      }
      return stats;
    }
  );

  /** GET /agents/stats - Get aggregate stats across all agents. Auth: agentOrHumanAuth. Returns stats array */
  fastify.get('/agents/stats', { preHandler: agentOrHumanAuth }, async () => {
    return getAllAgentStats();
  });

  /** GET /agents/:id/suggestions - Get task suggestions for an agent. Auth: agentOrHumanAuth. Returns scored suggestions */
  fastify.get<{ Params: { id: string } }>(
    '/agents/:id/suggestions',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const query = request.query as { habitatId?: string; limit?: string };
      if (!query.habitatId) {
        throw badRequest('habitatId query parameter is required');
      }
      const limit = Math.min(Math.max(parseInt(query.limit ?? '5', 10) || 5, 1), 20);
      return getSuggestionsForAgent(query.habitatId, request.params.id, limit);
    }
  );
}
