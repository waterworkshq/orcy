import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BoardPage } from './HabitatPage.js';
import { useIsMobile } from '../../hooks/useMediaQuery.js';

vi.mock('../../api/index.js', () => ({
  api: {
    boards: { get: vi.fn().mockResolvedValue({ board: { id: 'board-1', name: 'Test Board' }, columns: [], features: [] }) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    features: { list: vi.fn().mockResolvedValue({ features: [], total: 0 }) },
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

const mockStoreState = {
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
    collapsedColumns: {},
    allFeaturesLoaded: false,
    presence: [],
    isBulkSelectMode: false,
    selectedFeatureIds: [],
    notifications: [],
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
  if (selector) return selector(mockStoreState);
  return mockStoreState;
});

vi.mock('../../store/habitatStore.js', () => ({
  useBoardStore: (...args: any[]) => useBoardStoreMock(...args),
}));

vi.mock('../../store/modalStore.js', () => ({
  useModalStore: vi.fn(() => ({
    isOpen: false,
    selectedTaskId: null,
    modalTask: null,
    isLoading: false,
    openModal: vi.fn(),
    closeModal: vi.fn(),
    setModalTask: vi.fn(),
  })),
}));

vi.mock('./TaskDetailModal.js', () => ({
  TaskDetailModal: () => null,
}));

describe('BoardPage Archived Button Removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Archived button removal', () => {
    it('renders archived column control in the board area', () => {
      render(<BoardPage />);
      expect(screen.getByTestId('archived-toggle')).toBeTruthy();
    });

    it('does not render ArchivedFeaturesPanel', () => {
      const { container } = render(<BoardPage />);
      expect(container.querySelector('[class*="ArchivedFeatures"]')).toBeNull();
    });

    it('does not render archived control in the page header', () => {
      const { container } = render(<BoardPage />);
      const header = container.querySelector('.glass-panel');
      expect(header?.textContent).not.toContain('Archived');
    });
  });

  describe('Other header buttons remain functional', () => {
    it('renders Stats button', () => {
      render(<BoardPage />);
      expect(screen.getAllByText('Stats').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Agents button', () => {
      render(<BoardPage />);
      expect(screen.getAllByText('Agents').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Activity button', () => {
      render(<BoardPage />);
      expect(screen.getAllByText('Activity').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Dependencies button', () => {
      render(<BoardPage />);
      expect(screen.getAllByText('Dependencies').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Bulk Select button', () => {
      render(<BoardPage />);
      expect(screen.getAllByText('Bulk Select').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Add Mission button', () => {
      render(<BoardPage />);
      expect(screen.getAllByText('Add Mission').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Breadcrumb navigation', () => {
    it('renders breadcrumb with board name', () => {
      render(<BoardPage />);
      expect(screen.getAllByText('Habitats').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Test Board').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Board content', () => {
    it('renders the Board component', () => {
      render(<BoardPage />);
      expect(screen.getAllByText('Stats').length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('BoardPage Archived Button Removal (Mobile)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render Archived option even when isMobile is true', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    render(<BoardPage />);
    expect(screen.queryByTestId('archived-toggle')).toBeNull();
  });
});
