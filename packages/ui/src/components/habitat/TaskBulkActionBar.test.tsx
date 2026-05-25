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

vi.mock('../ui/ConfirmDialog.js', () => ({
  ConfirmDialog: ({ open, onConfirm, onCancel, title, description, confirmLabel, variant: _variant }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <span>{description}</span>
        <button data-testid="confirm-dialog-confirm" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button data-testid="confirm-dialog-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: () => ({
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
    render(<TaskBulkActionBar habitatId="board-1" />);
    expect(screen.getByText('3 tasks selected')).toBeInTheDocument();
  });

  it('renders Set Priority as default operation', () => {
    render(<TaskBulkActionBar habitatId="board-1" />);
    const operationSelect = screen.getByTestId('bulk-operation') as HTMLSelectElement;
    expect(operationSelect.value).toBe('priority');
  });

  it('calls api.tasks.batch with correct operations for priority change', async () => {
    render(<TaskBulkActionBar habitatId="board-1" />);

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

  it('shows confirmation dialog before deleting', async () => {
    render(<TaskBulkActionBar habitatId="board-1" />);

    const operationSelect = screen.getByTestId('bulk-operation') as HTMLSelectElement;
    fireEvent.change(operationSelect, { target: { value: 'delete' } });

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete tasks')).toBeInTheDocument();
  });

  it('calls api.tasks.batch with delete operation after confirmation', async () => {
    render(<TaskBulkActionBar habitatId="board-1" />);

    const operationSelect = screen.getByTestId('bulk-operation') as HTMLSelectElement;
    fireEvent.change(operationSelect, { target: { value: 'delete' } });

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    const confirmButton = screen.getByTestId('confirm-dialog-confirm');
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockBatch).toHaveBeenCalledWith('board-1', {
        taskIds: ['task-1', 'task-2', 'task-3'],
        operation: 'delete',
        payload: {},
      });
    });
  });

  it('does not delete when confirmation dialog is cancelled', async () => {
    render(<TaskBulkActionBar habitatId="board-1" />);

    const operationSelect = screen.getByTestId('bulk-operation') as HTMLSelectElement;
    fireEvent.change(operationSelect, { target: { value: 'delete' } });

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    const cancelButton = screen.getByTestId('confirm-dialog-cancel');
    fireEvent.click(cancelButton);

    expect(mockBatch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('clears selection after successful operation', async () => {
    render(<TaskBulkActionBar habitatId="board-1" />);

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(mockClearTaskSelection).toHaveBeenCalled();
      expect(mockSetTaskBulkSelectMode).toHaveBeenCalledWith(false);
    });
  });

  it('clears selection when cancel is clicked', () => {
    render(<TaskBulkActionBar habitatId="board-1" />);

    const buttons = screen.getAllByRole('button');
    const cancelButton = buttons.find((b) => b.textContent?.includes('Cancel'));
    fireEvent.click(cancelButton!);

    expect(mockClearTaskSelection).toHaveBeenCalled();
    expect(mockSetTaskBulkSelectMode).toHaveBeenCalledWith(false);
  });

  it('handles batch error gracefully', async () => {
    mockBatch.mockRejectedValue(new Error('Server error'));

    render(<TaskBulkActionBar habitatId="board-1" />);

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Server error');
    });
  });

  it('shows Delete button text when delete operation selected', () => {
    render(<TaskBulkActionBar habitatId="board-1" />);

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

    render(<TaskBulkActionBar habitatId="board-1" />);

    const applyButton = screen.getByTestId('bulk-apply');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalled();
      expect(notifyWarning).toHaveBeenCalledWith('1 task failed to update');
    });
  });
});
