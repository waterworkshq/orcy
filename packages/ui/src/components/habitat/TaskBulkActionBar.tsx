import { useState } from 'react';
import { useBoardStore } from '../../store/habitatStore.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { X, Trash2, Gauge } from 'lucide-react';
import type { TaskPriority } from '../../types/index.js';

interface TaskBulkActionBarProps {
  boardId: string;
}

type TaskBulkOperation = 'priority' | 'delete';

export function TaskBulkActionBar({ boardId }: TaskBulkActionBarProps) {
  const { selectedTaskIds, setTaskBulkSelectMode, clearTaskSelection } = useBoardStore();
  const [operation, setOperation] = useState<TaskBulkOperation>('priority');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [isApplying, setIsApplying] = useState(false);

  async function handleApply() {
    if (selectedTaskIds.length === 0) return;
    setIsApplying(true);

    try {
      if (operation === 'delete') {
        const result = await api.tasks.batch(boardId, {
          taskIds: selectedTaskIds,
          operation: 'delete',
          payload: {},
        });
        notify.success(
          `${result.successCount} task${result.successCount !== 1 ? 's' : ''} deleted`
        );
        if (result.failureCount > 0) {
          notify.warning(`${result.failureCount} task${result.failureCount !== 1 ? 's' : ''} failed to delete`);
        }
      } else {
        const result = await api.tasks.batch(boardId, {
          taskIds: selectedTaskIds,
          operation: 'priority',
          payload: { priority },
        });
        notify.success(
          `${result.successCount} task${result.successCount !== 1 ? 's' : ''} updated`
        );
        if (result.failureCount > 0) {
          notify.warning(`${result.failureCount} task${result.failureCount !== 1 ? 's' : ''} failed to update`);
        }
      }

      clearTaskSelection();
      setTaskBulkSelectMode(false);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setIsApplying(false);
    }
  }

  function handleCancel() {
    clearTaskSelection();
    setTaskBulkSelectMode(false);
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3 shadow-sm">
      <span className="text-sm font-medium">
        {selectedTaskIds.length} task{selectedTaskIds.length !== 1 ? 's' : ''} selected
      </span>

      <div className="h-4 w-px bg-border" />

      <select
        value={operation}
        onChange={(e) => setOperation(e.target.value as TaskBulkOperation)}
        className="rounded border bg-background px-2 py-1 text-sm"
        data-testid="bulk-operation"
      >
        <option value="priority">Set Priority</option>
        <option value="delete">Delete</option>
      </select>

      {operation === 'priority' && (
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
          className="rounded border bg-background px-2 py-1 text-sm"
          data-testid="bulk-priority"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
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
          disabled={isApplying || selectedTaskIds.length === 0}
          className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="bulk-apply"
        >
          {operation === 'delete' ? (
            <>
              <Trash2 className="h-4 w-4" />
              {isApplying ? 'Deleting...' : 'Delete'}
            </>
          ) : (
            <>
              <Gauge className="h-4 w-4" />
              {isApplying ? 'Setting...' : 'Apply'}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
