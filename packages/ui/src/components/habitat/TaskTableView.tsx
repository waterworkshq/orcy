import * as React from 'react';
import { type ColumnFiltersState, type RowSelectionState, type SortingState } from '@tanstack/react-table';
import { shallow } from 'zustand/shallow';
import { Search } from 'lucide-react';
import { DataTable } from '../ui/DataTable.js';
import { getTaskTableColumns } from './TaskTableColumns.js';
import { TaskBulkActionBar } from './TaskBulkActionBar.js';
import { useBoardStore } from '../../store/habitatStore.js';
import { useBoardTasks, type BoardTasksFilters } from '../../lib/useHabitatData.js';
import { useDebounce } from '../../hooks/useDebounce.js';
import type { TaskPriority, TaskStatus } from '../../types/index.js';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'claimed', label: 'Claimed' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All Priorities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

interface TaskTableViewProps {
  boardId: string;
}

export function TaskTableView({ boardId }: TaskTableViewProps) {
  const columns = React.useMemo(() => getTaskTableColumns(), []);

  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [priorityFilter, setPriorityFilter] = React.useState<string>('all');
  const [agentFilter, setAgentFilter] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>(() => {
    const ids = useBoardStore.getState().selectedTaskIds;
    const mapping: RowSelectionState = {};
    ids.forEach((id) => { mapping[id] = true; });
    return mapping;
  });
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);

  const agents = useBoardStore((s) => s.agents, shallow);
  const selectedTaskIds = useBoardStore((s) => s.selectedTaskIds);
  const selectTaskIds = useBoardStore((s) => s.selectTaskIds);
  const clearTaskSelection = useBoardStore((s) => s.clearTaskSelection);

  const filters: BoardTasksFilters = React.useMemo(() => {
    const f: BoardTasksFilters = {};
    if (statusFilter !== 'all') f.status = statusFilter;
    if (priorityFilter !== 'all') f.priority = priorityFilter;
    if (agentFilter !== 'all') f.assignedAgentId = agentFilter;
    if (debouncedSearch.trim()) f.search = debouncedSearch.trim();
    if (sorting.length > 0) {
      f.sortBy = sorting[0].id;
      f.sortDir = sorting[0].desc ? 'desc' : 'asc';
    }
    return f;
  }, [statusFilter, priorityFilter, agentFilter, debouncedSearch, sorting]);

  const { data, isLoading, isError } = useBoardTasks(boardId, filters);
  const tasks = data?.tasks ?? [];

  React.useEffect(() => {
    const ids = Object.keys(rowSelection).filter((k) => rowSelection[k]);
    selectTaskIds(ids);
  }, [rowSelection, selectTaskIds]);

  React.useEffect(() => {
    const mapping: Record<string, string> = {};
    if (statusFilter !== 'all') mapping.status = statusFilter;
    if (priorityFilter !== 'all') mapping.priority = priorityFilter;
    if (agentFilter !== 'all') mapping.assignedAgentId = agentFilter;
    const filters: ColumnFiltersState = Object.entries(mapping).map(([id, value]) => ({
      id,
      value,
    }));
    setColumnFilters(filters);
  }, [statusFilter, priorityFilter, agentFilter]);

  function handleRowSelectionChange(updaterOrValue: React.SetStateAction<RowSelectionState>) {
    const next = typeof updaterOrValue === 'function' ? updaterOrValue(rowSelection) : updaterOrValue;
    setRowSelection(next);
  }

  function handleClearFilters() {
    setStatusFilter('all');
    setPriorityFilter('all');
    setAgentFilter('all');
    setSearch('');
    setRowSelection({});
    clearTaskSelection();
  }

  const hasActiveFilters = statusFilter !== 'all' || priorityFilter !== 'all' || agentFilter !== 'all' || search.trim() !== '';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--on-surface-variant)]" />
          <input
            type="text"
            placeholder="Search tasks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border border-[var(--outline-variant)] bg-[var(--surface-container)] pl-8 pr-3 py-1.5 text-sm text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded border border-[var(--outline-variant)] bg-[var(--surface-container)] px-2 py-1.5 text-sm text-[var(--on-surface)]"
          data-testid="filter-status"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="rounded border border-[var(--outline-variant)] bg-[var(--surface-container)] px-2 py-1.5 text-sm text-[var(--on-surface)]"
          data-testid="filter-priority"
        >
          {PRIORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded border border-[var(--outline-variant)] bg-[var(--surface-container)] px-2 py-1.5 text-sm text-[var(--on-surface)]"
          data-testid="filter-agent"
        >
          <option value="all">All Agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleClearFilters}
            className="rounded px-2 py-1.5 text-xs text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)] transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {isError ? (
        <div className="flex items-center justify-center py-12 text-sm text-red-500" role="alert">
          Failed to load tasks. Please try again.
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-12 text-sm text-[var(--on-surface-variant)]">
          Loading tasks...
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={tasks}
          sorting={sorting}
          onSortingChange={setSorting}
          manualSorting
          enableRowSelection
          rowSelection={rowSelection}
          onRowSelectionChange={handleRowSelectionChange}
          columnFilters={columnFilters}
          onColumnFiltersChange={setColumnFilters}
          getRowId={(row) => row.id}
          emptyMessage="No tasks found"
        />
      )}

      {selectedTaskIds.length > 0 && (
        <TaskBulkActionBar boardId={boardId} />
      )}
    </div>
  );
}
