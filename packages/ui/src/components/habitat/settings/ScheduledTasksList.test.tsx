import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ScheduledTasksList } from './ScheduledTasksList.js';
import type { ScheduledTask } from '../../../types/index.js';

const mockScheduledTask: ScheduledTask = {
  id: 'st-1',
  boardId: 'board-1',
  templateId: null,
  name: 'Weekly Sprint',
  description: 'Create weekly sprint feature',
  scheduleType: 'cron',
  cronExpression: '0 9 * * 1',
  intervalMinutes: null,
  scheduledAt: null,
  timezone: 'UTC',
  featureTitle: 'Sprint {{date}}',
  featureDescription: 'Weekly sprint',
  featurePriority: 'medium',
  featureLabels: ['sprint'],
  featureDomain: null,
  tasksTemplate: [],
  enabled: true,
  lastRunAt: '2025-01-01T09:00:00Z',
  nextRunAt: '2025-01-06T09:00:00Z',
  runCount: 5,
  lastCreatedFeatureId: 'feat-100',
  createdBy: 'user-1',
  createdAt: '2024-12-01T00:00:00Z',
  updatedAt: '2025-01-01T09:00:00Z',
};

const mockDisabledTask: ScheduledTask = {
  ...mockScheduledTask,
  id: 'st-2',
  name: 'Monthly Review',
  enabled: false,
  cronExpression: '0 0 1 * *',
  lastCreatedFeatureId: null,
  runCount: 0,
};

vi.mock('../../ui/ToggleSwitch.js', () => ({
  ToggleSwitch: ({ checked, onChange }: any) => (
    <button data-testid="toggle" onClick={() => onChange(!checked)} data-checked={checked} />
  ),
}));

describe('ScheduledTasksList', () => {
  const mockOnToggle = vi.fn();
  const mockOnRun = vi.fn();
  const mockOnDelete = vi.fn();
  const mockOnEdit = vi.fn();
  const mockOnAdd = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading state', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[]}
        loading={true}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    expect(screen.getByText('Loading scheduled tasks...')).toBeTruthy();
  });

  it('renders empty state with add button', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    expect(screen.getByText(/No scheduled tasks configured/)).toBeTruthy();
    expect(screen.getByTestId('add-scheduled-task-btn')).toBeTruthy();
  });

  it('renders schedule items with name and next run time', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockScheduledTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    expect(screen.getByTestId('task-name-st-1')).toBeTruthy();
    expect(screen.getByText('Weekly Sprint')).toBeTruthy();
    expect(screen.getByText(/0 9 \* \* 1/)).toBeTruthy();
    expect(screen.getByText(/5 runs/)).toBeTruthy();
  });

  it('shows active badge for enabled tasks', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockScheduledTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('shows paused badge for disabled tasks', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockDisabledTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    expect(screen.getByText('Paused')).toBeTruthy();
  });

  it('enable/disable toggle calls onToggle', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockScheduledTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    const toggles = screen.getAllByTestId('toggle');
    fireEvent.click(toggles[0]);
    expect(mockOnToggle).toHaveBeenCalledWith(mockScheduledTask);
  });

  it('run button calls onRun with task id', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockScheduledTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    fireEvent.click(screen.getByTestId('run-btn-st-1'));
    expect(mockOnRun).toHaveBeenCalledWith('st-1');
  });

  it('delete button calls onDelete with task id', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockScheduledTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    fireEvent.click(screen.getByTestId('delete-btn-st-1'));
    expect(mockOnDelete).toHaveBeenCalledWith('st-1');
  });

  it('shows feature link when lastCreatedFeatureId exists', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockScheduledTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    expect(screen.getByTestId('feature-link-st-1')).toBeTruthy();
  });

  it('disables run button when task is currently running', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockScheduledTask]}
        loading={false}
        runningId="st-1"
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    const runBtn = screen.getByTestId('run-btn-st-1');
    expect(runBtn).toHaveProperty('disabled', true);
  });

  it('displays interval schedule type correctly', () => {
    const intervalTask: ScheduledTask = {
      ...mockScheduledTask,
      scheduleType: 'interval',
      intervalMinutes: 30,
      cronExpression: null,
    };
    render(
      <ScheduledTasksList
        scheduledTasks={[intervalTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    expect(screen.getByText(/Every 30m/)).toBeTruthy();
  });

  it('calls onEdit when edit button clicked', () => {
    render(
      <ScheduledTasksList
        scheduledTasks={[mockScheduledTask]}
        loading={false}
        runningId={null}
        onToggle={mockOnToggle}
        onRun={mockOnRun}
        onDelete={mockOnDelete}
        onEdit={mockOnEdit}
        onAdd={mockOnAdd}
      />
    );
    fireEvent.click(screen.getByTestId('edit-btn-st-1'));
    expect(mockOnEdit).toHaveBeenCalledWith(mockScheduledTask);
  });
});
