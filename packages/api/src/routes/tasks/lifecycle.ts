import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as taskService from '../../services/tasks/index.js';
import * as taskRepo from '../../repositories/task.js';
import * as retryService from '../../services/retryService.js';
import * as eventRepo from '../../repositories/event.js';
import { sseBroadcaster } from '../../sse/broadcaster.js';
import * as agentService from '../../services/agentService.js';
import {
  claimTaskSchema,
  approveTaskSchema,
  rejectTaskSchema,
  releaseTaskSchema,
  failTaskSchema,
  submitTaskSchema,
  completeTaskSchema,
} from '../../models/schemas.js';
import type {
  ClaimTaskInput,
  ApproveTaskInput,
  RejectTaskInput,
  ReleaseTaskInput,
  FailTaskInput,
  SubmitTaskInput,
  CompleteTaskInput,
} from '../../models/schemas.js';
import { agentAuth, humanAuth } from '../../middleware/auth.js';
import { authorizeTaskAction, getPrincipalFromRequest } from '../../middleware/taskAuth.js';
import type { Task, Artifact } from '../../models/index.js';

const taskParamsSchema = z.object({ id: z.string() });

export async function taskLifecycleRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/claim',
    { schema: { params: taskParamsSchema, body: claimTaskSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const agentId = request.agent!.id;
      if (!request.agent) {
        reply.code(401).send({ error: 'Agent authentication required' });
        return;
      }

      if (task.requiredDomain && request.agent.domain !== task.requiredDomain && request.agent.domain !== 'fullstack') {
        reply.code(403).send({ error: 'Domain mismatch' });
        return;
      }

      if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
        const agentCaps = new Set((request.agent.capabilities || []).map(c => c.toLowerCase()));
        const missing = (task.requiredCapabilities as string[]).filter(c => !agentCaps.has(c.toLowerCase()));
        if (missing.length > 0) {
          reply.code(403).send({ error: 'Capability mismatch', missingCapabilities: missing });
          return;
        }
      }

      if (task.delegatedToAgentId === agentId && (task.status === 'claimed' || task.status === 'in_progress')) {
        const result = taskService.claimDelegatedTask(request.params.id, agentId);
        if (!result.success) {
          reply.code(409).send({ error: result.reason, message: result.message });
          return;
        }
        return { task: result.task };
      }

      const result = taskService.claimTask(request.params.id, agentId);
      if (!result.success) {
        reply.code(409).send({ error: result.reason, missingCapabilities: result.missingCapabilities });
        return;
      }
      return { task: result.task };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/start',
    { schema: { params: taskParamsSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const agentId = request.agent!.id;
      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'start');
      if (!auth.allowed) {
        reply.code(403).send({ error: auth.reason });
        return;
      }

      const result = taskService.startTask(request.params.id, agentId);
      if (!result) {
        reply.code(409).send({ error: 'Cannot start task in current state' });
        return;
      }
      return { task: result };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/approve',
    { schema: { params: taskParamsSchema, body: approveTaskSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'approve');
      if (!auth.allowed) {
        reply.code(403).send({ error: auth.reason });
        return;
      }

      const reviewerId = request.user!.id;
      const approved = taskService.approveTask(request.params.id, reviewerId);

      if (!approved) {
        reply.code(400).send({ error: 'Task cannot be approved in current state' });
        return;
      }
      return { task: approved };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/reject',
    { schema: { params: taskParamsSchema, body: rejectTaskSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'reject');
      if (!auth.allowed) {
        reply.code(403).send({ error: auth.reason });
        return;
      }

      const parsed = request.body;
      const reviewerId = request.user!.id;
      const rejected = taskService.rejectTask(request.params.id, reviewerId, parsed.reason);

      if (!rejected) {
        reply.code(400).send({ error: 'Task cannot be rejected in current state' });
        return;
      }
      return { task: rejected };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/release',
    { schema: { params: taskParamsSchema, body: releaseTaskSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'release');
      if (!auth.allowed) {
        reply.code(403).send({ error: auth.reason });
        return;
      }

      const actorId = request.agent!.id;
      const parsed = request.body;
      const released = taskService.releaseTask(request.params.id, actorId, parsed.reason ?? '');

      if (!released) {
        reply.code(409).send({ error: 'Cannot release task in current state' });
        return;
      }
      return { task: released };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/fail',
    { schema: { params: taskParamsSchema, body: failTaskSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'fail');
      if (!auth.allowed) {
        reply.code(403).send({ error: auth.reason });
        return;
      }

      const agentId = request.agent!.id;
      const parsed = request.body;
      const failed = taskService.failTask(
        request.params.id,
        agentId,
        'agent',
        parsed.reason ?? ''
      );

      if (!failed) {
        reply.code(409).send({ error: 'Cannot fail task in current state' });
        return;
      }
      return { task: failed };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/submit',
    { schema: { params: taskParamsSchema, body: submitTaskSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'submit');
      if (!auth.allowed) {
        reply.code(403).send({ error: auth.reason });
        return;
      }

      const agentId = request.agent!.id;
      const parsed = request.body;

      const submitted = taskService.submitTask(
        request.params.id,
        agentId,
        parsed.result ?? '',
        parsed.artifacts ?? []
      );

      if (!submitted.task) {
        const statusCode = submitted.error === 'QUALITY_GATES_NOT_MET' ? 422 : 409;
        reply.code(statusCode).send({
          error: submitted.error ?? 'Cannot submit task in current state',
          missingQualityItems: submitted.missingQualityItems,
        });
        return;
      }

      return {
        success: true,
        task: {
          id: submitted.task.id,
          status: submitted.task.status,
          submittedAt: submitted.task.submittedAt,
        },
        message: 'Task submitted for review.',
      };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/complete',
    { schema: { params: taskParamsSchema, body: completeTaskSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'complete');
      if (!auth.allowed) {
        reply.code(403).send({ error: auth.reason });
        return;
      }

      const agentId = request.agent!.id;
      const parsed = request.body;

      const result = taskService.completeTask(
        request.params.id,
        agentId,
        parsed.reviewNote,
        parsed.artifacts as Artifact[]
      );

      if (!result.task) {
        const statusCode = result.error === 'TASK_BLOCKED_BY_DEPENDENCIES' ? 422
          : result.error === 'QUALITY_GATES_NOT_MET' ? 422
          : 409;
        reply.code(statusCode).send({
          error: result.error ?? 'Cannot complete task in current state. Task must be in submitted status.',
          blockedBy: result.blockedBy,
          missingQualityItems: result.missingQualityItems,
        });
        return;
      }

      return {
        success: true,
        task: {
          id: result.task.id,
          status: result.task.status,
          completedAt: result.task.completedAt,
          result: result.task.result,
          artifacts: result.task.artifacts,
        },
        message: 'Task completed and moved to done.',
      };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/retry',
    { schema: { params: taskParamsSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      if (task.status !== 'failed') {
        reply.code(400).send({ error: 'Task must be in failed status to retry' });
        return;
      }

      const retried = retryService.executeRetry(task);
      if (!retried) {
        reply.code(500).send({ error: 'Failed to execute retry' });
        return;
      }
      return { task: retried };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/unblock',
    { schema: { params: taskParamsSchema }, preHandler: agentAuth },
    async (request, reply) => {
      if (!request.agent) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }

      reply.code(403).send({ error: 'Unblock is an internal-only action' });
    }
  );
}
