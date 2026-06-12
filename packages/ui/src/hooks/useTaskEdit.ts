import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys.js";
import { api } from "../api/index.js";
import { notify } from "../lib/toast.js";
import { initEditForm } from "../lib/task-helpers.js";
import type { Task } from "../types/index.js";

interface EditFormState {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  labels: string;
  requiredDomain: string;
  requiredCapabilities: string[];
}

interface RetryFormState {
  maxRetries: string;
  backoffBase: string;
  backoffMultiplier: string;
  maxBackoff: string;
  escalateToHuman: boolean;
}

export interface UseTaskEditResult {
  isEditing: boolean;
  editForm: EditFormState;
  editDueAt: string;
  editSlaMinutes: string;
  editEstimatedMinutes: string;
  retryForm: RetryFormState;
  setIsEditing: (v: boolean) => void;
  setEditForm: (f: EditFormState) => void;
  setEditDueAt: (v: string) => void;
  setEditSlaMinutes: (v: string) => void;
  setEditEstimatedMinutes: (v: string) => void;
  setRetryForm: (f: RetryFormState) => void;
  startEditing: () => void;
  handleEditSubmit: () => Promise<void>;
  handleEditCancel: () => void;
}

export function useTaskEdit(
  task: Task | undefined,
  editTaskId: string | null | undefined,
  selectedTaskId: string | null,
  detailsData: any,
): UseTaskEditResult {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState>({
    title: "",
    description: "",
    priority: "medium",
    labels: "",
    requiredDomain: "",
    requiredCapabilities: [],
  });
  const [editDueAt, setEditDueAt] = useState("");
  const [editSlaMinutes, setEditSlaMinutes] = useState("");
  const [editEstimatedMinutes, setEditEstimatedMinutes] = useState("");
  const [retryForm, setRetryForm] = useState<RetryFormState>({
    maxRetries: "",
    backoffBase: "",
    backoffMultiplier: "",
    maxBackoff: "",
    escalateToHuman: true,
  });

  useEffect(() => {
    if (editTaskId && editTaskId === selectedTaskId) {
      setIsEditing(true);
    }
  }, [editTaskId, selectedTaskId]);

  function startEditing() {
    if (!task) return;
    setEditForm(initEditForm(task));
    setEditDueAt(detailsData?.feature?.dueAt ?? "");
    setEditSlaMinutes(detailsData?.feature?.slaMinutes?.toString() ?? "");
    setEditEstimatedMinutes(task.estimatedMinutes?.toString() ?? "");
    setRetryForm({
      maxRetries: task.retryPolicy?.maxRetries?.toString() ?? "",
      backoffBase: task.retryPolicy?.backoffBase?.toString() ?? "",
      backoffMultiplier: task.retryPolicy?.backoffMultiplier?.toString() ?? "",
      maxBackoff: task.retryPolicy?.maxBackoff?.toString() ?? "",
      escalateToHuman: task.retryPolicy?.escalateToHuman ?? true,
    });
    setIsEditing(true);
  }

  async function handleEditSubmit() {
    if (!task) return;
    try {
      await api.tasks.update(task.id, {
        ...editForm,
        labels: editForm.labels
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
        estimatedMinutes: editEstimatedMinutes ? parseInt(editEstimatedMinutes, 10) : null,
        retryPolicy: retryForm.maxRetries
          ? {
              maxRetries: parseInt(retryForm.maxRetries, 10),
              backoffBase: retryForm.backoffBase ? parseInt(retryForm.backoffBase, 10) : undefined,
              backoffMultiplier: retryForm.backoffMultiplier
                ? parseFloat(retryForm.backoffMultiplier)
                : undefined,
              maxBackoff: retryForm.maxBackoff ? parseInt(retryForm.maxBackoff, 10) : undefined,
              escalateToHuman: retryForm.escalateToHuman,
            }
          : null,
        version: task.version,
      });

      if (task.missionId && (editDueAt || editSlaMinutes)) {
        const featureUpdate: { dueAt?: string | null; slaMinutes?: number | null } = {};
        if (editDueAt) featureUpdate.dueAt = editDueAt;
        else featureUpdate.dueAt = null;
        if (editSlaMinutes) featureUpdate.slaMinutes = parseInt(editSlaMinutes, 10);
        else featureUpdate.slaMinutes = null;
        await api.missions.update(task.missionId, featureUpdate);
      }

      const updatedLabels = editForm.labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(task.id) });
      notify.success("Task updated");
      setIsEditing(false);
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  function handleEditCancel() {
    setIsEditing(false);
  }

  return {
    isEditing,
    editForm,
    editDueAt,
    editSlaMinutes,
    editEstimatedMinutes,
    retryForm,
    setIsEditing,
    setEditForm,
    setEditDueAt,
    setEditSlaMinutes,
    setEditEstimatedMinutes,
    setRetryForm,
    startEditing,
    handleEditSubmit,
    handleEditCancel,
  };
}
