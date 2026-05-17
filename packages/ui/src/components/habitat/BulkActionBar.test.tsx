import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkActionBar } from './BulkActionBar.js';
import type { TaskPriority } from '../../types/index.js';

// Mock the API
const mockDelete = vi.fn();
const mockUpdate = vi.fn();
const mockMove = vi.fn();

vi.mock('../../api/index.js', () => ({
  api: {
    missions: {
      delete: (...args: unknown[]) => mockDelete(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      move: (...args: unknown[]) => mockMove(...args),
    },
  },
}));

// Mock the toast notification
vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the board store
const mockUpdateFeature = vi.fn();
const mockRemoveFeature = vi.fn();
const mockClearFeatureSelection = vi.fn();
const mockSetBulkSelectMode = vi.fn();

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: vi.fn(() => ({
    selectedMissionIds: ['feat-1', 'feat-2', 'feat-3'],
    updateFeature: mockUpdateFeature,
    removeFeature: mockRemoveFeature,
    clearMissionSelection: mockClearFeatureSelection,
    setBulkSelectMode: mockSetBulkSelectMode,
    columns: [
      { id: 'col-1', habitatId: 'board-1', name: 'Backlog', order: 0, isTerminal: false },
      { id: 'col-2', habitatId: 'board-1', name: 'In Progress', order: 1, isTerminal: false },
      { id: 'col-3', habitatId: 'board-1', name: 'Review', order: 2, isTerminal: false },
      { id: 'col-4', habitatId: 'board-1', name: 'Done', order: 3, isTerminal: true },
    ],
  })),
}));

describe('BulkActionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue({ feature: {} });
    mockMove.mockResolvedValue({ feature: {} });
  });

  describe('Rendering', () => {
    it('renders with selected feature count', () => {
      render(<BulkActionBar habitatId="board-1" />);
      expect(screen.getByText('3 features selected')).toBeTruthy();
    });

    it('renders with Set Priority as default operation', () => {
      render(<BulkActionBar habitatId="board-1" />);
      const selects = screen.getAllByRole('combobox');
      const operationSelect = selects[0] as HTMLSelectElement;
      expect(operationSelect.value).toBe('priority');
    });
  });

  describe('Bulk Delete', () => {
    it('calls api.missions.delete for each selected feature', async () => {
      render(<BulkActionBar habitatId="board-1" />);

      // Change to delete operation
      const operationSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(operationSelect, { target: { value: 'delete' } });

      // Click delete button
      const buttons = screen.getAllByRole('button');
      const deleteButton = buttons.find(b => b.textContent?.includes('Delete'));
      fireEvent.click(deleteButton!);

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledTimes(3);
        expect(mockDelete).toHaveBeenCalledWith('feat-1');
        expect(mockDelete).toHaveBeenCalledWith('feat-2');
        expect(mockDelete).toHaveBeenCalledWith('feat-3');
      });
    });

    it('removes each feature from store after successful delete', async () => {
      render(<BulkActionBar habitatId="board-1" />);

      const operationSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(operationSelect, { target: { value: 'delete' } });

      const buttons = screen.getAllByRole('button');
      const deleteButton = buttons.find(b => b.textContent?.includes('Delete'));
      fireEvent.click(deleteButton!);

      await waitFor(() => {
        expect(mockRemoveFeature).toHaveBeenCalledTimes(3);
        expect(mockRemoveFeature).toHaveBeenCalledWith('feat-1');
        expect(mockRemoveFeature).toHaveBeenCalledWith('feat-2');
        expect(mockRemoveFeature).toHaveBeenCalledWith('feat-3');
      });
    });

    it('clears selection after successful delete', async () => {
      render(<BulkActionBar habitatId="board-1" />);

      const operationSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(operationSelect, { target: { value: 'delete' } });

      const buttons = screen.getAllByRole('button');
      const deleteButton = buttons.find(b => b.textContent?.includes('Delete'));
      fireEvent.click(deleteButton!);

      await waitFor(() => {
        expect(mockClearFeatureSelection).toHaveBeenCalled();
        expect(mockSetBulkSelectMode).toHaveBeenCalledWith(false);
      });
    });
  });

  describe('Bulk Priority Change', () => {
    it('calls api.missions.update with default priority for each feature', async () => {
      render(<BulkActionBar habitatId="board-1" />);

      // Default priority is 'medium' - just click apply
      const buttons = screen.getAllByRole('button');
      const applyButton = buttons.find(b => b.textContent?.includes('Apply'));
      fireEvent.click(applyButton!);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledTimes(3);
        expect(mockUpdate).toHaveBeenCalledWith('feat-1', { priority: 'medium' });
        expect(mockUpdate).toHaveBeenCalledWith('feat-2', { priority: 'medium' });
        expect(mockUpdate).toHaveBeenCalledWith('feat-3', { priority: 'medium' });
      });
    });

    it('updates each feature in store after successful priority change', async () => {
      const updatedFeature = {
        id: 'feat-1',
        priority: 'high' as TaskPriority,
        columnId: 'col-1',
        habitatId: 'board-1',
        title: 'Test',
        description: '',
        acceptanceCriteria: '',
        labels: [],
        status: 'in_progress' as const,
        displayOrder: 0,
        dependsOn: [],
        blocks: [],
        dueAt: null,
        slaMinutes: null,
        slaDeadlineAt: null,
        createdBy: 'user-1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        version: 1,
        progress: { total: 0, pending: 0, claimed: 0, inProgress: 0, submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0, percentage: 0 },
      };

      mockUpdate.mockResolvedValue({ feature: updatedFeature });

      render(<BulkActionBar habitatId="board-1" />);

      const selects = screen.getAllByRole('combobox');
      const prioritySelect = selects[1];
      fireEvent.change(prioritySelect, { target: { value: 'critical' } });

      const buttons = screen.getAllByRole('button');
      const applyButton = buttons.find(b => b.textContent?.includes('Apply'));
      fireEvent.click(applyButton!);

      await waitFor(() => {
        expect(mockUpdateFeature).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('Bulk Move', () => {
    it('shows column selection when move operation is selected', () => {
      render(<BulkActionBar habitatId="board-1" />);

      const operationSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(operationSelect, { target: { value: 'move' } });

      // After switching to move, there should be a Move button visible
      const buttons = screen.getAllByRole('button');
      const moveButton = buttons.find(b => b.textContent === 'Move');
      expect(moveButton).toBeTruthy();
    });

    it('disables apply button when no target column is selected', () => {
      render(<BulkActionBar habitatId="board-1" />);

      const operationSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(operationSelect, { target: { value: 'move' } });

      const buttons = screen.getAllByRole('button');
      const moveButton = buttons.find(b => b.textContent === 'Move');
      expect((moveButton as HTMLButtonElement).disabled).toBe(true);
    });

    it('calls api.missions.move with correct columnId for each feature', async () => {
      render(<BulkActionBar habitatId="board-1" />);

      const operationSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(operationSelect, { target: { value: 'move' } });

      // Select target column - the second select is the column select
      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[1], { target: { value: 'col-2' } });

      const buttons = screen.getAllByRole('button');
      const moveButton = buttons.find(b => b.textContent === 'Move');
      fireEvent.click(moveButton!);

      await waitFor(() => {
        expect(mockMove).toHaveBeenCalledTimes(3);
        expect(mockMove).toHaveBeenCalledWith('feat-1', { columnId: 'col-2' });
        expect(mockMove).toHaveBeenCalledWith('feat-2', { columnId: 'col-2' });
        expect(mockMove).toHaveBeenCalledWith('feat-3', { columnId: 'col-2' });
      });
    });

    it('updates each feature in store after successful move', async () => {
      const movedFeature = {
        id: 'feat-1',
        columnId: 'col-2',
        habitatId: 'board-1',
        title: 'Test',
        description: '',
        acceptanceCriteria: '',
        priority: 'medium' as TaskPriority,
        labels: [],
        status: 'in_progress' as const,
        displayOrder: 0,
        dependsOn: [],
        blocks: [],
        dueAt: null,
        slaMinutes: null,
        slaDeadlineAt: null,
        createdBy: 'user-1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        version: 1,
        progress: { total: 0, pending: 0, claimed: 0, inProgress: 0, submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0, percentage: 0 },
      };

      mockMove.mockResolvedValue({ feature: movedFeature });

      render(<BulkActionBar habitatId="board-1" />);

      const operationSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(operationSelect, { target: { value: 'move' } });

      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[1], { target: { value: 'col-3' } });

      const buttons = screen.getAllByRole('button');
      const moveButton = buttons.find(b => b.textContent === 'Move');
      fireEvent.click(moveButton!);

      await waitFor(() => {
        expect(mockUpdateFeature).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('Cancel', () => {
    it('clears selection when cancel is clicked', () => {
      render(<BulkActionBar habitatId="board-1" />);

      const buttons = screen.getAllByRole('button');
      const cancelButton = buttons.find(b => b.textContent?.includes('Cancel'));
      fireEvent.click(cancelButton!);

      expect(mockClearFeatureSelection).toHaveBeenCalled();
      expect(mockSetBulkSelectMode).toHaveBeenCalledWith(false);
    });
  });

  describe('Error Handling', () => {
    it('handles delete operation with error', async () => {
      // When delete fails, removeFeature should not be called
      mockDelete.mockReset();
      mockDelete.mockRejectedValue(new Error('Server error'));

      render(<BulkActionBar habitatId="board-1" />);

      const operationSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(operationSelect, { target: { value: 'delete' } });

      const buttons = screen.getAllByRole('button');
      const deleteButton = buttons.find(b => b.textContent?.includes('Delete'));
      fireEvent.click(deleteButton!);

      await waitFor(() => {
        // When delete fails, removeFeature should not be called
        expect(mockRemoveFeature).not.toHaveBeenCalled();
      });
    });

    it('handles update operation with error', async () => {
      // When update fails, updateFeature should not be called
      mockUpdate.mockReset();
      mockUpdate.mockRejectedValue(new Error('Network error'));

      render(<BulkActionBar habitatId="board-1" />);

      const buttons = screen.getAllByRole('button');
      const applyButton = buttons.find(b => b.textContent?.includes('Apply'));
      fireEvent.click(applyButton!);

      await waitFor(() => {
        // When update fails, updateFeature should not be called
        expect(mockUpdateFeature).not.toHaveBeenCalled();
      });
    });
  });
});
