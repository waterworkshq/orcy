import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { api } from '../api/index.js';
import { notify } from '../lib/toast.js';
import type { Task } from '../types/index.js';

export interface UseTaskWatchResult {
  watchLoading: boolean;
  handleToggleWatch: (isWatching: boolean) => Promise<void>;
}

export function useTaskWatch(task: Task | undefined): UseTaskWatchResult {
  const queryClient = useQueryClient();
  const [watchLoading, setWatchLoading] = useState(false);

  async function handleToggleWatch(isWatching: boolean) {
    if (!task || watchLoading) return;
    setWatchLoading(true);
    try {
      if (isWatching) {
        await api.tasks.unwatch(task.id);
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
        notify.success('Stopped watching task');
      } else {
        await api.tasks.watch(task.id);
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
        notify.success('Now watching task');
      }
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setWatchLoading(false);
    }
  }

  return { watchLoading, handleToggleWatch };
}
