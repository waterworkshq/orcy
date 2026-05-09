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

vi.mock('../../hooks/useSSE.js', () => ({ useSSE: vi.fn() }));
vi.mock('../../hooks/useSSENotifications.js', () => ({ useSSENotifications: vi.fn() }));
vi.mock('../../hooks/usePresence.js', () => ({ usePresence: vi.fn() }));
vi.mock('../../hooks/useMediaQuery.js', () => ({ useIsMobile: vi.fn(() => false) }));

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ boardId: 'board-1' })),
  useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: '/board/board-1', search: '', hash: '', state: null })),
}));

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
};

const useBoardStoreMock = vi.fn((selector?: any) => {
  if (selector) return selector(mockBoardStoreState);
  return mockBoardStoreState;
});

vi.mock('../../store/habitatStore.js', () => ({
  useBoardStore: (...args: any[]) => useBoardStoreMock(...args),
}));

const mockOpenModal = vi.fn();
const mockCloseModal = vi.fn();
const mockSetModalTask = vi.fn();

let modalStoreState: Record<string, any> = {
  isOpen: false,
  selectedTaskId: null,
  modalTask: null,
  isLoading: false,
  openModal: mockOpenModal,
  closeModal: mockCloseModal,
  setModalTask: mockSetModalTask,
};

const useModalStoreMock = vi.fn((selector?: any) => selector ? selector(modalStoreState) : modalStoreState);

vi.mock('../../store/modalStore.js', () => ({
  useModalStore: (selector?: any) => useModalStoreMock(selector),
}));

vi.mock('./TaskDetailModal.js', () => ({
  TaskDetailModal: () => <div data-testid="task-detail-modal" />,
}));

vi.mock('./TaskDetailPanel.js', () => ({
  TaskDetailPanel: () => <div data-testid="task-detail-panel" />,
}));

vi.mock('./Habitat.js', () => ({
  Board: () => <div data-testid="board" />,
}));

vi.mock('./FilterBar.js', () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
}));

vi.mock('./SideNavBar.js', () => ({
  SideNavBar: () => <div data-testid="side-nav-bar" />,
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

describe('BoardPage Modal Integration', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    modalStoreState = {
      isOpen: false,
      selectedTaskId: null,
      modalTask: null,
      isLoading: false,
      openModal: mockOpenModal,
      closeModal: mockCloseModal,
      setModalTask: mockSetModalTask,
    };
    mockBoardStoreState.isBulkSelectMode = false;
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render TaskDetailModal directly because AppShell owns the portable modal', () => {
    render(<BoardPage />);
    expect(screen.queryByTestId('task-detail-modal')).toBeNull();
  });

  it('does not render TaskDetailPanel', () => {
    render(<BoardPage />);
    expect(screen.queryByTestId('task-detail-panel')).toBeNull();
  });

  it('does not render feature drawer', () => {
    render(<BoardPage />);
    expect(screen.queryByTestId('feature-detail-panel')).toBeNull();
  });

  it('keeps TaskDetailModal out of the BoardPage subtree', () => {
    modalStoreState.isOpen = false;
    render(<BoardPage />);
    expect(screen.queryByTestId('task-detail-modal')).toBeNull();
  });
});
