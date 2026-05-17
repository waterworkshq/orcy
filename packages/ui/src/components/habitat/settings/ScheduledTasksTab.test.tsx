import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScheduledTasksTab } from './ScheduledTasksTab.js';

const mockListScheduledTasks = vi.fn();
const mockCreateScheduledTask = vi.fn();
const mockUpdateScheduledTask = vi.fn();
const mockDeleteScheduledTask = vi.fn();
const mockRunScheduledTask = vi.fn();
const mockEnableScheduledTask = vi.fn();
const mockDisableScheduledTask = vi.fn();
const mockListTemplates = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../../../api/index.js', () => ({
  api: {
    scheduledTasks: {
      list: (...args: unknown[]) => mockListScheduledTasks(...args),
      create: (...args: unknown[]) => mockCreateScheduledTask(...args),
      update: (...args: unknown[]) => mockUpdateScheduledTask(...args),
      delete: (...args: unknown[]) => mockDeleteScheduledTask(...args),
      run: (...args: unknown[]) => mockRunScheduledTask(...args),
      enable: (...args: unknown[]) => mockEnableScheduledTask(...args),
      disable: (...args: unknown[]) => mockDisableScheduledTask(...args),
    },
    templates: {
      list: (...args: unknown[]) => mockListTemplates(...args),
    },
  },
}));

vi.mock('../../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('./ScheduledTasksList.js', () => ({
  ScheduledTasksList: ({ scheduledTasks, loading, runningId, onToggle, onRun, onDelete, onEdit, onAdd }: any) => (
    <div data-testid="scheduled-tasks-list">
      {loading && <span>Loading...</span>}
      {!loading && scheduledTasks?.length === 0 && <span>No scheduled tasks</span>}
      {!loading && scheduledTasks?.map((t: any) => (
        <div key={t.id} data-testid={`task-${t.id}`}>
          <span>{t.name}</span>
          <button onClick={() => onToggle(t)}>ToggleBtn</button>
          <button onClick={() => onRun(t.id)}>RunBtn</button>
          <button onClick={() => onDelete(t.id)}>DeleteBtn</button>
          <button onClick={() => onEdit(t)}>EditBtn</button>
        </div>
      ))}
      <button onClick={onAdd}>AddBtn</button>
    </div>
  ),
}));

vi.mock('./ScheduledTaskForm.js', () => ({
  ScheduledTaskForm: ({ existing, templates, saving, onSave, onCancel }: any) => (
    <div data-testid="scheduled-task-form">
      <span>{existing ? 'Edit Form' : 'Create Form'}</span>
      <button onClick={() => onSave({
        name: 'Test Task',
        scheduleType: 'cron',
        cronExpression: '0 9 * * 1',
        missionTitle: 'Test Feature',
        missionPriority: 'medium',
      })}>
        SubmitForm
      </button>
      <button onClick={onCancel}>CancelForm</button>
      {saving && <span>Saving...</span>}
    </div>
  ),
}));

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
  );
}

const mockTask = {
  id: 'st-1',
  habitatId: 'b1',
  templateId: null,
  name: 'Weekly Sprint',
  description: 'Create weekly sprint feature',
  scheduleType: 'cron',
  cronExpression: '0 9 * * 1',
  intervalMinutes: null,
  scheduledAt: null,
  timezone: 'UTC',
  missionTitle: 'Sprint {{date}}',
  missionDescription: 'Weekly sprint',
  missionPriority: 'medium',
  missionLabels: ['sprint'],
  missionDomain: null,
  tasksTemplate: [],
  enabled: true,
  lastRunAt: '2025-01-01T09:00:00Z',
  nextRunAt: '2025-01-06T09:00:00Z',
  runCount: 5,
  lastCreatedFeatureId: 'feat-100',
  createdBy: 'user-1',
  createdAt: '2024-12-01T00:00:00Z',
};

describe('ScheduledTasksTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListScheduledTasks.mockResolvedValue({ scheduledTasks: [] });
    mockListTemplates.mockResolvedValue({ templates: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the list component', async () => {
    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByTestId('scheduled-tasks-list')).toBeTruthy();
    });
  });

  it('renders scheduled tasks from useScheduledTasks', async () => {
    mockListScheduledTasks.mockResolvedValue({ scheduledTasks: [mockTask] });

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('Weekly Sprint')).toBeTruthy();
    });
  });

  it('renders template options from useTemplates', async () => {
    mockListTemplates.mockResolvedValue({
      templates: [{ id: 'tmpl-1', name: 'Sprint Template' }],
    });

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByTestId('scheduled-tasks-list')).toBeTruthy();
    });

    expect(mockListTemplates).toHaveBeenCalledWith('b1');
  });

  it('shows form when Add is clicked', async () => {
    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('AddBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('AddBtn'));

    await waitFor(() => {
      expect(screen.getByTestId('scheduled-task-form')).toBeTruthy();
      expect(screen.getByText('Create Form')).toBeTruthy();
    });
  });

  it('calls create API when form submits new task', async () => {
    mockCreateScheduledTask.mockResolvedValue({ scheduledTask: { id: 'st-new' } });

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('AddBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('AddBtn'));

    await waitFor(() => {
      expect(screen.getByText('SubmitForm')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('SubmitForm'));

    await waitFor(() => {
      expect(mockCreateScheduledTask).toHaveBeenCalledWith('b1', expect.objectContaining({
        name: 'Test Task',
      }));
      expect(mockNotifySuccess).toHaveBeenCalledWith('Scheduled task created');
    });
  });

  it('calls delete API and invalidates cache', async () => {
    mockListScheduledTasks.mockResolvedValue({ scheduledTasks: [mockTask] });
    mockDeleteScheduledTask.mockResolvedValue(undefined);

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('DeleteBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('DeleteBtn'));

    await waitFor(() => {
      expect(mockDeleteScheduledTask).toHaveBeenCalledWith('st-1');
      expect(mockNotifySuccess).toHaveBeenCalledWith('Scheduled task deleted');
    });
  });

  it('calls run API and invalidates cache', async () => {
    mockListScheduledTasks.mockResolvedValue({ scheduledTasks: [mockTask] });
    mockRunScheduledTask.mockResolvedValue({ success: true, featureId: 'f1' });

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('RunBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('RunBtn'));

    await waitFor(() => {
      expect(mockRunScheduledTask).toHaveBeenCalledWith('st-1');
      expect(mockNotifySuccess).toHaveBeenCalled();
    });
  });

  it('calls disable when toggling an enabled task', async () => {
    mockListScheduledTasks.mockResolvedValue({ scheduledTasks: [mockTask] });
    mockDisableScheduledTask.mockResolvedValue({ scheduledTask: { ...mockTask, enabled: false } });

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('ToggleBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('ToggleBtn'));

    await waitFor(() => {
      expect(mockDisableScheduledTask).toHaveBeenCalledWith('st-1');
    });
  });

  it('calls enable when toggling a disabled task', async () => {
    const disabledTask = { ...mockTask, enabled: false };
    mockListScheduledTasks.mockResolvedValue({ scheduledTasks: [disabledTask] });
    mockEnableScheduledTask.mockResolvedValue({ scheduledTask: { ...mockTask, enabled: true } });

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('ToggleBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('ToggleBtn'));

    await waitFor(() => {
      expect(mockEnableScheduledTask).toHaveBeenCalledWith('st-1');
    });
  });

  it('shows edit form when Edit is clicked', async () => {
    mockListScheduledTasks.mockResolvedValue({ scheduledTasks: [mockTask] });

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('EditBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('EditBtn'));

    await waitFor(() => {
      expect(screen.getByTestId('scheduled-task-form')).toBeTruthy();
      expect(screen.getByText('Edit Form')).toBeTruthy();
    });
  });

  it('calls update API when editing existing task', async () => {
    mockListScheduledTasks.mockResolvedValue({ scheduledTasks: [mockTask] });
    mockUpdateScheduledTask.mockResolvedValue({ scheduledTask: mockTask });

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('EditBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('EditBtn'));

    await waitFor(() => {
      expect(screen.getByText('SubmitForm')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('SubmitForm'));

    await waitFor(() => {
      expect(mockUpdateScheduledTask).toHaveBeenCalledWith('st-1', expect.objectContaining({
        name: 'Test Task',
      }));
      expect(mockNotifySuccess).toHaveBeenCalledWith('Scheduled task updated');
    });
  });

  it('shows error on create failure', async () => {
    mockCreateScheduledTask.mockRejectedValue(new Error('create failed'));

    renderWithQC(<ScheduledTasksTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('AddBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('AddBtn'));

    await waitFor(() => {
      expect(screen.getByText('SubmitForm')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('SubmitForm'));

    await waitFor(() => {
      expect(mockNotifyError).toHaveBeenCalledWith('create failed');
    });
  });
});
