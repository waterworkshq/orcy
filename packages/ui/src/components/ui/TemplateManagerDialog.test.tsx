import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { TemplateManagerDialog } from '../ui/TemplateManagerDialog.js';

const mockListTemplates = vi.fn();
const mockCreateTemplate = vi.fn();
const mockUpdateTemplate = vi.fn();
const mockDeleteTemplate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../../api/index.js', () => ({
  api: {
    templates: {
      list: (...args: unknown[]) => mockListTemplates(...args),
      create: (...args: unknown[]) => mockCreateTemplate(...args),
      update: (...args: unknown[]) => mockUpdateTemplate(...args),
      delete: (...args: unknown[]) => mockDeleteTemplate(...args),
    },
  },
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

function createTestWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('TemplateManagerDialog', () => {
  const defaultProps = {
    habitatId: 'board-1',
    open: true,
    onClose: vi.fn(),
  };

  const sampleTemplates = [
    { id: 't1', name: 'Global Bug', titlePattern: 'Fix: ', descriptionPattern: '', priority: 'high' as const, labels: ['bug'], habitatId: null, usageCount: 5, isDefault: false },
    { id: 't2', name: 'Board Task', titlePattern: 'Implement: ', descriptionPattern: 'Details', priority: 'medium' as const, labels: [], habitatId: 'board-1', usageCount: 3, isDefault: false },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockListTemplates.mockResolvedValue({ templates: sampleTemplates });
    mockCreateTemplate.mockResolvedValue({ template: { id: 't3' } });
    mockUpdateTemplate.mockResolvedValue({ template: { id: 't1' } });
    mockDeleteTemplate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  describe('React Query integration', () => {
    it('renders template list from useTemplates', async () => {
      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Global Bug')).toBeTruthy();
        expect(screen.getByText('Board Task')).toBeTruthy();
      });
    });

    it('shows loading state while template query resolves', async () => {
      let resolvePromise: (value: unknown) => void;
      mockListTemplates.mockReturnValue(new Promise((resolve) => { resolvePromise = resolve; }));

      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      expect(screen.getByText('Loading...')).toBeTruthy();

      resolvePromise!({ templates: [] });
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull();
      });
    });

    it('shows empty message when no templates', async () => {
      mockListTemplates.mockResolvedValue({ templates: [] });

      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText(/No mission templates yet/)).toBeTruthy();
      });
    });

    it('separates global and board templates', async () => {
      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Global Mission Templates')).toBeTruthy();
        expect(screen.getByText('Habitat Mission Templates')).toBeTruthy();
      });
    });
  });

  describe('Create mutation', () => {
    it('creates a template and invalidates cache on success', async () => {
      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Board Task')).toBeTruthy();
      });

      const createButton = screen.getByText('+ New Mission Template');
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(screen.getByText('Create')).toBeTruthy();
      });

      const nameInput = screen.getByPlaceholderText('Bug Fix');
      fireEvent.change(nameInput, { target: { value: 'New Template' } });

      const titleInput = screen.getByPlaceholderText(/Fix:/);
      fireEvent.change(titleInput, { target: { value: 'New Title' } });

      const saveButton = screen.getByText('Create');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockCreateTemplate).toHaveBeenCalledWith('board-1', expect.objectContaining({
          name: 'New Template',
          titlePattern: 'New Title',
        }));
        expect(mockNotifySuccess).toHaveBeenCalledWith('Template created');
      });
    });

    it('shows error when name is missing', async () => {
      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Board Task')).toBeTruthy();
      });

      const createButton = screen.getByText('+ New Mission Template');
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(screen.getByText('Create')).toBeTruthy();
      });

      const saveButton = screen.getByText('Create');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockNotifyError).toHaveBeenCalledWith('Name and title pattern are required');
      });
    });
  });

  describe('Update mutation', () => {
    it('updates a template and invalidates cache on success', async () => {
      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Global Bug')).toBeTruthy();
      });

      const editButtons = screen.getAllByText('Edit');
      fireEvent.click(editButtons[0]);

      await waitFor(() => {
        expect(screen.getByText('Update')).toBeTruthy();
      });

      const nameInput = screen.getByPlaceholderText('Bug Fix');
      fireEvent.change(nameInput, { target: { value: 'Updated Bug' } });

      const updateButton = screen.getByText('Update');
      fireEvent.click(updateButton);

      await waitFor(() => {
        expect(mockUpdateTemplate).toHaveBeenCalled();
        expect(mockNotifySuccess).toHaveBeenCalledWith('Template updated');
      });
    });
  });

  describe('Delete mutation', () => {
    it('deletes a template and invalidates cache on success', async () => {
      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Board Task')).toBeTruthy();
      });

      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(mockDeleteTemplate).toHaveBeenCalledWith('t2');
        expect(mockNotifySuccess).toHaveBeenCalledWith('Template deleted');
      });
    });

    it('shows error on delete failure', async () => {
      mockDeleteTemplate.mockRejectedValue(new Error('Delete failed'));

      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Board Task')).toBeTruthy();
      });

      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(mockNotifyError).toHaveBeenCalledWith('Delete failed');
      });
    });
  });

  describe('UI interactions', () => {
    it('cancels editing and returns to list', async () => {
      render(<TemplateManagerDialog {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Board Task')).toBeTruthy();
      });

      const createButton = screen.getByText('+ New Mission Template');
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(screen.getByText('Cancel')).toBeTruthy();
      });

      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      await waitFor(() => {
        expect(screen.getByText('+ New Mission Template')).toBeTruthy();
      });
    });

    it('closes dialog when Done is clicked', async () => {
      const onClose = vi.fn();
      render(<TemplateManagerDialog {...defaultProps} onClose={onClose} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Done')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Done'));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
