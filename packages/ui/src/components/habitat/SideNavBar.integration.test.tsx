import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BoardPage } from './HabitatPage.js';
import { AppShell } from '../layout/AppShell.js';

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

vi.mock('../layout/TopAppBar.js', () => ({
  TopAppBar: () => <header data-testid="top-app-bar" />,
}));

vi.mock('./TaskDetailModal.js', () => ({
  TaskDetailModal: () => null,
}));

vi.mock('./Habitat.js', () => ({
  Board: () => <div data-testid="board-canvas" />,
}));

vi.mock('./StatsModal.js', () => ({
  StatsModal: () => <div role="dialog" aria-label="Stats Modal" />,
}));

vi.mock('./AgentPanel.js', () => ({
  AgentPanel: () => <aside aria-label="Agent Panel" />,
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
  appendColumnFeatures: vi.fn(),
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

function renderBoardInShell() {
  return render(
    <MemoryRouter initialEntries={["/boards/board-1"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/boards/:boardId" element={<BoardPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderBoardOnly() {
  return render(
    <MemoryRouter initialEntries={["/boards/board-1"]}>
      <Routes>
        <Route path="/boards/:boardId" element={<BoardPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('BoardPage shell extraction', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render SideNavBar directly on board page', () => {
    const { container } = renderBoardOnly();
    const sideNav = container.querySelector('[data-testid="side-nav-bar"]');
    expect(sideNav).toBeNull();
  });

  it('keeps BoardPage focused on board workspace content', () => {
    const { container } = renderBoardOnly();
    expect(container.querySelector('[data-testid="side-nav-bar"]')).toBeNull();
    expect(container.querySelector('.glass-panel')).toBeTruthy();
  });

  it('opens StatsModal from the shell sidebar', async () => {
    renderBoardInShell();

    const statsButton = screen.getByTestId('tool-item-stats');
    await waitFor(() => expect((statsButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(statsButton);

    expect(await screen.findByRole('dialog', { name: 'Stats Modal' })).toBeTruthy();
  });

  it('Agents is a route nav item, not a drawer tool', async () => {
    renderBoardInShell();

    expect(screen.queryByTestId('tool-item-agents')).toBeNull();
    expect(screen.getByTestId('nav-item-orcy-pod')).toBeTruthy();
    const agentsLink = screen.getByTestId('nav-item-orcy-pod');
    expect(agentsLink.getAttribute('href')).toBe('/agents');
  });
});
