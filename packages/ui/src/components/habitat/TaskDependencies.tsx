import React, { useState } from 'react';
import { Link2, Link2Off, AlertCircle, ArrowRight, Plus, X } from 'lucide-react';
import { Badge } from '../ui/Badge.js';
import { notify } from '../../lib/toast.js';
import type { Task, CrossHabitatDependency } from '../../types/index.js';

interface TaskDependenciesProps {
  task: { dependsOn: string[] };
  taskId: string;
  dependencies: Task[];
  crossBoardDependsOn: CrossHabitatDependency[];
  blockedBy: Task[];
  blocking: Task[];
  boardTasks: { id: string; title: string; status: string }[];
  onSelectTask: (taskId: string) => void;
  onAddDependency: (dependsOnTaskId: string) => Promise<void>;
  onRemoveDependency: (depTaskId: string) => Promise<void>;
  addingDep: boolean;
}

export function TaskDependencies({
  task,
  taskId,
  dependencies,
  crossBoardDependsOn,
  blockedBy,
  blocking,
  boardTasks,
  onSelectTask,
  onAddDependency,
  onRemoveDependency,
  addingDep,
}: TaskDependenciesProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState('');

  const existingDepIds = new Set([
    ...task.dependsOn,
    ...dependencies.map((d) => d.id),
    ...crossBoardDependsOn.map((d) => d.taskId),
  ]);

  const availableTasks = boardTasks.filter(
    (t) => t.id !== taskId && !existingDepIds.has(t.id),
  );

  async function handleAdd() {
    if (!selectedTaskId) return;
    try {
      await onAddDependency(selectedTaskId);
      setSelectedTaskId('');
      setShowAddForm(false);
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('409') || msg.toLowerCase().includes('circular')) {
        notify.error('Cannot add: would create a circular dependency');
      } else {
        notify.error(msg || 'Failed to add dependency');
      }
    }
  }

  return (
    <>
      {(task.dependsOn.length > 0 || showAddForm) && (
        <div className="mb-4">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
            <Link2 className="h-3 w-3" />
            Depends On ({dependencies.length + crossBoardDependsOn.length})
          </h4>
          <div className="space-y-1">
            {dependencies.map((dep) => {
              const isDone = dep.status === 'done' || dep.status === 'approved';
              return (
                <div key={dep.id} className="group/dep flex items-center gap-1">
                  <button
                    onClick={() => onSelectTask(dep.id)}
                    className="flex flex-1 items-center gap-2 rounded p-1.5 text-left text-sm transition-colors hover:bg-accent"
                  >
                    {isDone
                      ? <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-green-600" />
                      : <Link2Off className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
                    }
                    <span className={`truncate flex-1 ${isDone ? 'text-muted-foreground' : 'text-foreground'}`}>
                      {dep.title}
                    </span>
                    <Badge
                      variant={isDone ? 'done' : 'pending'}
                      className="flex-shrink-0 text-xs"
                    >
                      {isDone ? 'done' : dep.status.replace('_', ' ')}
                    </Badge>
                  </button>
                  <button
                    onClick={() => onRemoveDependency(dep.id)}
                    className="flex-shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover/dep:opacity-100"
                    title="Remove dependency"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            {crossBoardDependsOn.map((dep) => {
              const isDone = dep.status === 'done' || dep.status === 'approved';
              return (
                <button
                  key={dep.taskId}
                  onClick={() => onSelectTask(dep.taskId)}
                  className="flex w-full items-center gap-2 rounded p-1.5 text-left text-sm transition-colors hover:bg-accent border-l-2 border-[var(--agent-purple)]"
                >
                  {isDone
                    ? <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-green-600" />
                    : <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--agent-purple)]" />
                  }
                  <span className="truncate flex-1 text-muted-foreground">
                    [{dep.habitatName}] {dep.title}
                  </span>
                  <Badge
                    variant={isDone ? 'done' : 'pending'}
                    className="flex-shrink-0 text-xs"
                  >
                    {isDone ? 'done' : dep.status.replace('_', ' ')}
                  </Badge>
                </button>
              );
            })}
          </div>

          {showAddForm && (
            <div className="mt-2 flex items-center gap-2">
              <select
                value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)}
                className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm"
              >
                <option value="">Select task...</option>
                {availableTasks.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
              <button
                onClick={handleAdd}
                disabled={!selectedTaskId || addingDep}
                className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {addingDep ? 'Adding...' : 'Add'}
              </button>
              <button
                onClick={() => { setShowAddForm(false); setSelectedTaskId(''); }}
                className="rounded p-1 text-muted-foreground hover:bg-accent"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {!showAddForm && availableTasks.length > 0 && (
            <button
              onClick={() => setShowAddForm(true)}
              className="mt-1 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              Add dependency
            </button>
          )}
        </div>
      )}

      {!showAddForm && task.dependsOn.length === 0 && availableTasks.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              Add dependency
            </button>
          </div>
        </div>
      )}

      {blockedBy.length > 0 && (
        <div className="mb-4">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
            <AlertCircle className="h-3 w-3 text-red-500" />
            Blocked By ({blockedBy.length})
          </h4>
          <div className="space-y-1">
            {blockedBy.map((blocker) => (
              <button
                key={blocker.id}
                onClick={() => onSelectTask(blocker.id)}
                className="flex w-full items-center gap-2 rounded p-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />
                <span className="truncate flex-1">{blocker.title}</span>
                <Badge
                  variant={blocker.status === 'done' ? 'done' : 'pending'}
                  className="flex-shrink-0 text-xs"
                >
                  {blocker.status.replace('_', ' ')}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      )}

      {blocking.length > 0 && (
        <div className="mb-4">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
            <Link2 className="h-3 w-3" />
            Blocking ({blocking.length})
          </h4>
          <div className="space-y-1">
            {blocking.map((blocked) => (
              <button
                key={blocked.id}
                onClick={() => onSelectTask(blocked.id)}
                className="flex w-full items-center gap-2 rounded p-1.5 text-left text-sm transition-colors hover:bg-accent"
              >
                <span className="flex-1 truncate text-sm">{blocked.title}</span>
                <Badge
                  variant={blocked.status === 'done' ? 'done' : blocked.status === 'pending' ? 'pending' : 'in_progress'}
                  className="flex-shrink-0 text-xs"
                >
                  {blocked.status.replace('_', ' ')}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
