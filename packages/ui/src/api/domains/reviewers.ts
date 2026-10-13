import { request } from "../transport.js";
import type { TaskReviewer } from "../../types/index.js";

export const reviewersApi = {
  list: (taskId: string) =>
    request<{ reviewers: TaskReviewer[]; reviewersToken?: string }>(
      `/tasks/${taskId}/reviewers`,
    ),
  // Optional roster token: echo the `reviewersToken` from a prior list to
  // guard against concurrent roster drift; omitted = legacy compatibility.
  add: (taskId: string, body: { reviewerId: string; reviewerType?: string; expectedReviewersToken?: string }) =>
    request<{ reviewer: TaskReviewer }>(`/tasks/${taskId}/reviewers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  remove: (taskId: string, reviewerId: string, expectedReviewersToken?: string) =>
    request<void>(
      `/tasks/${taskId}/reviewers/${reviewerId}${expectedReviewersToken ? `?expectedReviewersToken=${expectedReviewersToken}` : ""}`,
      { method: "DELETE" },
    ),
};
