import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHabitatStore } from "../../store/habitatStore.js";
import { useHabitat } from "../../lib/useHabitatData.js";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { X, Trash2, ArrowRight, Gauge } from "lucide-react";
import type { TaskPriority } from "../../types/index.js";

interface BulkActionBarProps {
  habitatId: string;
}

type BulkOperation = "priority" | "move" | "delete";

export function BulkActionBar({ habitatId }: BulkActionBarProps) {
  const selectedMissionIds = useHabitatStore((s) => s.selectedMissionIds);
  const setBulkSelectMode = useHabitatStore((s) => s.setBulkSelectMode);
  const clearMissionSelection = useHabitatStore((s) => s.clearMissionSelection);
  const { data: habitatData } = useHabitat(habitatId);
  const columns = habitatData?.columns ?? [];
  const missions = habitatData?.missions ?? [];
  const qc = useQueryClient();
  const [operation, setOperation] = useState<BulkOperation>("priority");
  const [targetColumnId, setTargetColumnId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [isApplying, setIsApplying] = useState(false);

  async function handleApply() {
    if (selectedMissionIds.length === 0) return;
    if (operation === "move" && !targetColumnId) {
      notify.warning("Please select a target column");
      return;
    }
    setIsApplying(true);

    let successCount = 0;
    let failureCount = 0;
    const errors: string[] = [];

    try {
      if (operation === "delete") {
        const results = await Promise.allSettled(
          selectedMissionIds.map((id) => api.missions.delete(id)),
        );
        results.forEach((result) => {
          if (result.status === "fulfilled") {
            successCount++;
          } else {
            failureCount++;
            errors.push(result.reason?.message ?? "Unknown error");
          }
        });
        if (successCount > 0) {
          qc.invalidateQueries({ queryKey: queryKeys.missions.list(habitatId) });
        }
      } else {
        const updatePromises = selectedMissionIds.map(async (id) => {
          if (operation === "priority") {
            const { mission } = await api.missions.update(id, { priority });
            return mission;
          } else {
            const currentVersion = missions.find((m) => m.id === id)?.version;
            if (currentVersion === undefined) {
              throw new Error(`Mission ${id} not found in current habitat state`);
            }
            const { mission } = await api.missions.move(id, {
              columnId: targetColumnId,
              expectedVersion: currentVersion,
            });
            return mission;
          }
        });

        const results = await Promise.allSettled(updatePromises);
        results.forEach((result) => {
          if (result.status === "fulfilled") {
            successCount++;
          } else {
            failureCount++;
            errors.push(result.reason?.message ?? "Unknown error");
          }
        });
        if (successCount > 0) {
          qc.invalidateQueries({ queryKey: queryKeys.missions.list(habitatId) });
        }
      }

      notify.success(
        `${successCount} feature${successCount !== 1 ? "s" : ""} ${operation === "delete" ? "deleted" : "updated"}`,
      );
      if (failureCount > 0) {
        notify.warning(`${failureCount} failed: ${errors[0]}`);
      }
      clearMissionSelection();
      setBulkSelectMode(false);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setIsApplying(false);
    }
  }

  function handleCancel() {
    clearMissionSelection();
    setBulkSelectMode(false);
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3 shadow-sm">
      <span className="text-sm font-medium">
        {selectedMissionIds.length} feature{selectedMissionIds.length !== 1 ? "s" : ""} selected
      </span>

      <div className="h-4 w-px bg-border" />

      <select
        value={operation}
        onChange={(e) => setOperation(e.target.value as BulkOperation)}
        className="rounded border bg-background px-2 py-1 text-sm"
      >
        <option value="priority">Set Priority</option>
        <option value="move">Move to Column</option>
        <option value="delete">Delete</option>
      </select>

      {operation === "priority" && (
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
          className="rounded border bg-background px-2 py-1 text-sm"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      )}

      {operation === "move" && (
        <select
          value={targetColumnId}
          onChange={(e) => setTargetColumnId(e.target.value)}
          className="rounded border bg-background px-2 py-1 text-sm"
        >
          <option value="">Select column...</option>
          {columns.map((col) => (
            <option key={col.id} value={col.id}>
              {col.name}
            </option>
          ))}
        </select>
      )}

      <div className="flex items-center gap-2 ml-auto">
        <button
          type="button"
          onClick={handleCancel}
          className="flex items-center gap-1 rounded px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
          Cancel
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={
            isApplying ||
            selectedMissionIds.length === 0 ||
            (operation === "move" && !targetColumnId)
          }
          className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {operation === "delete" ? (
            <>
              <Trash2 className="h-4 w-4" />
              {isApplying ? "Deleting..." : "Delete"}
            </>
          ) : operation === "priority" ? (
            <>
              <Gauge className="h-4 w-4" />
              {isApplying ? "Setting..." : "Apply"}
            </>
          ) : (
            <>
              <ArrowRight className="h-4 w-4" />
              {isApplying ? "Moving..." : "Move"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
