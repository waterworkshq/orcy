import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TaskSubtasks } from './TaskSubtasks.js';

vi.mock('../ui/Button.js', () => ({
  Button: ({ children, onClick, disabled, type, variant, size }: any) => (
    <button onClick={onClick} disabled={disabled} type={type} data-variant={variant} data-size={size}>{children}</button>
  ),
}));

const makeSubtask = (overrides: Partial<{ id: string; title: string; completed: boolean }> = {}) => ({
  id: overrides.id ?? 'sub-1',
  taskId: 'task-1',
  title: overrides.title ?? 'Test subtask',
  completed: overrides.completed ?? false,
  order: 0,
  assigneeId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('TaskSubtasks', () => {
  const defaultProps = {
    subtasks: [] as any[],
    contextLoading: false,
    newSubtaskTitle: '',
    addingSubtask: false,
    onTitleChange: vi.fn(),
    onAdd: vi.fn(),
    onToggle: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders subtasks section heading', () => {
    render(<TaskSubtasks {...defaultProps} />);
    expect(screen.getByText('Subtasks')).toBeTruthy();
  });

  it('does not show counter when no subtasks', () => {
    render(<TaskSubtasks {...defaultProps} />);
    expect(screen.queryByText(/\(\d+\/\d+\)/)).toBeNull();
  });

  it('shows loading state when contextLoading is true', () => {
    render(<TaskSubtasks {...defaultProps} contextLoading={true} />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('does not render subtask list while loading', () => {
    const subtasks = [makeSubtask()];
    render(<TaskSubtasks {...defaultProps} contextLoading={true} subtasks={subtasks} />);
    expect(screen.queryByText('Test subtask')).toBeNull();
  });

  it('renders subtask titles', () => {
    const subtasks = [makeSubtask(), makeSubtask({ id: 'sub-2', title: 'Another subtask' })];
    render(<TaskSubtasks {...defaultProps} subtasks={subtasks} />);
    expect(screen.getByText('Test subtask')).toBeTruthy();
    expect(screen.getByText('Another subtask')).toBeTruthy();
  });

  it('shows completed/total counter', () => {
    const subtasks = [
      makeSubtask({ completed: true }),
      makeSubtask({ id: 'sub-2', title: 'Second', completed: false }),
    ];
    render(<TaskSubtasks {...defaultProps} subtasks={subtasks} />);
    expect(screen.getByText('(1/2)')).toBeTruthy();
  });

  it('calls onToggle when subtask toggle button clicked', () => {
    const subtask = makeSubtask();
    render(<TaskSubtasks {...defaultProps} subtasks={[subtask]} />);
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);
    expect(defaultProps.onToggle).toHaveBeenCalledWith(subtask);
  });

  it('calls onDelete when delete button clicked', () => {
    const subtask = makeSubtask();
    render(<TaskSubtasks {...defaultProps} subtasks={[subtask]} />);
    const buttons = screen.getAllByRole('button');
    const deleteBtn = buttons[buttons.length - 2];
    fireEvent.click(deleteBtn);
    expect(defaultProps.onDelete).toHaveBeenCalledWith(subtask);
  });

  it('renders add subtask form', () => {
    render(<TaskSubtasks {...defaultProps} />);
    expect(screen.getByPlaceholderText('Add subtask...')).toBeTruthy();
  });

  it('calls onTitleChange when input value changes', () => {
    render(<TaskSubtasks {...defaultProps} />);
    const input = screen.getByPlaceholderText('Add subtask...');
    fireEvent.change(input, { target: { value: 'New item' } });
    expect(defaultProps.onTitleChange).toHaveBeenCalledWith('New item');
  });

  it('disables add button when title is empty', () => {
    render(<TaskSubtasks {...defaultProps} newSubtaskTitle="" />);
    const buttons = screen.getAllByRole('button');
    const submitBtn = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('disables add button when title is whitespace only', () => {
    render(<TaskSubtasks {...defaultProps} newSubtaskTitle="   " />);
    const buttons = screen.getAllByRole('button');
    const submitBtn = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('disables add button when addingSubtask is true', () => {
    render(<TaskSubtasks {...defaultProps} newSubtaskTitle="New" addingSubtask={true} />);
    const buttons = screen.getAllByRole('button');
    const submitBtn = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('enables add button when title has content and not adding', () => {
    render(<TaskSubtasks {...defaultProps} newSubtaskTitle="New subtask" />);
    const buttons = screen.getAllByRole('button');
    const submitBtn = buttons[buttons.length - 1] as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
  });

  it('calls onAdd when form is submitted', () => {
    render(<TaskSubtasks {...defaultProps} newSubtaskTitle="A new subtask" />);
    const form = screen.getByPlaceholderText('Add subtask...').closest('form')!;
    fireEvent.submit(form);
    expect(defaultProps.onAdd).toHaveBeenCalled();
  });

  it('renders completed subtask with line-through styling', () => {
    const subtask = makeSubtask({ completed: true });
    render(<TaskSubtasks {...defaultProps} subtasks={[subtask]} />);
    const titleEl = screen.getByText('Test subtask');
    expect(titleEl.className).toContain('line-through');
  });

  it('renders incomplete subtask without line-through styling', () => {
    const subtask = makeSubtask({ completed: false });
    render(<TaskSubtasks {...defaultProps} subtasks={[subtask]} />);
    const titleEl = screen.getByText('Test subtask');
    expect(titleEl.className).not.toContain('line-through');
  });

  it('shows input with current newSubtaskTitle value', () => {
    render(<TaskSubtasks {...defaultProps} newSubtaskTitle="Existing text" />);
    const input = screen.getByPlaceholderText('Add subtask...') as HTMLInputElement;
    expect(input.value).toBe('Existing text');
  });
});
