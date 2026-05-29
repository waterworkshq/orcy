import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HabitatPage } from './HabitatPage.js';

vi.mock('../../api/index.js', () => ({
  api: {
    boards: { get: vi.fn().mockResolvedValue({ board: { id: 'board-1', name: 'Test Board' }, columns: [], features: [] }) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    features: { list: vi.fn().mockResolvedValue({ features: [] }) },
  },
}));

vi.mock('./HabitatPulsePanel.js', () => ({ HabitatPulsePanel: () => null }));
vi.mock('./InsightsPanel.js', () => ({ InsightsPanel: () => null }));
vi.mock('./SkillPanel.js', () => ({ SkillPanel: () => null }));
vi.mock('./HealthScoreWidget.js', () => ({ HealthScoreWidget: () => null }));
vi.mock('./SprintSelector.js', () => ({ SprintSelector: () => null }));
vi.mock('./SprintPlanningPanel.js', () => ({ SprintPlanningPanel: () => null }));
vi.mock('./FilterBar.js', () => ({ FilterBar: () => <div data-testid="filter-bar" /> }));
vi.mock('./Habitat.js', () => ({ Habitat: () => <div data-testid="habitat" /> }));
vi.mock('./TaskDetailModal.js', () => ({ TaskDetailModal: () => null }));
vi.mock('./TaskTableView.js', () => ({ TaskTableView: () => <div /> }));
vi.mock('./BulkActionBar.js', () => ({ BulkActionBar: () => <div /> }));
vi.mock('./MobileNav.js', () => ({ MobileNav: () => <div /> }));
vi.mock('./AgentPanel.js', () => ({ AgentPanel: () => null }));
vi.mock('./StatsModal.js', () => ({ StatsModal: () => null }));
vi.mock('./ColumnSettingsDialog.js', () => ({ ColumnSettingsDialog: () => null }));
vi.mock('./CreateColumnDialog.js', () => ({ CreateColumnDialog: () => null }));
vi.mock('./DependencyGraphModal.js', () => ({ DependencyGraphModal: () => null }));
vi.mock('./HabitatSettingsDialog.js', () => ({ HabitatSettingsDialog: () => null }));
vi.mock('./CreateTaskForm.js', () => ({ CreateTaskForm: () => null }));
vi.mock('./CreateMissionForm.js', () => ({ CreateMissionForm: () => null }));
vi.mock('../ui/Button.js', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock('../ui/HelpDrawer.js', () => ({ HelpDrawer: ({ children }: any) => <div>{children}</div> }));
vi.mock('../ui/HelpContent.js', () => ({ HelpContent: () => <div /> }));
vi.mock('../ui/SkeletonCard.js', () => ({ SkeletonCard: () => <div /> }));
vi.mock('../../hooks/useSSE.js', () => ({ useSSE: vi.fn() }));
vi.mock('../../hooks/useSSENotifications.js', () => ({ useSSENotifications: vi.fn() }));
vi.mock('../../hooks/usePresence.js', () => ({ usePresence: vi.fn() }));
vi.mock('../../hooks/useMediaQuery.js', () => ({ useIsMobile: vi.fn(() => false) }));
vi.mock('../../components/layout/DrawerBridgeContext.js', () => ({
  useRegisterDrawerBridge: () => () => () => undefined,
  DrawerBridgeProvider: ({ children }: any) => children,
}));

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ habitatId: 'board-1' })),
  useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: '/board/board-1', search: '', hash: '', state: null })),
}));

const mockStoreState = {
  board: { id: 'board-1', name: 'Test Board' },
  columns: [],
  agents: [
    { id: 'a1', name: 'Alpha-1', type: 'claude-code', domain: 'fullstack', capabilities: ['ts'], status: 'working', currentTaskId: 't1', createdAt: '', lastHeartbeat: '', metadata: {} },
    { id: 'a2', name: 'Bravo-2', type: 'codex', domain: 'backend', capabilities: ['py'], status: 'idle', currentTaskId: null, createdAt: '', lastHeartbeat: '', metadata: {} },
    { id: 'a3', name: 'Gamma-X', type: 'opencode', domain: 'devops', capabilities: ['docker'], status: 'offline', currentTaskId: null, createdAt: '', lastHeartbeat: '', metadata: {} },
  ],
  features: [],
  tasks: [],
  isLoading: false,
  error: null,
  wipAlerts: {},
  comments: {},
  habitatEvents: [],
  columnPagination: {},
  collapsedColumns: {},
  allFeaturesLoaded: false,
  presence: [],
  isBulkSelectMode: false,
  selectedMissionIds: [],
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

const useHabitatStoreMock = vi.fn((selector?: any) => {
  if (selector) return selector(mockStoreState);
  return mockStoreState;
});

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: (...args: any[]) => useHabitatStoreMock(...args),
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

describe('HabitatPage Header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Logo', () => {
    it('does not render global ORCY POD logo text inside HabitatPage content', () => {
      render(<HabitatPage />);
      expect(screen.queryByText('ORCY POD')).toBeNull();
    });
  });

  describe('Fleet Pulse', () => {
    it('does not render Fleet Pulse inside HabitatPage content', () => {
      render(<HabitatPage />);
      expect(screen.queryByText('Fleet Pulse')).toBeNull();
      expect(screen.queryByText('Alpha-1: Processing')).toBeNull();
    });
  });

  describe('Header utilities', () => {
    it('does not render global notifications button inside HabitatPage content', () => {
      render(<HabitatPage />);
      expect(screen.queryByTitle('Notifications')).toBeNull();
    });

    it('keeps global user avatar out of HabitatPage content', () => {
      const { container } = render(<HabitatPage />);
      expect(container.querySelector('.bg-primary-container')).toBeNull();
    });

    it('does not render a theme toggle button', () => {
      render(<HabitatPage />);
      expect(screen.queryByTitle('Switch to light mode')).toBeNull();
      expect(screen.queryByTitle('Switch to dark mode')).toBeNull();
    });
  });

  describe('Button groups', () => {
    it('renders Stats button', () => {
      render(<HabitatPage />);
      expect(screen.getAllByText('Stats').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Agents button', () => {
      render(<HabitatPage />);
      expect(screen.getAllByText('Agents').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Activity button', () => {
      render(<HabitatPage />);
      expect(screen.getAllByText('Activity').length).toBeGreaterThanOrEqual(1);
    });

    it('does not render Archived in the header button group', () => {
      const { container } = render(<HabitatPage />);
      const header = container.querySelector('.glass-panel');
      expect(header?.textContent).not.toContain('Archived');
    });

    it('renders Dependencies button', () => {
      render(<HabitatPage />);
      expect(screen.getAllByText('Dependencies').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Bulk Select button', () => {
      render(<HabitatPage />);
      expect(screen.getAllByText('Bulk Select').length).toBeGreaterThanOrEqual(1);
    });

    it('renders Add Mission button', () => {
      render(<HabitatPage />);
      expect(screen.getAllByText('Add Mission').length).toBeGreaterThanOrEqual(1);
    });

    it('has visual separators between button groups', () => {
      const { container } = render(<HabitatPage />);
      expect(container.querySelectorAll('.bg-outline-variant').length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Breadcrumb', () => {
    it('renders breadcrumb navigation', () => {
      render(<HabitatPage />);
      expect(screen.getAllByText('Habitats').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Test Board').length).toBeGreaterThanOrEqual(1);
    });
  });
});
