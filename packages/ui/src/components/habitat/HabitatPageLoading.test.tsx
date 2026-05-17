import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import React from 'react';
import { BoardPage } from './HabitatPage.js';

const mocks = {
  featuresList: vi.fn(),
  boardsGet: vi.fn(),
  agentsList: vi.fn(),
};

vi.mock('../../api/index.js', () => ({
  api: {
    boards: { get: (...args: any[]) => mocks.boardsGet(...args) },
    agents: { list: (...args: any[]) => mocks.agentsList(...args) },
    features: { list: (...args: any[]) => mocks.featuresList(...args) },
  },
}));

vi.mock('./HabitatPulsePanel.js', () => ({ HabitatPulsePanel: () => null }));
vi.mock('./InsightsPanel.js', () => ({ InsightsPanel: () => null }));
vi.mock('./HealthScoreWidget.js', () => ({ HealthScoreWidget: () => null }));
vi.mock('../../hooks/useSSE.js', () => ({ useSSE: vi.fn() }));
vi.mock('../../hooks/useSSENotifications.js', () => ({ useSSENotifications: vi.fn() }));
vi.mock('../../hooks/usePresence.js', () => ({ usePresence: vi.fn() }));
vi.mock('../../hooks/useMediaQuery.js', () => ({ useIsMobile: vi.fn(() => false) }));
vi.mock('../../components/layout/DrawerBridgeContext.js', () => ({
  useRegisterDrawerBridge: () => () => () => undefined,
  DrawerBridgeProvider: ({ children }: any) => children,
}));

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ boardId: 'board-1' })),
  useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: '/board/board-1', search: '', hash: '', state: null })),
}));

const storeActions = {
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

let mockStoreState: Record<string, any>;

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
    getState: vi.fn(() => ({ isOpen: false })),
  })),
}));

vi.mock('./Habitat.js', () => ({
  Board: () => <div data-testid="board" />,
}));
vi.mock('./FilterBar.js', () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
}));
vi.mock('./TaskDetailModal.js', () => ({
  TaskDetailModal: () => null,
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

function makeFeatures(count: number, columnId: string, startId: number = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `f${startId + i}`,
    title: `Feature ${startId + i}`,
    columnId,
    boardId: 'board-1',
  }));
}

describe('BoardPage parallel feature loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.featuresList.mockReset();
    mocks.boardsGet.mockReset();
    mocks.agentsList.mockReset();
    mockStoreState = {
      board: null,
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
      ...storeActions,
    };
    mocks.boardsGet.mockResolvedValue({
      board: { id: 'board-1', name: 'Test Board' },
      columns: [{ id: 'col-1', name: 'Todo', boardId: 'board-1' }],
      features: [],
    });
    mocks.agentsList.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('loads first page and renders immediately', async () => {
    const features = makeFeatures(10, 'col-1');
    mocks.featuresList.mockResolvedValue({ features, total: 10 });

    await act(async () => {
      render(<BoardPage />);
    });

    expect(mocks.featuresList).toHaveBeenCalledWith('board-1', { limit: 50, offset: 0 });
    expect(storeActions.setBoard).toHaveBeenCalled();
    expect(storeActions.setColumnPagination).toHaveBeenCalledWith('col-1', {
      features,
      total: undefined,
      offset: 0,
    });
  });

  it('only fetches first page even when more pages exist', async () => {
    const page1 = makeFeatures(50, 'col-1', 0);
    const total = 500;

    mocks.featuresList.mockResolvedValue({ features: page1, total });

    const { unmount } = await act(async () => {
      return render(<BoardPage />);
    });

    await waitFor(() => {
      expect(mocks.featuresList).toHaveBeenCalledTimes(1);
    });

    expect(mocks.featuresList).toHaveBeenCalledWith('board-1', { limit: 50, offset: 0 });
    expect(storeActions.setColumnPagination).toHaveBeenCalledWith('col-1', {
      features: page1,
      total: undefined,
      offset: 0,
    });

    unmount();
  });

  it('does not fetch remaining pages when first page is not full', async () => {
    const features = makeFeatures(25, 'col-1');
    mocks.featuresList.mockResolvedValue({ features, total: 25 });

    await act(async () => {
      render(<BoardPage />);
    });

    expect(mocks.featuresList).toHaveBeenCalledTimes(1);
    expect(storeActions.setColumnPagination).toHaveBeenCalledWith('col-1', {
      features,
      total: undefined,
      offset: 0,
    });
  });

  it('sets loading false after first page to allow board render', async () => {
    const features = makeFeatures(10, 'col-1');
    mocks.featuresList.mockResolvedValue({ features, total: 10 });

    await act(async () => {
      render(<BoardPage />);
    });

    const loadingCalls = storeActions.setLoading.mock.calls.map((c: any[]) => c[0]);
    const firstFalseIndex = loadingCalls.indexOf(false);
    const trueIndex = loadingCalls.indexOf(true);
    expect(trueIndex).toBeLessThan(firstFalseIndex);
  });

  it('does not fetch remaining pages when total exceeds page size', async () => {
    const page1 = makeFeatures(50, 'col-1', 0);

    mocks.featuresList.mockResolvedValue({ features: page1, total: 500 });

    const { unmount } = await act(async () => {
      return render(<BoardPage />);
    });

    await waitFor(() => {
      expect(mocks.featuresList).toHaveBeenCalledTimes(1);
    });

    expect(storeActions.setColumnPagination).toHaveBeenCalledWith('col-1', {
      features: page1,
      total: undefined,
      offset: 0,
    });

    unmount();
  });

  it('loads only first page features for large datasets', async () => {
    const page1 = makeFeatures(50, 'col-1', 0);

    mocks.featuresList.mockResolvedValue({ features: page1, total: 500 });

    const { unmount } = await act(async () => {
      return render(<BoardPage />);
    });

    await waitFor(() => {
      expect(mocks.featuresList).toHaveBeenCalledTimes(1);
    });

    const col1Call = storeActions.setColumnPagination.mock.calls.find(
      (c: any[]) => c[0] === 'col-1'
    );
    expect(col1Call).toBeDefined();
    expect(col1Call![1].features).toHaveLength(50);

    unmount();
  });

  it('handles error from initial board/agents fetch', async () => {
    mocks.boardsGet.mockRejectedValue(new Error('Habitat not found'));
    mocks.featuresList.mockResolvedValue({ features: [], total: 0 });

    await act(async () => {
      render(<BoardPage />);
    });

    expect(storeActions.setError).toHaveBeenCalledWith('Habitat not found');
    expect(storeActions.setLoading).toHaveBeenCalledWith(false);
  });

  it('distributes features to correct columns', async () => {
    const features = [
      ...makeFeatures(3, 'col-1', 0),
      ...makeFeatures(2, 'col-2', 3),
    ];
    mocks.boardsGet.mockResolvedValue({
      board: { id: 'board-1', name: 'Test Board' },
      columns: [
        { id: 'col-1', name: 'Todo', boardId: 'board-1' },
        { id: 'col-2', name: 'Done', boardId: 'board-1' },
      ],
      features: [],
    });
    mocks.featuresList.mockResolvedValue({ features, total: 5 });

    await act(async () => {
      render(<BoardPage />);
    });

    const col1Calls = storeActions.setColumnPagination.mock.calls.filter(
      (c: any[]) => c[0] === 'col-1'
    );
    const col2Calls = storeActions.setColumnPagination.mock.calls.filter(
      (c: any[]) => c[0] === 'col-2'
    );

    expect(col1Calls[0][1].features).toHaveLength(3);
    expect(col2Calls[0][1].features).toHaveLength(2);
  });

  it('calls setLoading(false) only once when no remaining pages', async () => {
    mocks.featuresList.mockResolvedValue({ features: makeFeatures(10, 'col-1'), total: 10 });

    await act(async () => {
      render(<BoardPage />);
    });

    const falseCalls = storeActions.setLoading.mock.calls.filter((c: any[]) => c[0] === false);
    expect(falseCalls.length).toBe(1);
  });

  it('renders columns with first page features immediately', async () => {
    const page1 = makeFeatures(50, 'col-1', 0);

    mocks.featuresList.mockResolvedValue({ features: page1, total: 500 });

    await act(async () => {
      render(<BoardPage />);
    });

    expect(storeActions.setLoading).toHaveBeenCalledWith(false);
    expect(storeActions.setColumnPagination).toHaveBeenCalledWith('col-1', {
      features: page1,
      total: undefined,
      offset: 0,
    });
  });
});
