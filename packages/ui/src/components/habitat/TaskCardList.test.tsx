import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockOpenModal = vi.fn();
vi.mock('../../store/modalStore.js', () => ({
  useModalStore: (sel: (s: any) => any) =>
    sel({ openModal: mockOpenModal }),
}));

const mockAgents = [
  { id: 'a1', name: 'Agent Alpha' },
  { id: 'a2', name: 'Agent Beta' },
];
vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: (sel: (s: any) => any) =>
    sel({ agents: mockAgents }),
}));

vi.mock('../ui/Badge.js', () => ({
  Badge: ({ children, variant }: any) => (
    <span data-testid={`badge-${variant}`}>{children}</span>
  ),
}));

vi.mock('../../lib/formatting.js', () => ({
  truncateId: (id: string, prefix: string) => `${prefix}-${id.slice(0, 4)}`,
  PRIORITY_VARIANT: { critical: 'critical', high: 'high', medium: 'medium', low: 'low' },
  TASK_STATUS_VARIANT: { pending: 'default', in_progress: 'active', submitted: 'review', approved: 'done', rejected: 'blocked' },
}));

import { TaskCardList } from './TaskCardList.js';

const tasks = [
  { id: 't1', title: 'Task One', status: 'pending' as const, priority: 'high' as const, assignedAgentId: 'a1' },
  { id: 't2', title: 'Task Two', status: 'in_progress' as const, priority: 'medium' as const, assignedAgentId: null },
  { id: 't3', title: 'Task Three', status: 'submitted' as const, priority: 'critical' as const, assignedAgentId: 'a2' },
] as any;

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
  );
}

describe('TaskCardList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders all tasks', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={vi.fn()} />);
    expect(screen.getByText('Task One')).toBeTruthy();
    expect(screen.getByText('Task Two')).toBeTruthy();
    expect(screen.getByText('Task Three')).toBeTruthy();
  });

  it('renders task statuses', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={vi.fn()} />);
    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.getByText('in progress')).toBeTruthy();
    expect(screen.getByText('submitted')).toBeTruthy();
  });

  it('renders priority badges', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={vi.fn()} />);
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('critical')).toBeTruthy();
  });

  it('renders agent name when assigned', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={vi.fn()} />);
    expect(screen.getByText('Agent Alpha')).toBeTruthy();
    expect(screen.getByText('Agent Beta')).toBeTruthy();
  });

  it('renders Unassigned when no agent', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={vi.fn()} />);
    expect(screen.getByText('Unassigned')).toBeTruthy();
  });

  it('shows empty message when no tasks', () => {
    renderWithQC(<TaskCardList tasks={[]} selectedIds={[]} onSelectionChange={vi.fn()} />);
    expect(screen.getByText('No tasks found')).toBeTruthy();
  });

  it('renders checkboxes for each task', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={vi.fn()} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(3);
  });

  it('marks selected task checkboxes as checked', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={['t1']} onSelectionChange={vi.fn()} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it('calls onSelectionChange when checkbox toggled', () => {
    const onSelectionChange = vi.fn();
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={onSelectionChange} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(onSelectionChange).toHaveBeenCalledWith(['t1']);
  });

  it('removes task from selection when unchecked', () => {
    const onSelectionChange = vi.fn();
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={['t1', 't2']} onSelectionChange={onSelectionChange} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(onSelectionChange).toHaveBeenCalledWith(['t2']);
  });

  it('calls openModal when task title clicked', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Task One'));
    expect(mockOpenModal).toHaveBeenCalledWith('t1');
  });

  it('does not call openModal when checkbox clicked', () => {
    renderWithQC(<TaskCardList tasks={tasks} selectedIds={[]} onSelectionChange={vi.fn()} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(mockOpenModal).not.toHaveBeenCalled();
  });
});
