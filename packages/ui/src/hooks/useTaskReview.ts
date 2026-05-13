import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { useBoardStore } from '../store/habitatStore.js';
import { api } from '../api/index.js';
import { notify } from '../lib/toast.js';
import type { Task } from '../types/index.js';

export interface UseTaskReviewResult {
  submitting: boolean;
  handleApprove: (reviewerId: string) => Promise<void>;
  handleReject: (reviewerId: string, reason: string) => Promise<void>;
}

export function useTaskReview(task: Task | undefined): UseTaskReviewResult {
  const { updateTask } = useBoardStore();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  async function handleApprove(reviewerId: string) {
    if (!task) return;
    setSubmitting(true);
    try {
      const result = await api.tasks.approve(task.id, reviewerId);
      updateTask(result.task);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
      notify.success('Task approved');
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
      const result = await api.tasks.reject(task.id, reviewerId, reason);
      updateTask(result.task);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
      notify.success('Task rejected');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, handleApprove, handleReject };
}
