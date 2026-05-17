import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { TopAppBar } from './TopAppBar.js';
import type { Notification } from '../../types/index.js';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<any>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockLogout = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../api/index.js', () => ({
  api: {
    auth: {
      logout: (...args: any[]) => mockLogout(...args),
    },
  },
}));

const mockAgents = [
  { id: 'a1', name: 'Alpha-1', status: 'working' },
  { id: 'a2', name: 'Bravo-2', status: 'idle' },
  { id: 'a3', name: 'Gamma-X', status: 'offline' },
];

let notificationsState: Notification[] = [];

const useBoardStoreMock = vi.fn((selector?: any) => {
  const state = {
    agents: mockAgents,
    notifications: notificationsState,
    markNotificationRead: vi.fn(),
    clearNotifications: vi.fn(),
  };
  return selector ? selector(state) : state;
});

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: (...args: any[]) => useBoardStoreMock(...args),
}));

const makeNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: `notif-${Math.random().toString(36).slice(2, 8)}`,
  type: 'task.completed',
  taskId: 'task-1',
  taskTitle: 'Test Task',
  agentName: 'Agent-1',
  message: 'Task completed successfully',
  timestamp: new Date().toISOString(),
  read: false,
  ...overrides,
});

function makeJwt(username: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256' }));
  const payload = btoa(JSON.stringify({ username }));
  const signature = btoa('fake-signature');
  return `${header}.${payload}.${signature}`;
}

describe('TopAppBar', () => {
  beforeEach(() => {
    notificationsState = [];
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows ORCY POD brand text', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.getByText('ORCY POD')).toBeInTheDocument();
  });

  it('shows updated navigation tabs (Echo Base, Orcy Pod, Wake, Pod Base)', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('top-nav-echo-base')).toHaveTextContent('Echo Base');
    expect(screen.getByTestId('top-nav-orcy-pod')).toHaveTextContent('Orcy Pod');
    expect(screen.getByTestId('top-nav-wake')).toHaveTextContent('Wake');
    expect(screen.getByTestId('top-nav-pod-base')).toHaveTextContent('Pod Base');
  });

  it('does not render Logs tab', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.queryByTestId('top-nav-logs')).toBeNull();
  });

  it('does not render Settings button', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.queryByTitle('Settings')).toBeNull();
  });

  it('does not render Search input', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.queryByPlaceholderText('Search operations...')).toBeNull();
    expect(screen.queryByLabelText('Search operations')).toBeNull();
  });

  it('shows Fleet Pulse indicators from board store agents', () => {
    const { container } = render(<TopAppBar />, { wrapper: MemoryRouter });
    const indicatorClasses = Array.from(container.querySelectorAll('div')).map((el) => el.className.toString());
    expect(screen.getByTestId('fleet-pulse')).toHaveTextContent('Fleet Pulse');
    expect(screen.getByText('Alpha-1: Processing')).toBeInTheDocument();
    expect(screen.getByText('Bravo-2: Idle')).toBeInTheDocument();
    expect(screen.getByText('Gamma-X: Stalled')).toBeInTheDocument();
    expect(indicatorClasses.some((className) => className.includes('bg-[var(--badge-active)]'))).toBe(true);
    expect(indicatorClasses.some((className) => className.includes('bg-[var(--badge-done)]'))).toBe(true);
    expect(indicatorClasses.some((className) => className.includes('bg-[var(--badge-blocked)]') && className.includes('animate-pulse'))).toBe(true);
  });

  it('renders notification bell button', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('notification-bell-btn')).toBeInTheDocument();
  });

  it('does not show unread badge when no unread notifications', () => {
    notificationsState = [];
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.queryByTestId('unread-badge')).toBeNull();
  });

  it('does not show unread badge when all notifications are read', () => {
    notificationsState = [
      makeNotification({ id: 'n1', read: true }),
      makeNotification({ id: 'n2', read: true }),
    ];
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.queryByTestId('unread-badge')).toBeNull();
  });

  it('shows unread count badge when unread notifications exist', () => {
    notificationsState = [
      makeNotification({ id: 'n1', read: false }),
      makeNotification({ id: 'n2', read: true }),
      makeNotification({ id: 'n3', read: false }),
    ];
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('unread-badge')).toHaveTextContent('2');
  });

  it('shows 99+ when unread count exceeds 99', () => {
    notificationsState = Array.from({ length: 100 }, (_, i) =>
      makeNotification({ id: `n${i}`, read: false }),
    );
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('unread-badge')).toHaveTextContent('99+');
  });

  it('toggles notification dropdown on bell icon click', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.queryByTestId('notification-dropdown')).toBeNull();

    fireEvent.click(screen.getByTestId('notification-bell-btn'));
    expect(screen.getByTestId('notification-dropdown')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('notification-bell-btn'));
    expect(screen.queryByTestId('notification-dropdown')).toBeNull();
  });

  it('closes notification dropdown via onClose callback', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByTestId('notification-bell-btn'));
    expect(screen.getByTestId('notification-dropdown')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('notification-dropdown').querySelector('[title="Close"]')!);
    expect(screen.queryByTestId('notification-dropdown')).toBeNull();
  });

  it('renders user avatar button', () => {
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('user-avatar-btn')).toBeInTheDocument();
  });

  it('shows first letter of username in avatar', () => {
    localStorage.setItem('orcy_token', makeJwt('admin'));
    render(<TopAppBar />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('user-avatar-btn')).toHaveTextContent('A');
  });

  describe('User Menu', () => {
    it('clicking avatar opens dropdown menu', () => {
      render(<TopAppBar />, { wrapper: MemoryRouter });
      expect(screen.queryByTestId('user-menu-dropdown')).toBeNull();
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.getByTestId('user-menu-dropdown')).toBeInTheDocument();
    });

    it('clicking avatar toggles dropdown closed', () => {
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.getByTestId('user-menu-dropdown')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.queryByTestId('user-menu-dropdown')).toBeNull();
    });

    it('shows username from decoded JWT in dropdown', () => {
      localStorage.setItem('orcy_token', makeJwt('testuser'));
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.getByTestId('user-menu-username')).toHaveTextContent('testuser');
    });

    it('falls back to "User" when no token', () => {
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.getByTestId('user-menu-username')).toHaveTextContent('User');
    });

    it('falls back to "User" when token is malformed', () => {
      localStorage.setItem('orcy_token', 'not-a-jwt');
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.getByTestId('user-menu-username')).toHaveTextContent('User');
    });

    it('renders Settings link in dropdown', () => {
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.getByTestId('user-menu-settings')).toHaveTextContent('Settings');
    });

    it('navigates to /settings when Settings is clicked', () => {
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      fireEvent.click(screen.getByTestId('user-menu-settings'));
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('renders Logout button in dropdown', () => {
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.getByTestId('user-menu-logout')).toHaveTextContent('Logout');
    });

    it('calls api.auth.logout on Logout click', async () => {
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('user-menu-logout'));
      });
      expect(mockLogout).toHaveBeenCalled();
    });

    it('removes orcy_token from localStorage on Logout', async () => {
      localStorage.setItem('orcy_token', makeJwt('admin'));
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('user-menu-logout'));
      });
      expect(localStorage.getItem('orcy_token')).toBeNull();
    });

    it('navigates to /login on Logout', async () => {
      render(<TopAppBar />, { wrapper: MemoryRouter });
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('user-menu-logout'));
      });
      expect(mockNavigate).toHaveBeenCalledWith('/login');
    });

    it('closes dropdown when clicking outside', () => {
      render(
        <MemoryRouter>
          <div data-testid="outside">
            <TopAppBar />
          </div>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByTestId('user-avatar-btn'));
      expect(screen.getByTestId('user-menu-dropdown')).toBeInTheDocument();
      fireEvent.mouseDown(screen.getByTestId('outside'));
      expect(screen.queryByTestId('user-menu-dropdown')).toBeNull();
    });
  });

  describe('React.memo wrapping', () => {
    it('TopAppBar is wrapped in React.memo', () => {
      expect((TopAppBar as any).$$typeof).toBe(Symbol.for('react.memo'));
      expect(typeof (TopAppBar as any).type).toBe('function');
    });
  });
});
