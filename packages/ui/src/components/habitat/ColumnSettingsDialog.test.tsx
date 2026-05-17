import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { ColumnSettingsDialog } from './ColumnSettingsDialog.js';
import type { Column } from '../../types/index.js';

const mockColumnsUpdate = vi.fn();
const mockColumnsDelete = vi.fn();
const mockSetColumns = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

let capturedOnDragEnd: ((event: { active: { id: string }; over: { id: string } }) => void) | null = null;

vi.mock('../../api/index.js', () => ({
  api: {
    columns: {
      update: (...args: unknown[]) => mockColumnsUpdate(...args),
      delete: (...args: unknown[]) => mockColumnsDelete(...args),
    },
  },
}));

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: {
    getState: () => ({
      setColumns: mockSetColumns,
    }),
  },
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: any) => {
    capturedOnDragEnd = onDragEnd ?? null;
    return <div data-testid="dnd-context">{children}</div>;
  },
  DragOverlay: ({ children }: any) => <div>{children}</div>,
  closestCorners: {},
  PointerSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <div data-testid="sortable-context">{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => '',
    },
  },
}));

vi.mock('lucide-react', () => ({
  GripVertical: () => <span data-testid="grip-icon" />,
}));

const makeColumn = (id: string, name: string, order: number): Column => ({
  id,
  habitatId: 'board-1',
  name,
  order,
  wipLimit: null,
  autoAdvance: false,
  requiresClaim: false,
  nextColumnId: null,
  isTerminal: false,
});

const defaultColumns = [
  makeColumn('col-1', 'To Do', 0),
  makeColumn('col-2', 'In Progress', 1),
  makeColumn('col-3', 'Done', 2),
];

const defaultProps = {
  column: defaultColumns[1],
  open: true,
  onClose: vi.fn(),
  onUpdate: vi.fn(),
  onDelete: vi.fn(),
  columns: defaultColumns,
};

describe('ColumnSettingsDialog — column reorder', () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    mockColumnsUpdate.mockReset();
    mockColumnsUpdate.mockResolvedValue({ column: defaultColumns[0] });
    mockColumnsDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders draggable list with all columns', () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.getByTestId('dnd-context')).toBeTruthy();
    expect(screen.getByTestId('sortable-context')).toBeTruthy();
    expect(screen.getByText('To Do')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Column Order')).toBeTruthy();
    expect(screen.getByText('Drag to reorder columns on the board')).toBeTruthy();
  });

  it('highlights the currently selected column', () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.getByText('(selected)')).toBeTruthy();
  });

  it('does not show reorder list when only one column', () => {
    const singleColumn = [defaultColumns[0]];
    render(
      <ColumnSettingsDialog
        {...defaultProps}
        column={singleColumn[0]}
        columns={singleColumn}
      />
    );

    expect(screen.queryByText('Column Order')).toBeNull();
    expect(screen.queryByTestId('dnd-context')).toBeNull();
  });

  it('shows Save Order button after drag reorder', () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.queryByText('Save Order')).toBeNull();

    expect(capturedOnDragEnd).not.toBeNull();
    act(() => {
      capturedOnDragEnd!({ active: { id: 'col-1' }, over: { id: 'col-3' } });
    });

    expect(screen.getByText('Save Order')).toBeTruthy();
  });
});

describe('ColumnSettingsDialog — save order', () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    mockColumnsUpdate.mockReset();
    mockColumnsDelete.mockReset();
    mockSetColumns.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    mockColumnsUpdate.mockResolvedValue({ column: defaultColumns[0] });
    mockColumnsDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('calls PATCH /api/columns/:id with new order for each column on save', async () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(capturedOnDragEnd).not.toBeNull();
    act(() => {
      capturedOnDragEnd!({ active: { id: 'col-3' }, over: { id: 'col-1' } });
    });

    fireEvent.click(screen.getByText('Save Order'));

    await waitFor(() => {
      expect(mockColumnsUpdate).toHaveBeenCalledTimes(3);
    });

    expect(mockColumnsUpdate).toHaveBeenCalledWith('col-3', { order: 0 });
    expect(mockColumnsUpdate).toHaveBeenCalledWith('col-1', { order: 1 });
    expect(mockColumnsUpdate).toHaveBeenCalledWith('col-2', { order: 2 });
  });

  it('updates board store optimistically after save', async () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(capturedOnDragEnd).not.toBeNull();
    act(() => {
      capturedOnDragEnd!({ active: { id: 'col-3' }, over: { id: 'col-1' } });
    });

    fireEvent.click(screen.getByText('Save Order'));

    await waitFor(() => {
      expect(mockSetColumns).toHaveBeenCalled();
    });

    const updatedColumns = mockSetColumns.mock.calls[0][0];
    expect(updatedColumns).toHaveLength(3);
    expect(updatedColumns[0].id).toBe('col-3');
    expect(updatedColumns[0].order).toBe(0);
    expect(updatedColumns[1].id).toBe('col-1');
    expect(updatedColumns[1].order).toBe(1);
    expect(updatedColumns[2].id).toBe('col-2');
    expect(updatedColumns[2].order).toBe(2);
  });

  it('shows success notification after save', async () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(capturedOnDragEnd).not.toBeNull();
    act(() => {
      capturedOnDragEnd!({ active: { id: 'col-3' }, over: { id: 'col-1' } });
    });

    fireEvent.click(screen.getByText('Save Order'));

    await waitFor(() => {
      expect(mockNotifySuccess).toHaveBeenCalledWith('Column order saved');
    });
  });

  it('handles API error gracefully', async () => {
    mockColumnsUpdate.mockRejectedValue(new Error('Network error'));
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(capturedOnDragEnd).not.toBeNull();
    act(() => {
      capturedOnDragEnd!({ active: { id: 'col-3' }, over: { id: 'col-1' } });
    });

    fireEvent.click(screen.getByText('Save Order'));

    await waitFor(() => {
      expect(mockNotifyError).toHaveBeenCalledWith('Network error');
    });

    expect(mockSetColumns).not.toHaveBeenCalled();
  });

  it('does not call API when order is unchanged', async () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.queryByText('Save Order')).toBeNull();
  });
});

describe('ColumnSettingsDialog — existing functionality preserved', () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    mockColumnsUpdate.mockReset();
    mockColumnsDelete.mockReset();
    mockSetColumns.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    mockColumnsUpdate.mockResolvedValue({ column: defaultColumns[0] });
    mockColumnsDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders column name input with current value', () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    const input = screen.getByDisplayValue('In Progress');
    expect(input).toBeTruthy();
  });

  it('renders WIP limit input', () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    const input = screen.getByPlaceholderText('No limit');
    expect(input).toBeTruthy();
  });

  it('renders auto-advance and requires-claim toggles', () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.getByText('Auto-advance')).toBeTruthy();
    expect(screen.getByText('Requires Claim')).toBeTruthy();
  });

  it('renders danger zone with delete button', () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.getByText('Danger Zone')).toBeTruthy();
    expect(screen.getByText('Delete Column')).toBeTruthy();
  });
});
