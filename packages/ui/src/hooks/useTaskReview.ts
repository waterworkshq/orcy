import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys.js";
import { useAgents } from "../lib/useHabitatData.js";
import { api } from "../api/index.js";
import { notify } from "../lib/toast.js";
import type { Task, TaskReviewer, Agent } from "../types/index.js";

export interface UseTaskReviewResult {
  submitting: boolean;
  handleApprove: (reviewerId: string) => Promise<void>;
  handleReject: (reviewerId: string, reason: string) => Promise<void>;
  reviewers: TaskReviewer[];
  currentUserId: string | undefined;
  currentUserIsReviewer: boolean;
  reviewProgress: { approved: number; total: number };
  agents: Agent[];
}

export function useTaskReview(task: Task | undefined): UseTaskReviewResult {
  const { data: agents = [] } = useAgents();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const taskId = task?.id ?? "";

  const { data: reviewersData } = useQuery({
    queryKey: queryKeys.tasks.reviewers(taskId),
    queryFn: () => api.reviewers.list(taskId),
    enabled: !!taskId && task?.status === "submitted",
    staleTime: 10_000,
  });

  const { data: userData } = useQuery({
    queryKey: queryKeys.user.profile(),
    queryFn: () => api.auth.me(),
    staleTime: 5 * 60_000,
  });

  const reviewers = reviewersData?.reviewers ?? [];
  const currentUserId = userData?.user?.id;

  const currentUserIsReviewer = currentUserId
    ? reviewers.some((r) => r.reviewerId === currentUserId && r.status === "pending")
    : false;

  const reviewProgress = {
    approved: reviewers.filter((r) => r.status === "approved").length,
    total: reviewers.length,
  };

  async function handleApprove(reviewerId: string) {
    if (!task) return;
    setSubmitting(true);
    try {
      await api.tasks.approve(task.id, reviewerId);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.reviewers(task.id) });
      notify.success("Task approved");
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject(reviewerId: string, reason: string) {
    if (!task) return;
    setSubmitting(true);
    try {
      await api.tasks.reject(task.id, reviewerId, reason);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.reviewers(task.id) });
      notify.success("Task rejected");
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return {
    submitting,
    handleApprove,
    handleReject,
    reviewers,
    currentUserId,
    currentUserIsReviewer,
    reviewProgress,
    agents,
  };
}
