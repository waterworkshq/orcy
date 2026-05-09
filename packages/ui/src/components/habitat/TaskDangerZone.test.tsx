import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TaskDangerZone } from './TaskDangerZone.js';

vi.mock('../ui/Button.js', () => ({
  Button: ({ children, onClick, disabled, variant }: any) => (
    <button onClick={onClick} disabled={disabled} data-variant={variant}>{children}</button>
  ),
}));

vi.mock('../ui/ConfirmDialog.js', () => ({
  ConfirmDialog: ({ open, onConfirm, onCancel, title }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button onClick={onConfirm}>Confirm</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}));

vi.mock('../ui/DecompositionConfirmDialog.js', () => ({
  DecompositionConfirmDialog: ({ open, onClose, parentTaskTitle }: any) =>
    open ? (
      <div data-testid="decompose-dialog">
        <span>{parentTaskTitle}</span>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

describe('TaskDangerZone', () => {
  const defaultProps = {
    task: { title: 'Test Task', description: 'Some description' },
    decomposing: false,
    decomposeDialogOpen: false,
    decompositionProposals: [],
    deleteDialogOpen: false,
    onDecompose: vi.fn(),
    onDecomposeConfirm: vi.fn(),
    onDecomposeDialogClose: vi.fn(),
    onClone: vi.fn(),
    onDelete: vi.fn(),
    onDeleteDialogOpen: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders danger zone section', () => {
    render(<TaskDangerZone {...defaultProps} />);
    expect(screen.getByText('Danger Zone')).toBeTruthy();
    expect(screen.getByText('Clone task')).toBeTruthy();
    expect(screen.getByText('Delete task')).toBeTruthy();
  });

  it('renders decompose button when task has description', () => {
    render(<TaskDangerZone {...defaultProps} />);
    expect(screen.getByText('Sonar Split')).toBeTruthy();
  });

  it('does not render decompose button when no description', () => {
    render(<TaskDangerZone {...defaultProps} task={{ title: 'Test', description: '' }} />);
    expect(screen.queryByText('Sonar Split')).toBeNull();
  });

  it('shows decomposing state', () => {
    render(<TaskDangerZone {...defaultProps} decomposing={true} />);
    expect(screen.getByText('Splitting...')).toBeTruthy();
  });

  it('calls onClone when clone button clicked', () => {
    render(<TaskDangerZone {...defaultProps} />);
    fireEvent.click(screen.getByText('Clone task'));
    expect(defaultProps.onClone).toHaveBeenCalled();
  });

  it('calls onDeleteDialogOpen when delete button clicked', () => {
    render(<TaskDangerZone {...defaultProps} />);
    fireEvent.click(screen.getByText('Delete task'));
    expect(defaultProps.onDeleteDialogOpen).toHaveBeenCalledWith(true);
  });

  it('shows confirm dialog when deleteDialogOpen is true', () => {
    render(<TaskDangerZone {...defaultProps} deleteDialogOpen={true} />);
    expect(screen.getByTestId('confirm-dialog')).toBeTruthy();
  });

  it('shows decompose dialog when decomposeDialogOpen is true', () => {
    render(<TaskDangerZone {...defaultProps} decomposeDialogOpen={true} />);
    expect(screen.getByTestId('decompose-dialog')).toBeTruthy();
  });
});
