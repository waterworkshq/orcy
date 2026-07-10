import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { api } from '../api/index.js';
import { notify } from '../lib/toast.js';

export interface UseTaskDependenciesResult {
  addingDep: boolean;
  handleAddDependency: (dependsOnTaskId: string) => Promise<void>;
  handleRemoveDependency: (depTaskId: string) => Promise<void>;
}

export function useTaskDependencies(selectedTaskId: string | null): UseTaskDependenciesResult {
  const queryClient = useQueryClient();
  const [addingDep, setAddingDep] = useState(false);

  async function handleAddDependency(dependsOnTaskId: string) {
    if (!selectedTaskId) return;
    setAddingDep(true);
    try {
      await api.dependencies.addTaskDependency(selectedTaskId, dependsOnTaskId);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(selectedTaskId) });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('409') || msg.toLowerCase().includes('circular')) {
        notify.error('Cannot add: would create a circular dependency');
      } else {
        notify.error(msg || 'Failed to add dependency');
      }
    } finally {
      setAddingDep(false);
    }
  }

  async function handleRemoveDependency(depTaskId: string) {
    if (!selectedTaskId) return;
    try {
      await api.dependencies.removeTaskDependency(selectedTaskId, depTaskId);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(selectedTaskId) });
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return { addingDep, handleAddDependency, handleRemoveDependency };
}
