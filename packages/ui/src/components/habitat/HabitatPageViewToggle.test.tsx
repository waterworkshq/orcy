import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BoardPage } from './HabitatPage.js';

vi.mock('../../api/index.js', () => ({
  api: {
    boards: { get: vi.fn().mockResolvedValue({ board: { id: 'board-1', name: 'Test Board' }, columns: [], features: [] }) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    features: { list: vi.fn().mockResolvedValue({ features: [] }) },
  },
}));

vi.mock('./HabitatPulsePanel.js', () => ({ HabitatPulsePanel: () => null }));
vi.mock('./InsightsPanel.js', () => ({ InsightsPanel: () => null }));
vi.mock('../../hooks/useSSE.js', () => ({ useSSE: vi.fn() }));
vi.mock('../../hooks/useSSENotifications.js', () => ({ useSSENotifications: vi.fn() }));
vi.mock('../../hooks/usePresence.js', () => ({ usePresence: vi.fn() }));
vi.mock('../../hooks/useMediaQuery.js', () => ({ useIsMobile: vi.fn(() => false) }));

let mockSearchParams = new URLSearchParams();
const mockSetSearchParams = vi.fn((updater: any) => {
  if (typeof updater === 'function') {
    mockSearchParams = updater(mockSearchParams);
  } else {
    mockSearchParams = updater;
  }
});

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ boardId: 'board-1' })),
  useSearchParams: vi.fn(() => [mockSearchParams, mockSetSearchParams]),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: '/board/board-1', search: '', hash: '', state: null })),
}));

const clearTaskSelectionMock = vi.fn();

const mockBoardStoreState: Record<string, any> = {
  board: { id: 'board-1', name: 'Test Board' },
  columns: [],
  agents: [],
  features: [],
  tasks: [],
  isLoading: false,
  error: null,
  wipAlerts: {},
  comments: {},
  boardEvents: [],
  columnPagination: {},
  allFeaturesLoaded: false,
  presence: [],
  isBulkSelectMode: false,
  selectedFeatureIds: [],
  selectedTaskIds: [],
  setBoard: vi.fn(),
  setAgents: vi.fn(),
  setLoading: vi.fn(),
  setError: vi.fn(),
  updateColumn: vi.fn(),
  updateBoard: vi.fn(),
  addColumn: vi.fn(),
  removeColumn: vi.fn(),
  setColumnPagination: vi.fn(),
  setColumnLoadingMore: vi.fn(),
  clearColumnPagination: vi.fn(),
  setBulkSelectMode: vi.fn(),
  clearTaskSelection: clearTaskSelectionMock,
};

vi.mock('../../store/habitatStore.js', () => ({
  useBoardStore: (...args: any[]) => {
    const selector = args[0];
    return selector ? selector(mockBoardStoreState) : mockBoardStoreState;
  },
}));

vi.mock('../../store/modalStore.js', () => ({
  useModalStore: (selector?: any) => selector ? selector({ isOpen: false, closeModal: vi.fn() }) : { isOpen: false, closeModal: vi.fn() },
}));

vi.mock('./Habitat.js', () => ({
  Board: () => <div data-testid="kanban-board" />,
}));

vi.mock('./FilterBar.js', () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
}));

vi.mock('./TaskTableView.js', () => ({
  TaskTableView: ({ boardId }: { boardId: string }) => (
    <div data-testid="task-table-view" data-board-id={boardId} />
  ),
}));

vi.mock('./TaskDetailModal.js', () => ({
  TaskDetailModal: () => null,
}));

vi.mock('./TaskDetailPanel.js', () => ({
  TaskDetailPanel: () => null,
}));

vi.mock('./SideNavBar.js', () => ({
  SideNavBar: () => <div />,
}));

vi.mock('../ui/Button.js', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('../ui/HelpDrawer.js', () => ({
  HelpDrawer: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('../ui/HelpContent.js', () => ({
  HelpContent: () => <div />,
}));

vi.mock('./BulkActionBar.js', () => ({
  BulkActionBar: () => <div />,
}));

vi.mock('./MobileNav.js', () => ({
  MobileNav: () => <div />,
}));

describe('HabitatPage view toggle', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockBoardStoreState.isLoading = false;
    clearTaskSelectionMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to board view when no view param', () => {
    render(<BoardPage />);
    expect(screen.getByTestId('kanban-board')).toBeTruthy();
    expect(screen.queryByTestId('task-table-view')).toBeNull();
  });

  it('renders TaskTableView when ?view=table', () => {
    mockSearchParams = new URLSearchParams('view=table');
    render(<BoardPage />);
    expect(screen.getByTestId('task-table-view')).toBeTruthy();
    expect(screen.getByTestId('task-table-view').getAttribute('data-board-id')).toBe('board-1');
    expect(screen.queryByTestId('kanban-board')).toBeNull();
  });

  it('renders kanban when ?view=board', () => {
    mockSearchParams = new URLSearchParams('view=board');
    render(<BoardPage />);
    expect(screen.getByTestId('kanban-board')).toBeTruthy();
    expect(screen.queryByTestId('task-table-view')).toBeNull();
  });

  it('clears task selection when switching from table to board', () => {
    const { rerender } = render(<BoardPage />);
    expect(clearTaskSelectionMock).not.toHaveBeenCalled();

    mockSearchParams = new URLSearchParams('view=table');
    rerender(<BoardPage />);
    expect(clearTaskSelectionMock).toHaveBeenCalledTimes(1);

    clearTaskSelectionMock.mockClear();
    mockSearchParams = new URLSearchParams('view=board');
    rerender(<BoardPage />);
    expect(clearTaskSelectionMock).toHaveBeenCalledTimes(1);
  });

  it('clears task selection when switching from board to table', () => {
    mockSearchParams = new URLSearchParams();
    const { rerender } = render(<BoardPage />);

    mockSearchParams = new URLSearchParams('view=table');
    rerender(<BoardPage />);
    expect(clearTaskSelectionMock).toHaveBeenCalled();
  });
});
