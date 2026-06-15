import type { TaskPriority, Task } from "./task.js";

export { TaskPriority };
export { Task };

/** Set of bulk operations supported by {@link BatchTaskRequest}, each mapping to a variant in {@link BatchTaskPayload}. */
export type BatchTaskOperation = "priority" | "assign" | "delete";

/** Discriminated payload for a {@link BatchTaskRequest}, whose required keys are determined by the chosen {@link BatchTaskOperation}. */
export type BatchTaskPayload =
  | { priority: TaskPriority }
  | { assignedAgentId: string }
  | Record<string, never>;

/** Per-task outcome of a {@link BatchTaskRequest}, surfaced inside {@link BatchTaskResponse.results}. */
export interface BatchTaskResult {
  taskId: string;
  success: boolean;
  error?: string;
  task?: Task;
}

/** Aggregated result of a batch operation: counts plus a per-task {@link BatchTaskResult} entry. */
export interface BatchTaskResponse {
  successCount: number;
  failureCount: number;
  results: BatchTaskResult[];
}

/** Wire shape for a bulk task operation, pairing target task ids with an {@link BatchTaskOperation} and its {@link BatchTaskPayload}. */
export interface BatchTaskRequest {
  taskIds: string[];
  operation: BatchTaskOperation;
  payload: BatchTaskPayload;
}
