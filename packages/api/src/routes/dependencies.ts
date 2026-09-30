import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as dependencyService from '../services/dependencyService.js';
import * as dependencyRepo from '../repositories/dependency.js';
import * as taskRepo from '../repositories/task.js';
import { badRequest, notFound, conflict, serviceUnavailable } from '../errors.js';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import { authorizeTaskAccess } from '../middleware/realtimeAuth.js';

function sameEndpointIds(projected: string[], inventoried: string[]): boolean {
  if (projected.length !== inventoried.length) return false;
  const left = projected.toSorted();
  const right = inventoried.toSorted();
  return left.every((id, index) => id === right[index]);
}

/**
 * Authorizes every raw linked endpoint of `taskId` (both directions, no
 * inner join — dangling edges surface here), then returns the existing
 * joined projection. The raw inventory and the joined projection are two
 * reads; if they disagree on either DIRECTION (outgoing vs dependsOn,
 * incoming vs blocking, cardinality included — an endpoint-union alone
 * cannot distinguish a reversed edge), revalidate once and otherwise fail
 * closed — never emit a partial or misleading response.
 */
async function authorizeTaskEdgesAndProject(
  request: FastifyRequest,
  taskId: string,
): Promise<dependencyRepo.TaskDependencyDetails> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const edges = dependencyRepo.getTaskDependencyEdgeIds(taskId);
    for (const linkedId of new Set([...edges.outgoing, ...edges.incoming])) {
      await authorizeTaskAccess(request, linkedId);
    }
    const projection = dependencyService.getTaskDependencies(taskId);
    if (
      sameEndpointIds(
        projection.dependsOn.map((row) => row.taskId),
        edges.outgoing,
      ) &&
      sameEndpointIds(
        projection.blocking.map((row) => row.taskId),
        edges.incoming,
      )
    ) {
      return projection;
    }
  }
  throw serviceUnavailable('Dependency state changed during read; retry');
}

export async function dependencyRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.post<{ Params: { id: string }; Body: { dependsOnTaskId: string } }>(
    '/tasks/:id/dependencies',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { id: string }; Body: { dependsOnTaskId: string } }>, _reply: FastifyReply) => {
      const dependsOnTaskId = request.body?.dependsOnTaskId;
      if (!dependsOnTaskId) {
        throw badRequest('dependsOnTaskId is required');
      }

      await authorizeTaskAccess(request, request.params.id);

      const depTask = taskRepo.getTaskById(dependsOnTaskId);
      if (!depTask) {
        throw notFound('Dependency task not found');
      }
      await authorizeTaskAccess(request, dependsOnTaskId);

      const result = dependencyService.addTaskDependency(request.params.id, dependsOnTaskId);
      if (!result.success) {
        throw conflict(result.reason ?? 'Conflict');
      }

      return { success: true };
    }
  );

  fastify.delete<{ Params: { id: string; depId: string } }>(
    '/tasks/:id/dependencies/:depId',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { id: string; depId: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.id);

      const edges = dependencyRepo.getTaskDependencyEdgeIds(request.params.id);
      if (!edges.outgoing.includes(request.params.depId)) {
        throw notFound('Dependency not found');
      }

      await authorizeTaskAccess(request, request.params.depId);

      const removed = dependencyService.removeTaskDependency(request.params.id, request.params.depId);
      if (!removed) {
        throw notFound('Dependency not found');
      }
      return { success: true };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/dependencies',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.id);
      return authorizeTaskEdgesAndProject(request, request.params.id);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/blocked-status',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.id);

      const deps = await authorizeTaskEdgesAndProject(request, request.params.id);
      const validation = dependencyService.validateTaskCompletion(request.params.id);

      // validateTaskCompletion is a second query that may see edges the raw
      // inventory did not; authorize every blocker id it returns.
      for (const blocker of validation.blockedBy ?? []) {
        await authorizeTaskAccess(request, blocker.taskId);
      }

      return {
        taskId: request.params.id,
        isBlocked: !validation.canComplete,
        ...validation,
        blocking: deps.blocking,
      };
    }
  );

  fastify.post<{ Params: { missionId: string }; Body: { dependsOnMissionId: string } }>(
    '/missions/:missionId/dependencies',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { missionId: string }; Body: { dependsOnMissionId: string } }>, _reply: FastifyReply) => {
      const { dependsOnMissionId } = request.body;
      if (!dependsOnMissionId) {
        throw badRequest('dependsOnMissionId is required');
      }

      const result = dependencyService.addMissionDependency(request.params.missionId, dependsOnMissionId);
      if (!result.success) {
        throw conflict(result.reason ?? 'Conflict');
      }
      return { success: true };
    }
  );

  fastify.delete<{ Params: { missionId: string; depId: string } }>(
    '/missions/:missionId/dependencies/:depId',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { missionId: string; depId: string } }>, _reply: FastifyReply) => {
      const removed = dependencyService.removeMissionDependency(request.params.missionId, request.params.depId);
      if (!removed) {
        throw notFound('Dependency not found');
      }
      return { success: true };
    }
  );

  fastify.get<{ Params: { missionId: string } }>(
    '/missions/:missionId/dependencies',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { missionId: string } }>, _reply: FastifyReply) => {
      return dependencyService.getMissionDependencies(request.params.missionId);
    }
  );

  fastify.get<{ Params: { missionId: string } }>(
    '/missions/:missionId/blocked-status',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { missionId: string } }>, _reply: FastifyReply) => {
      return dependencyService.validateMissionCompletion(request.params.missionId);
    }
  );

  fastify.get<{ Params: { missionId: string } }>(
    '/missions/:missionId/dependency-graph',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { missionId: string } }>, _reply: FastifyReply) => {
      return dependencyService.getDependencyGraph(request.params.missionId);
    }
  );
}
