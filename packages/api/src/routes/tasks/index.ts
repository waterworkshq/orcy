import type { FastifyInstance } from 'fastify';
import { taskCrudRoutes } from './crud.js';
import { taskLifecycleRoutes } from './lifecycle.js';
import { taskDelegationRoutes } from './delegation.js';
import { taskWatcherRoutes } from './watchers.js';
import { taskMiscRoutes } from './misc.js';
import { taskBatchRoutes } from './batch.js';
import { taskAssignmentRoutes } from './assignment.js';
import { habitatTasksRoutes } from './boardTasks.js';

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(taskCrudRoutes);
  await fastify.register(taskLifecycleRoutes);
  await fastify.register(taskDelegationRoutes);
  await fastify.register(taskWatcherRoutes);
  await fastify.register(taskMiscRoutes);
  await fastify.register(taskBatchRoutes);
  await fastify.register(taskAssignmentRoutes);
  await fastify.register(habitatTasksRoutes);
}
