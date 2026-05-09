import React from 'react';
import { Button } from '../ui/Button.js';
import { ListChecks, Plus, Trash2, Square, CheckSquare } from 'lucide-react';
import type { Subtask } from '../../types/index.js';

interface TaskSubtasksProps {
  subtasks: Subtask[];
  contextLoading: boolean;
  newSubtaskTitle: string;
  addingSubtask: boolean;
  onTitleChange: (v: string) => void;
  onAdd: (e: React.FormEvent) => void;
  onToggle: (subtask: Subtask) => void;
  onDelete: (subtask: Subtask) => void;
}

export function TaskSubtasks({
  subtasks,
  contextLoading,
  newSubtaskTitle,
  addingSubtask,
  onTitleChange,
  onAdd,
  onToggle,
  onDelete,
}: TaskSubtasksProps) {
  const completedCount = subtasks.filter((s) => s.completed).length;
  const total = subtasks.length;

  return (
    <div className="mb-4">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
        <ListChecks className="h-3 w-3" />
        Subtasks
        {total > 0 && (
          <span className="ml-1 text-muted-foreground">({completedCount}/{total})</span>
        )}
      </h4>

      {contextLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading...
        </div>
      ) : (
        <div className="space-y-1">
          {subtasks.map((subtask) => (
            <div key={subtask.id} className="flex items-center gap-2 rounded p-1.5 hover:bg-accent group">
              <button
                onClick={() => onToggle(subtask)}
                className="flex-shrink-0 text-primary hover:text-primary/80"
              >
                {subtask.completed
                  ? <CheckSquare className="h-4 w-4" />
                  : <Square className="h-4 w-4" />
                }
              </button>
              <span className={`flex-1 text-sm ${subtask.completed ? 'line-through text-muted-foreground' : ''}`}>
                {subtask.title}
              </span>
              <button
                onClick={() => onDelete(subtask)}
                className="flex-shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={onAdd} className="mt-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newSubtaskTitle}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Add subtask..."
            className="flex-1 rounded border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!newSubtaskTitle.trim() || addingSubtask}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}
