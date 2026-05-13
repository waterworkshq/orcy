import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { api } from '../api/index.js';
import { notify } from '../lib/toast.js';
import type { Task, Subtask } from '../types/index.js';

export interface UseTaskSubtasksResult {
  newSubtaskTitle: string;
  addingSubtask: boolean;
  setNewSubtaskTitle: (v: string) => void;
  handleAddSubtask: (e: React.FormEvent) => Promise<void>;
  handleToggleSubtask: (subtask: Subtask) => Promise<void>;
  handleDeleteSubtask: (subtask: Subtask) => Promise<void>;
}

export function useTaskSubtasks(task: Task | undefined): UseTaskSubtasksResult {
  const queryClient = useQueryClient();
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [addingSubtask, setAddingSubtask] = useState(false);

  async function handleAddSubtask(e: React.FormEvent) {
    e.preventDefault();
    if (!task || !newSubtaskTitle.trim()) return;
    setAddingSubtask(true);
    try {
      await api.subtasks.create(task.id, { title: newSubtaskTitle.trim() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
      setNewSubtaskTitle('');
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setAddingSubtask(false);
    }
  }

  async function handleToggleSubtask(subtask: Subtask) {
    if (!task) return;
    try {
      await api.subtasks.update(task.id, subtask.id, { completed: !subtask.completed });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleDeleteSubtask(subtask: Subtask) {
    if (!task) return;
    try {
      await api.subtasks.delete(task.id, subtask.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return { newSubtaskTitle, addingSubtask, setNewSubtaskTitle, handleAddSubtask, handleToggleSubtask, handleDeleteSubtask };
}
