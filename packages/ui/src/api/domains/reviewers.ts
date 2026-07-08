import { request } from "../transport.js";
import type { TaskReviewer } from "../../types/index.js";

export const reviewersApi = {
  list: (taskId: string) => request<{ reviewers: TaskReviewer[] }>(`/tasks/${taskId}/reviewers`),
};
