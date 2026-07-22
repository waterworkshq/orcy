import { useState } from "react";
import { api } from "../api/index.js";
import { notify } from "../lib/toast.js";

export interface UseTaskActionsResult {
  deleteDialogOpen: boolean;
  setDeleteDialogOpen: (v: boolean) => void;
  handleDelete: () => Promise<void>;
  /**
   * Open the clone-preparation dialog (T11 Phase 2 — the prepare-edit-
   * publish journey). The dialog handles the GET preparation + POST
   * publication + 202 polling + 404 fallback internally.
   */
  handleClone: () => Promise<void>;
  /** Dialog visibility for the clone-preparation dialog. */
  cloneDialogOpen: boolean;
  setCloneDialogOpen: (v: boolean) => void;
  /**
   * Immediate-copy fallback used by the clone dialog when the cutover
   * flag is off (HTTP 404 from the publication route). Kept as a hook-
   * level method so the dialog can fire it without re-creating the
   * legacy `api.tasks.clone` binding.
   */
  handleLegacyClone: () => Promise<void>;
}

/**
 * Task actions: delete + clone-preparation dialog open (T11 Phase 2).
 *
 * The clone trigger no longer fires an immediate `POST /tasks/:id/clone`
 * — it OPENS a dialog that runs the prepare-edit-publish journey. The
 * immediate-copy legacy method (`handleLegacyClone`) is preserved as the
 * 404 fallback the dialog fires when the cutover flag is off.
 */
export function useTaskActions(task: { id: string } | undefined): UseTaskActionsResult {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);

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
    // Open the clone-preparation dialog (T11 Phase 2). The dialog runs the
    // prepare-edit-publish journey — see `CloneTaskForm.tsx`.
    setCloneDialogOpen(true);
  }

  async function handleLegacyClone() {
    if (!task) return;
    try {
      await api.tasks.clone(task.id);
      notify.success("Task cloned");
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  return {
    deleteDialogOpen,
    setDeleteDialogOpen,
    handleDelete,
    handleClone,
    cloneDialogOpen,
    setCloneDialogOpen,
    handleLegacyClone,
  };
}