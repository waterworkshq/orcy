import * as React from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { shallow } from 'zustand/shallow';
import { Badge } from '../ui/Badge.js';
import { Tooltip } from '../ui/Tooltip.js';
import { useHabitatStore } from '../../store/habitatStore.js';
import {
  PRIORITY_VARIANT,
  TASK_STATUS_VARIANT,
  formatMinutes,
} from '../../lib/formatting.js';
import type { Task, TaskPriority, TaskStatus } from '../../types/index.js';

function AgentAvatar({ agentId }: { agentId: string }) {
  const agent = useHabitatStore(
    (s) => s.agents.find((a) => a.id === agentId) ?? null,
    shallow
  );
  if (!agent) return <span className="text-xs text-[var(--on-surface-variant)]">—</span>;

  const initials = agent.name.slice(0, 2).toUpperCase();
  const color =
    agent.type === 'claude-code'
      ? 'bg-[var(--agent-blue)]'
      : agent.type === 'codex'
      ? 'bg-[var(--agent-purple)]'
      : 'bg-[var(--agent-green)]';

  return (
    <Tooltip content={agent.name} position="top">
      <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-[var(--on-surface)] ${color}`}>
        {initials}
      </div>
    </Tooltip>
  );
}

export function getTaskTableColumns(): ColumnDef<Task, unknown>[] {
  return [
    {
      id: 'select',
      header: ({ table }) => (
        <input
          type="checkbox"
          data-testid="select-all"
          checked={table.getIsAllPageRowsSelected()}
          onChange={table.getToggleAllPageRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          data-testid={`select-${row.original.id}`}
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
        />
      ),
      enableSorting: false,
      enableHiding: false,
      size: 40,
    },
    {
      accessorKey: 'priority',
      header: 'Priority',
      cell: ({ getValue }) => {
        const priority = getValue() as TaskPriority;
        return (
          <Badge variant={PRIORITY_VARIANT[priority] ?? 'medium'}>
            {priority}
          </Badge>
        );
      },
      size: 100,
      filterFn: (row, _columnId, filterValue) => {
        if (!filterValue || filterValue === 'all') return true;
        return row.original.priority === filterValue;
      },
    },
    {
      accessorKey: 'title',
      header: 'Title',
      cell: ({ getValue }) => (
        <span className="font-medium">{getValue() as string}</span>
      ),
      size: 300,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ getValue }) => {
        const status = getValue() as TaskStatus;
        return (
          <Badge variant={TASK_STATUS_VARIANT[status] ?? 'default'}>
            {status.replace('_', ' ')}
          </Badge>
        );
      },
      size: 120,
      filterFn: (row, _columnId, filterValue) => {
        if (!filterValue || filterValue === 'all') return true;
        return row.original.status === filterValue;
      },
    },
    {
      accessorKey: 'assignedAgentId',
      header: 'Assignee',
      cell: ({ getValue }) => {
        const agentId = getValue() as string | null;
        if (!agentId) return <span className="text-xs text-[var(--on-surface-variant)]">Unassigned</span>;
        return <AgentAvatar agentId={agentId} />;
      },
      enableSorting: false,
      size: 100,
      filterFn: (row, _columnId, filterValue) => {
        if (!filterValue || filterValue === 'all') return true;
        return row.original.assignedAgentId === filterValue;
      },
    },
    {
      accessorKey: 'estimatedMinutes',
      header: 'Effort',
      cell: ({ getValue }) => {
        const minutes = getValue() as number | null;
        if (minutes == null) return <span className="text-xs text-[var(--on-surface-variant)]">—</span>;
        return <span className="text-xs">{formatMinutes(minutes)}</span>;
      },
      size: 80,
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: ({ getValue }) => {
        const dateStr = getValue() as string;
        const date = new Date(dateStr);
        return (
          <span className="text-xs text-[var(--on-surface-variant)]">
            {date.toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </span>
        );
      },
      size: 100,
    },
  ];
}
