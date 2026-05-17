import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { CreateTaskForm } from './CreateTaskForm.js';

const mockCreateTask = vi.fn();
const mockListTemplates = vi.fn();
const mockRecordUsage = vi.fn();
const mockAddTask = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../../api/index.js', () => ({
  api: {
    missions: {
      createTask: (...args: unknown[]) => mockCreateTask(...args),
    },
    templates: {
      list: (...args: unknown[]) => mockListTemplates(...args),
      recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
    },
  },
}));

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: vi.fn(() => ({
    columns: [],
    addTask: mockAddTask,
  })),
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('../ui/RichTextEditor.js', () => ({
  RichTextEditor: ({ placeholder }: { placeholder?: string }) => (
    <textarea placeholder={placeholder} data-testid="rich-text-editor" />
  ),
}));

function createTestWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('CreateTaskForm', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    habitatId: 'board-1',
    missionId: 'feat-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTask.mockResolvedValue({ task: { id: 'task-1', title: 'Test' } });
    mockListTemplates.mockResolvedValue({ templates: [] });
    mockRecordUsage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Tags input widget', () => {
    it('renders the required capabilities label and input', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      expect(screen.getByText('Required Capabilities')).toBeTruthy();
      expect(screen.getByPlaceholderText('e.g., typescript, react, python, node.js')).toBeTruthy();
    });

    it('shows placeholder text suggesting common values', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      expect(input).toBeTruthy();
    });

    it('adds a tag on Enter key press', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      fireEvent.change(input, { target: { value: 'typescript' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(screen.getByText('typescript')).toBeTruthy();
    });

    it('adds a tag on comma key press', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      fireEvent.change(input, { target: { value: 'react' } });
      fireEvent.keyDown(input, { key: ',' });

      expect(screen.getByText('react')).toBeTruthy();
    });

    it('adds a tag on blur when input has content', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      fireEvent.change(input, { target: { value: 'python' } });
      fireEvent.blur(input);

      expect(screen.getByText('python')).toBeTruthy();
    });

    it('does not add empty tags', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      const chips = screen.queryAllByText('×');
      expect(chips.length).toBe(0);
    });

    it('does not add duplicate tags', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      fireEvent.change(input, { target: { value: 'typescript' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.change(input, { target: { value: 'typescript' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      const chips = screen.getAllByText('typescript');
      expect(chips.length).toBe(1);
    });

    it('clears input after adding a tag', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'typescript' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(input.value).toBe('');
    });

    it('trims whitespace from tags', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      fireEvent.change(input, { target: { value: '  typescript  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(screen.getByText('typescript')).toBeTruthy();
    });

    it('removes a tag when X button is clicked', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      fireEvent.change(input, { target: { value: 'typescript' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.change(input, { target: { value: 'react' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(screen.getByText('typescript')).toBeTruthy();
      expect(screen.getByText('react')).toBeTruthy();

      const removeButtons = screen.getAllByLabelText(/Remove/);
      fireEvent.click(removeButtons[0]);

      expect(screen.queryByText('typescript')).toBeNull();
      expect(screen.getByText('react')).toBeTruthy();
    });

    it('renders multiple tags', () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });
      const input = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      const tags = ['typescript', 'react', 'python'];
      tags.forEach((tag) => {
        fireEvent.change(input, { target: { value: tag } });
        fireEvent.keyDown(input, { key: 'Enter' });
      });

      tags.forEach((tag) => {
        expect(screen.getByText(tag)).toBeTruthy();
      });
    });
  });

  describe('Form submission with capabilities', () => {
    it('includes capabilities in form submission payload', async () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });

      const titleInput = screen.getByPlaceholderText('Task title');
      fireEvent.change(titleInput, { target: { value: 'My Task' } });

      const capsInput = screen.getByPlaceholderText('e.g., typescript, react, python, node.js');
      fireEvent.change(capsInput, { target: { value: 'typescript' } });
      fireEvent.keyDown(capsInput, { key: 'Enter' });
      fireEvent.change(capsInput, { target: { value: 'react' } });
      fireEvent.keyDown(capsInput, { key: 'Enter' });

      const submitButton = screen.getByRole('button', { name: 'Create Task' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCreateTask).toHaveBeenCalledWith('feat-1', expect.objectContaining({
          requiredCapabilities: ['typescript', 'react'],
        }));
      });
    });

    it('sends undefined capabilities when none are added', async () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });

      const titleInput = screen.getByPlaceholderText('Task title');
      fireEvent.change(titleInput, { target: { value: 'My Task' } });

      const submitButton = screen.getByRole('button', { name: 'Create Task' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCreateTask).toHaveBeenCalledWith('feat-1', expect.objectContaining({
          requiredCapabilities: undefined,
        }));
      });
    });

    it('calls addTask after successful creation', async () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });

      const titleInput = screen.getByPlaceholderText('Task title');
      fireEvent.change(titleInput, { target: { value: 'My Task' } });

      const submitButton = screen.getByRole('button', { name: 'Create Task' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockAddTask).toHaveBeenCalledWith({ id: 'task-1', title: 'Test' });
      });
    });

    it('does not submit when title is empty', async () => {
      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });

      const submitButton = screen.getByRole('button', { name: 'Create Task' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCreateTask).not.toHaveBeenCalled();
      });
    });
  });

  describe('Template selection with capabilities', () => {
    const templateWithCaps = {
      id: 'tmpl-1',
      name: 'Frontend Task',
      titlePattern: 'Build Component',
      descriptionPattern: 'Implement UI',
      priority: 'high' as const,
      requiredDomain: 'frontend',
      requiredCapabilities: ['typescript', 'react'],
      habitatId: 'board-1',
      labels: [] as string[],
    };

    it('populates capabilities from template when selected', async () => {
      mockListTemplates.mockResolvedValue({ templates: [templateWithCaps] });

      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Frontend Task (board)')).toBeTruthy();
      });

      const templateSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(templateSelect, { target: { value: 'tmpl-1' } });

      expect(screen.getByText('typescript')).toBeTruthy();
      expect(screen.getByText('react')).toBeTruthy();
    });

    it('clears capabilities when template is deselected', async () => {
      mockListTemplates.mockResolvedValue({ templates: [templateWithCaps] });

      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Frontend Task (board)')).toBeTruthy();
      });

      const templateSelect = screen.getAllByRole('combobox')[0];
      fireEvent.change(templateSelect, { target: { value: 'tmpl-1' } });

      expect(screen.getByText('typescript')).toBeTruthy();
      expect(screen.getByText('react')).toBeTruthy();

      fireEvent.change(templateSelect, { target: { value: '' } });

      expect(screen.queryByText('typescript')).toBeNull();
      expect(screen.queryByText('react')).toBeNull();
    });
  });

  describe('React Query integration', () => {
    it('renders template options from useTemplates', async () => {
      mockListTemplates.mockResolvedValue({ templates: [
        { id: 't1', name: 'Bug Fix', titlePattern: 'Fix: ', habitatId: 'board-1', labels: [] },
        { id: 't2', name: 'Feature', titlePattern: 'Add: ', habitatId: null, labels: [] },
      ] });

      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Bug Fix (board)')).toBeTruthy();
      });
      expect(screen.getByText('Feature (global)')).toBeTruthy();
    });

    it('does not show template selector when no templates', () => {
      mockListTemplates.mockResolvedValue({ templates: [] });

      render(<CreateTaskForm {...defaultProps} />, { wrapper: createTestWrapper() });

      expect(screen.queryByText('Template')).toBeNull();
    });

    it('invalidates RQ cache for tasks, details, and progress after creation', async () => {
      const invalidateSpy = vi.fn();
      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      qc.invalidateQueries = invalidateSpy;

      function Wrapper({ children }: { children: React.ReactNode }) {
        return React.createElement(QueryClientProvider, { client: qc }, children);
      }

      render(<CreateTaskForm {...defaultProps} />, { wrapper: Wrapper });

      const titleInput = screen.getByPlaceholderText('Task title');
      fireEvent.change(titleInput, { target: { value: 'My Task' } });

      const submitButton = screen.getByRole('button', { name: 'Create Task' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockAddTask).toHaveBeenCalled();
      });

      const invalidatedKeys = invalidateSpy.mock.calls.map(
        (call: any[]) => call[0]?.queryKey,
      );

      const hasKey = (prefix: string) =>
        invalidatedKeys.some((key) => JSON.stringify(key).includes(prefix));

      expect(hasKey('tasks')).toBe(true);
      expect(hasKey('details')).toBe(true);
      expect(hasKey('progress')).toBe(true);
    });
  });
});
