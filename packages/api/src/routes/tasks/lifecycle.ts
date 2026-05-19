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
import { notFound, unauthorized, forbidden, conflict, badRequest, internalError, unprocessableEntity } from '../../errors.js';

const taskParamsSchema = z.object({ id: z.string() });

export async function taskLifecycleRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/claim',
    { schema: { params: taskParamsSchema, body: claimTaskSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        throw notFound('Task not found');
      }

      if (!request.agent) {
        throw unauthorized('Agent authentication required');
      }
      const agentId = request.agent.id;

      if (task.requiredDomain && request.agent.domain !== task.requiredDomain && request.agent.domain !== 'fullstack') {
        throw forbidden('Domain mismatch');
      }

      if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
        const agentCaps = new Set((request.agent.capabilities || []).map(c => c.toLowerCase()));
        const missing = (task.requiredCapabilities as string[]).filter(c => !agentCaps.has(c.toLowerCase()));
        if (missing.length > 0) {
          throw forbidden('Capability mismatch', undefined, { missingCapabilities: missing });
        }
      }

      if (task.delegatedToAgentId === agentId && (task.status === 'claimed' || task.status === 'in_progress')) {
        const result = taskService.claimDelegatedTask(request.params.id, agentId);
        if (!result.success) {
          throw conflict(result.reason, { message: result.message });
        }
        return { task: result.task };
      }

      const result = taskService.claimTask(request.params.id, agentId);
      if (!result.success) {
        throw conflict(result.reason, { missingCapabilities: result.missingCapabilities });
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
        throw notFound('Task not found');
      }

      const agentId = request.agent!.id;
      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'start');
      if (!auth.allowed) {
        throw forbidden(auth.reason ?? 'Forbidden');
      }

      const result = taskService.startTask(request.params.id, agentId);
      if (!result) {
        throw conflict('Cannot start task in current state');
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
        throw notFound('Task not found');
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'approve');
      if (!auth.allowed) {
        throw forbidden(auth.reason ?? 'Forbidden');
      }

      const reviewerId = request.user!.id;
      const approved = taskService.approveTask(request.params.id, reviewerId);

      if (!approved) {
        throw badRequest('Task cannot be approved in current state');
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
        throw notFound('Task not found');
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'reject');
      if (!auth.allowed) {
        throw forbidden(auth.reason ?? 'Forbidden');
      }

      const parsed = request.body;
      const reviewerId = request.user!.id;
      const rejected = taskService.rejectTask(request.params.id, reviewerId, parsed.reason);

      if (!rejected) {
        throw badRequest('Task cannot be rejected in current state');
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
        throw notFound('Task not found');
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'release');
      if (!auth.allowed) {
        throw forbidden(auth.reason ?? 'Forbidden');
      }

      const actorId = request.agent!.id;
      const parsed = request.body;
      const released = taskService.releaseTask(request.params.id, actorId, parsed.reason ?? '');

      if (!released) {
        throw conflict('Cannot release task in current state');
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
        throw notFound('Task not found');
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'fail');
      if (!auth.allowed) {
        throw forbidden(auth.reason ?? 'Forbidden');
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
        throw conflict('Cannot fail task in current state');
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
        throw notFound('Task not found');
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'submit');
      if (!auth.allowed) {
        throw forbidden(auth.reason ?? 'Forbidden');
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
        if (submitted.error === 'QUALITY_GATES_NOT_MET') {
          throw unprocessableEntity(submitted.error ?? 'Cannot submit task in current state', 'QUALITY_GATES_NOT_MET', { missingQualityItems: submitted.missingQualityItems });
        }
        throw conflict(submitted.error ?? 'Cannot submit task in current state', { missingQualityItems: submitted.missingQualityItems });
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
        throw notFound('Task not found');
      }

      const principal = getPrincipalFromRequest(request);
      const auth = authorizeTaskAction(task, principal, 'complete');
      if (!auth.allowed) {
        throw forbidden(auth.reason ?? 'Forbidden');
      }

      const agentId = request.agent!.id;
      const parsed = request.body;

      const result = taskService.completeTask(
        request.params.id,
        agentId,
        parsed.reviewNote,
        parsed.artifacts as Artifact[],
        parsed.skipQualityGates
      );

      if (!result.task) {
        if (result.error === 'TASK_BLOCKED_BY_DEPENDENCIES') {
          throw unprocessableEntity(
            result.error ?? 'Cannot complete task in current state. Task must be in submitted status.',
            'TASK_BLOCKED',
            { blockedBy: result.blockedBy }
          );
        }
        if (result.error === 'QUALITY_GATES_NOT_MET') {
          throw unprocessableEntity(
            result.error ?? 'Cannot complete task in current state. Task must be in submitted status.',
            'QUALITY_GATES_NOT_MET',
            { missingQualityItems: result.missingQualityItems }
          );
        }
        if (result.error === 'REVIEW_REQUIRED') {
          throw unprocessableEntity(
            'Task requires review approval before completion',
            'REVIEW_REQUIRED',
            {}
          );
        }
        throw conflict(
          result.error ?? 'Cannot complete task in current state. Task must be in submitted status.',
          { blockedBy: result.blockedBy, missingQualityItems: result.missingQualityItems }
        );
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
        throw notFound('Task not found');
      }

      if (task.status !== 'failed') {
        throw badRequest('Task must be in failed status to retry');
      }

      const retried = retryService.executeRetry(task);
      if (!retried) {
        throw internalError('Failed to execute retry');
      }
      return { task: retried };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/unblock',
    { schema: { params: taskParamsSchema }, preHandler: agentAuth },
    async (request, reply) => {
      if (!request.agent) {
        throw unauthorized('Authentication required');
      }

      throw forbidden('Unblock is an internal-only action');
    }
  );
}
