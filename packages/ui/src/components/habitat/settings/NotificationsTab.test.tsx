import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { NotificationsTab } from './NotificationsTab.js';

const mockGetGlobalPrefs = vi.fn();
const mockGetBoardPrefs = vi.fn();
const mockUpdateGlobalPrefs = vi.fn();
const mockUpdateBoardPrefs = vi.fn();
const mockUpdateEmail = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../../../api/index.js', () => ({
  api: {
    notifications: {
      getGlobalPrefs: (...args: unknown[]) => mockGetGlobalPrefs(...args),
      getBoardPrefs: (...args: unknown[]) => mockGetBoardPrefs(...args),
      updateGlobalPrefs: (...args: unknown[]) => mockUpdateGlobalPrefs(...args),
      updateBoardPrefs: (...args: unknown[]) => mockUpdateBoardPrefs(...args),
      updateEmail: (...args: unknown[]) => mockUpdateEmail(...args),
    },
  },
}));

vi.mock('../../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('../../ui/ToggleSwitch.js', () => ({
  ToggleSwitch: ({ checked, onChange }: any) => (
    <button data-testid="toggle" onClick={() => onChange(!checked)} />
  ),
}));

vi.mock('../../ui/Button.js', () => ({
  Button: ({ children, onClick, loading }: any) => (
    <button onClick={onClick} disabled={loading}>{children}</button>
  ),
}));

const mockPrefs = {
  id: 'p1',
  userId: 'u1',
  boardId: null,
  taskAssigned: true,
  taskSubmitted: true,
  taskApproved: true,
  taskRejected: false,
  taskOverdue: true,
  taskMentioned: false,
  taskWatching: true,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

describe('NotificationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGlobalPrefs.mockResolvedValue({
      email: 'test@test.com',
      preferences: mockPrefs,
    });
    mockGetBoardPrefs.mockResolvedValue({
      preferences: { ...mockPrefs, boardId: 'b1' },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('loads and renders email input', async () => {
    render(<NotificationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('test@test.com')).toBeTruthy();
    });
  });

  it('renders email label and hint', async () => {
    render(<NotificationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('Email Address')).toBeTruthy();
      expect(screen.getByText('Required for receiving email notifications')).toBeTruthy();
    });
  });

  it('renders Per-Habitat Settings toggle', async () => {
    render(<NotificationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('Per-Habitat Settings')).toBeTruthy();
    });
  });

  it('renders preference checkboxes after loading', async () => {
    render(<NotificationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('Task Assigned')).toBeTruthy();
      expect(screen.getByText('Task Submitted')).toBeTruthy();
      expect(screen.getByText('Task Approved')).toBeTruthy();
      expect(screen.getByText('Task Rejected')).toBeTruthy();
      expect(screen.getByText('Task Overdue')).toBeTruthy();
      expect(screen.getByText('Mentioned')).toBeTruthy();
      expect(screen.getByText('Watched Tasks')).toBeTruthy();
    });
  });

  it('shows loading state initially', () => {
    mockGetGlobalPrefs.mockReturnValue(new Promise(() => {}));
    render(<NotificationsTab boardId="b1" />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows error when loading fails', async () => {
    mockGetGlobalPrefs.mockRejectedValue(new Error('fail'));
    mockGetBoardPrefs.mockRejectedValue(new Error('fail'));

    render(<NotificationsTab boardId="b1" />);

    await waitFor(() => {
      expect(mockNotifyError).toHaveBeenCalledWith('Failed to load notification settings');
    });
  });
});
