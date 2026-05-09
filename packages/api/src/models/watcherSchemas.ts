import { z } from 'zod';

/**
 * Zod schema for validating a UUID task ID parameter.
 */
export const taskIdParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Zod schema for paginated watcher list queries.
 */
export const watchersListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type TaskIdParamInput = z.infer<typeof taskIdParamSchema>;
export type WatchersListQueryInput = z.infer<typeof watchersListQuerySchema>;
