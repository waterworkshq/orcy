import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { api } from '../api/index.js';
import { useBoardStore } from '../store/habitatStore.js';
import { notify } from '../lib/toast.js';
import type { Task } from '../types/index.js';

export interface UseTaskDelegateResult {
  delegateAgentId: string;
  delegating: boolean;
  showDelegate: boolean;
  setDelegateAgentId: (v: string) => void;
  setShowDelegate: (v: boolean) => void;
  handleDelegate: () => Promise<void>;
}

export function useTaskDelegate(task: Task | undefined): UseTaskDelegateResult {
  const { updateTask, agents } = useBoardStore();
  const queryClient = useQueryClient();
  const [delegateAgentId, setDelegateAgentId] = useState('');
  const [delegating, setDelegating] = useState(false);
  const [showDelegate, setShowDelegate] = useState(false);

  async function handleDelegate() {
    if (!task || !delegateAgentId) return;
    setDelegating(true);
    try {
      const result = await api.tasks.delegate(task.id, delegateAgentId);
      updateTask(result.task);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
      const targetAgent = agents.find((a) => a.id === delegateAgentId);
      notify.success(`Task delegated to ${targetAgent?.name ?? 'agent'}`);
      setShowDelegate(false);
      setDelegateAgentId('');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setDelegating(false);
    }
  }

  return { delegateAgentId, delegating, showDelegate, setDelegateAgentId, setShowDelegate, handleDelegate };
}
