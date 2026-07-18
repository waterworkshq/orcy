import type { FastifyInstance } from "fastify";
import { taskCrudRoutes } from "./crud.js";
import { taskLifecycleRoutes } from "./lifecycle.js";
import { taskDelegationRoutes } from "./delegation.js";
import { taskWatcherRoutes } from "./watchers.js";
import { taskMiscRoutes } from "./misc.js";
import { taskBatchRoutes } from "./batch.js";
import { taskAssignmentRoutes } from "./assignment.js";
import { habitatTasksRoutes } from "./boardTasks.js";
import { isCreationPublicationEnabled } from "../../config/creationPublicationCutover.js";

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(taskCrudRoutes);
  await fastify.register(taskLifecycleRoutes);
  await fastify.register(taskDelegationRoutes);
  await fastify.register(taskWatcherRoutes);
  await fastify.register(taskMiscRoutes);
  await fastify.register(taskBatchRoutes);
  // Fix-P1 (C1): the assignment-retry route creates/modifies POST_CUTOVER
  // state — gated behind the disabled-by-default cutover flag (mirrors the
  // 2 publication routes gated in `index.ts:registerApiRoutes`). Unreachable
  // in production until T11 flips `ORCY_CREATION_PUBLICATION_ENABLED=true`.
  if (isCreationPublicationEnabled()) {
    await fastify.register(taskAssignmentRoutes);
  }
  await fastify.register(habitatTasksRoutes);
}
