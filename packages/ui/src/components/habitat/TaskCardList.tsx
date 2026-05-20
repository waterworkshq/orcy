import React from 'react';
import { Badge } from '../ui/Badge.js';
import { useModalStore } from '../../store/modalStore.js';
import { useHabitatStore } from '../../store/habitatStore.js';
import { truncateId, PRIORITY_VARIANT, TASK_STATUS_VARIANT } from '../../lib/formatting.js';
import type { Task } from '../../types/index.js';
import { User } from 'lucide-react';

interface TaskCardListProps {
  tasks: Task[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

function TaskCardItem({ task, isSelected, onToggle }: {
  task: Task;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const openModal = useModalStore((s) => s.openModal);
  const agents = useHabitatStore((s) => s.agents);
  const agent = agents.find((a) => a.id === task.assignedAgentId);

  return (
    <div
      className="glass-card p-3 cursor-pointer transition-colors hover:bg-[var(--surface-container-high)]"
      data-testid="task-card-item"
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          className="mt-0.5 h-4 w-4 rounded border-[var(--outline)] text-[var(--primary)] focus:ring-[var(--primary)] flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        />
        <div className="flex-1 min-w-0" onClick={() => openModal(task.id)}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-sm font-medium truncate">{task.title}</span>
            <span className="text-xs text-[var(--on-surface-variant)] flex-shrink-0">
              {truncateId(task.id, 'TASK')}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={TASK_STATUS_VARIANT[task.status] ?? 'default'}>
              {task.status.replace('_', ' ')}
            </Badge>
            <Badge variant={PRIORITY_VARIANT[task.priority] ?? 'medium'}>
              {task.priority}
            </Badge>
            <div className="flex items-center gap-1 ml-auto text-xs text-[var(--on-surface-variant)]">
              {agent ? (
                <>
                  <div className="h-4 w-4 rounded-full bg-[var(--primary)] flex items-center justify-center">
                    <span className="text-[8px] font-bold text-[var(--primary-foreground)]">
                      {agent.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <span className="truncate max-w-[80px]">{agent.name}</span>
                </>
              ) : (
                <>
                  <User className="h-3 w-3" />
                  <span>Unassigned</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TaskCardList({ tasks, selectedIds, onSelectionChange }: TaskCardListProps) {
  function handleToggle(taskId: string) {
    const next = selectedIds.includes(taskId)
      ? selectedIds.filter((id) => id !== taskId)
      : [...selectedIds, taskId];
    onSelectionChange(next);
  }

  if (tasks.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-[var(--on-surface-variant)]">
        No tasks found
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <TaskCardItem
          key={task.id}
          task={task}
          isSelected={selectedIds.includes(task.id)}
          onToggle={() => handleToggle(task.id)}
        />
      ))}
    </div>
  );
}
