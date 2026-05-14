import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TaskBulkActionBar } from './TaskBulkActionBar.js';

const { mockBatch, mockClearTaskSelection, mockSetTaskBulkSelectMode, notifySuccess, notifyWarning, notifyError } = vi.hoisted(() => ({
  mockBatch: vi.fn(),
  mockClearTaskSelection: vi.fn(),
  mockSetTaskBulkSelectMode: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('../../store/habitatStore.js', () => ({
  useBoardStore: () => ({
    selectedTaskIds: ['task-1', 'task-2', 'task-3'],
    clearTaskSelection: mockClearTaskSelection,
    setTaskBulkSelectMode: mockSetTaskBulkSelectMode,
  }),
}));

vi.mock('../../api/index.js', () => ({
  api: {
    tasks: {
      batch: (...args: unknown[]) => mockBatch(...args),
    },
  },
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: notifySuccess,
    warning: notifyWarning,
    error: notifyError,
  },
}));

describe('TaskBulkActionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    mockBatch.mockResolvedValue({
      successCount: 3,
      failureCount: 0,
      results: [],
    });
  });

  it('shows selected count', () => {
    render(<TaskBulkActionBar boardId="board-1" />);
    expect(screen.getByText('3 tasks selected')).toBeInTheDocument();
  });

  it('renders Set Priority as default operation', () => {
    render(<TaskBulkActionBar boardId="board-1" />);
    const operationSelect = screen.getByTestId('bulk-operation') as HTMLSelectElement;
    expect(operationSelect.value).toBe('priority');
  });

  it('calls api.tasks.batch with correct operations for priority change', async () => {
    render(<TaskBulkActionBar boardId="board-1" />);

    const prioritySelect = screen.getByTestId('bulk-priority') as HTMLSelectElement;
    fireEvent.change(prioritySelect, { target: { value: 'critical' } });

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(mockBatch).toHaveBeenCalledWith('board-1', {
        taskIds: ['task-1', 'task-2', 'task-3'],
        operation: 'priority',
        payload: { priority: 'critical' },
      });
    });
  });

  it('calls api.tasks.batch with delete operation', async () => {
    render(<TaskBulkActionBar boardId="board-1" />);

    const operationSelect = screen.getByTestId('bulk-operation') as HTMLSelectElement;
    fireEvent.change(operationSelect, { target: { value: 'delete' } });

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(mockBatch).toHaveBeenCalledWith('board-1', {
        taskIds: ['task-1', 'task-2', 'task-3'],
        operation: 'delete',
        payload: {},
      });
    });
  });

  it('clears selection after successful operation', async () => {
    render(<TaskBulkActionBar boardId="board-1" />);

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(mockClearTaskSelection).toHaveBeenCalled();
      expect(mockSetTaskBulkSelectMode).toHaveBeenCalledWith(false);
    });
  });

  it('clears selection when cancel is clicked', () => {
    render(<TaskBulkActionBar boardId="board-1" />);

    const buttons = screen.getAllByRole('button');
    const cancelButton = buttons.find((b) => b.textContent?.includes('Cancel'));
    fireEvent.click(cancelButton!);

    expect(mockClearTaskSelection).toHaveBeenCalled();
    expect(mockSetTaskBulkSelectMode).toHaveBeenCalledWith(false);
  });

  it('handles batch error gracefully', async () => {
    mockBatch.mockRejectedValue(new Error('Server error'));

    render(<TaskBulkActionBar boardId="board-1" />);

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Server error');
    });
  });

  it('shows Delete button text when delete operation selected', () => {
    render(<TaskBulkActionBar boardId="board-1" />);

    const operationSelect = screen.getByTestId('bulk-operation');
    fireEvent.change(operationSelect, { target: { value: 'delete' } });

    const applyButton = screen.getByTestId('bulk-apply');
    expect(applyButton.textContent).toContain('Delete');
  });

  it('reports partial failures in success message', async () => {
    mockBatch.mockResolvedValue({
      successCount: 2,
      failureCount: 1,
      results: [{ taskId: 'task-3', success: false, error: 'Not found' }],
    });

    render(<TaskBulkActionBar boardId="board-1" />);

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalled();
      expect(notifyWarning).toHaveBeenCalledWith('1 task failed to update');
    });
  });
});
