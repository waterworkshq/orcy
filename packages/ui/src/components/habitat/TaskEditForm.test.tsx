import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TaskEditForm } from './TaskEditForm.js';

vi.mock('../ui/RichTextEditor.js', () => ({
  RichTextEditor: ({ placeholder }: { placeholder?: string }) => (
    <textarea placeholder={placeholder} data-testid="rich-text-editor" />
  ),
}));

const defaultEditForm = {
  title: 'Test Task',
  description: 'Test Description',
  priority: 'medium' as const,
  labels: '',
  requiredDomain: '',
  requiredCapabilities: [] as string[],
};

const defaultRetryForm = {
  maxRetries: '',
  backoffBase: '',
  backoffMultiplier: '',
  maxBackoff: '',
  escalateToHuman: true,
};

const defaultProps = {
  editForm: defaultEditForm,
  editDueAt: '',
  editSlaMinutes: '',
  editEstimatedMinutes: '',
  retryForm: defaultRetryForm,
  onFormChange: vi.fn(),
  onDueAtChange: vi.fn(),
  onSlaMinutesChange: vi.fn(),
  onEstimatedMinutesChange: vi.fn(),
  onRetryFormChange: vi.fn(),
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
};

describe('TaskEditForm', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders required capabilities input', () => {
    render(<TaskEditForm {...defaultProps} />);
    expect(screen.getByPlaceholderText('Add capability (e.g., typescript)')).toBeInTheDocument();
  });

  it('displays existing capabilities as badges', () => {
    const props = {
      ...defaultProps,
      editForm: { ...defaultEditForm, requiredCapabilities: ['typescript', 'react'] },
    };
    render(<TaskEditForm {...props} />);
    expect(screen.getByText('typescript')).toBeInTheDocument();
    expect(screen.getByText('react')).toBeInTheDocument();
  });

  it('adds a capability when clicking Add', () => {
    const onFormChange = vi.fn();
    const props = {
      ...defaultProps,
      editForm: { ...defaultEditForm, requiredCapabilities: ['typescript'] },
      onFormChange,
    };
    render(<TaskEditForm {...props} />);

    const input = screen.getByPlaceholderText('Add capability (e.g., typescript)');
    fireEvent.change(input, { target: { value: 'python' } });

    const addButton = screen.getByRole('button', { name: 'Add' });
    fireEvent.click(addButton);

    expect(onFormChange).toHaveBeenCalledWith({
      ...defaultEditForm,
      requiredCapabilities: ['typescript', 'python'],
    });
  });

  it('does not add duplicate capabilities', () => {
    const onFormChange = vi.fn();
    const props = {
      ...defaultProps,
      editForm: { ...defaultEditForm, requiredCapabilities: ['typescript'] },
      onFormChange,
    };
    render(<TaskEditForm {...props} />);

    const input = screen.getByPlaceholderText('Add capability (e.g., typescript)');
    fireEvent.change(input, { target: { value: 'typescript' } });

    const addButton = screen.getByRole('button', { name: 'Add' });
    fireEvent.click(addButton);

    expect(onFormChange).not.toHaveBeenCalled();
  });

  it('does not add empty capability', () => {
    const onFormChange = vi.fn();
    const props = { ...defaultProps, onFormChange };
    render(<TaskEditForm {...props} />);

    const addButton = screen.getByRole('button', { name: 'Add' });
    fireEvent.click(addButton);

    expect(onFormChange).not.toHaveBeenCalled();
  });

  it('adds capability on Enter key press', () => {
    const onFormChange = vi.fn();
    const props = { ...defaultProps, onFormChange };
    render(<TaskEditForm {...props} />);

    const input = screen.getByPlaceholderText('Add capability (e.g., typescript)');
    fireEvent.change(input, { target: { value: 'python' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onFormChange).toHaveBeenCalledWith({
      ...defaultEditForm,
      requiredCapabilities: ['python'],
    });
  });

  it('removes a capability when clicking remove button', () => {
    const onFormChange = vi.fn();
    const props = {
      ...defaultProps,
      editForm: { ...defaultEditForm, requiredCapabilities: ['typescript', 'react', 'python'] },
      onFormChange,
    };
    render(<TaskEditForm {...props} />);

    const removeButton = screen.getByLabelText('Remove react');
    fireEvent.click(removeButton);

    expect(onFormChange).toHaveBeenCalledWith({
      ...defaultEditForm,
      requiredCapabilities: ['typescript', 'python'],
    });
  });

  it('save action includes updated capabilities', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const props = {
      ...defaultProps,
      editForm: { ...defaultEditForm, requiredCapabilities: ['typescript'] },
      onSubmit,
    };
    render(<TaskEditForm {...props} />);

    const saveButton = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveButton);

    expect(onSubmit).toHaveBeenCalled();
  });
});
