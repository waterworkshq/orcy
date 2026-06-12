import { useState } from "react";
import { api } from "../api/index.js";
import { notify } from "../lib/toast.js";

export interface UseTaskActionsResult {
  deleteDialogOpen: boolean;
  setDeleteDialogOpen: (v: boolean) => void;
  handleDelete: () => Promise<void>;
  handleClone: () => Promise<void>;
}

export function useTaskActions(task: { id: string } | undefined): UseTaskActionsResult {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  async function handleDelete() {
    if (!task) return;
    try {
      await api.tasks.delete(task.id);
      notify.success("Task deleted");
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function handleClone() {
    if (!task) return;
    try {
      await api.tasks.clone(task.id);
      notify.success("Task cloned");
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  return { deleteDialogOpen, setDeleteDialogOpen, handleDelete, handleClone };
}
