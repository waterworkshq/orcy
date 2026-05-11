import type { TaskPriority, Task } from './task.js';

export { TaskPriority };
export { Task };

export type BatchTaskOperation = 'priority' | 'assign' | 'delete';

export type BatchTaskPayload =
  | { priority: TaskPriority }
  | { assignedAgentId: string }
  | Record<string, never>;

export interface BatchTaskResult {
  taskId: string;
  success: boolean;
  error?: string;
  task?: Task;
}

export interface BatchTaskResponse {
  successCount: number;
  failureCount: number;
  results: BatchTaskResult[];
}

export interface BatchTaskRequest {
  taskIds: string[];
  operation: BatchTaskOperation;
  payload: BatchTaskPayload;
}
