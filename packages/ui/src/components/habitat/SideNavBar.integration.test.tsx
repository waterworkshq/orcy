import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HabitatPage } from './HabitatPage.js';
import { AppShell } from '../layout/AppShell.js';

vi.mock('../../api/index.js', () => ({
  api: {
    boards: { get: vi.fn().mockResolvedValue({ board: { id: 'board-1', name: 'Test Board' }, columns: [], features: [] }) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    features: { list: vi.fn().mockResolvedValue({ features: [] }) },
  },
}));

vi.mock('./HabitatPulsePanel.js', () => ({ HabitatPulsePanel: () => null }));
vi.mock('./InsightsPanel.js', () => ({ InsightsPanel: () => null }));
vi.mock('./HealthScoreWidget.js', () => ({ HealthScoreWidget: () => null }));
vi.mock('./FilterBar.js', () => ({ FilterBar: () => <div data-testid="filter-bar" /> }));
vi.mock('./ColumnSettingsDialog.js', () => ({ ColumnSettingsDialog: () => null }));
vi.mock('./CreateColumnDialog.js', () => ({ CreateColumnDialog: () => null }));
vi.mock('./HabitatSettingsDialog.js', () => ({ HabitatSettingsDialog: () => null }));
vi.mock('./DependencyGraphModal.js', () => ({ DependencyGraphModal: () => null }));
vi.mock('./CreateTaskForm.js', () => ({ CreateTaskForm: () => null }));
vi.mock('./CreateMissionForm.js', () => ({ CreateMissionForm: () => null }));
vi.mock('./BulkActionBar.js', () => ({ BulkActionBar: () => <div /> }));
vi.mock('./MobileNav.js', () => ({ MobileNav: () => <div /> }));
vi.mock('../ui/SkeletonCard.js', () => ({ SkeletonCard: () => <div /> }));
vi.mock('../ui/HelpDrawer.js', () => ({ HelpDrawer: ({ children }: any) => <div>{children}</div> }));
vi.mock('../ui/HelpContent.js', () => ({ HelpContent: () => <div /> }));
vi.mock('../ui/Button.js', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
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
  Habitat: () => <div data-testid="habitat" />,
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
  selectedMissionIds: [],
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
  useHabitatStore: (...args: any[]) => useBoardStoreMock(...args),
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
          <Route path="/boards/:habitatId" element={<HabitatPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderBoardOnly() {
  return render(
    <MemoryRouter initialEntries={["/boards/board-1"]}>
      <Routes>
        <Route path="/boards/:habitatId" element={<HabitatPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('HabitatPage shell extraction', () => {
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

  it('keeps HabitatPage focused on board workspace content', () => {
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
