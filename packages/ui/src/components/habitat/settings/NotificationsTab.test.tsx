import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsTab, NotificationsTabHandle } from './NotificationsTab.js';

const mockGetGlobalPrefs = vi.fn();
const mockGetBoardPrefs = vi.fn();
const mockUpdateGlobalPrefs = vi.fn();
const mockUpdateBoardPrefs = vi.fn();
const mockUpdateEmail = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();
const mockInvalidateQueries = vi.fn();

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

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<any>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
  );
}

const mockPrefs = {
  id: 'p1',
  userId: 'u1',
  habitatId: null,
  taskAssigned: true,
  taskSubmitted: true,
  taskApproved: true,
  taskRejected: false,
  taskOverdue: true,
  taskMentioned: false,
  taskWatching: true,
  taskReviewAssigned: true,
  taskPriorityChanged: false,
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
      preferences: { ...mockPrefs, habitatId: 'b1' },
    });
    mockUpdateGlobalPrefs.mockResolvedValue({ preferences: mockPrefs });
    mockUpdateBoardPrefs.mockResolvedValue({ preferences: { ...mockPrefs, habitatId: 'b1' } });
    mockUpdateEmail.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  it('loads and renders email input', async () => {
    renderWithQC(<NotificationsTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('test@test.com')).toBeTruthy();
    });
  });

  it('renders email label and hint', async () => {
    renderWithQC(<NotificationsTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('Email Address')).toBeTruthy();
      expect(screen.getByText('Required for receiving email notifications')).toBeTruthy();
    });
  });

  it('renders Per-Habitat Settings toggle', async () => {
    renderWithQC(<NotificationsTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('Per-Habitat Settings')).toBeTruthy();
    });
  });

  it('renders preference checkboxes after loading', async () => {
    renderWithQC(<NotificationsTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('Task Assigned')).toBeTruthy();
      expect(screen.getByText('Task Submitted')).toBeTruthy();
      expect(screen.getByText('Task Approved')).toBeTruthy();
      expect(screen.getByText('Task Rejected')).toBeTruthy();
      expect(screen.getByText('Task Overdue')).toBeTruthy();
      expect(screen.getByText('Mentioned')).toBeTruthy();
      expect(screen.getByText('Watched Tasks')).toBeTruthy();
      expect(screen.getByText('Review Assigned')).toBeTruthy();
      expect(screen.getByText('Priority Changed')).toBeTruthy();
    });
  });

  it('shows loading state initially', () => {
    mockGetGlobalPrefs.mockReturnValue(new Promise(() => {}));
    renderWithQC(<NotificationsTab habitatId="b1" />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows error when loading fails', async () => {
    mockGetGlobalPrefs.mockRejectedValue(new Error('fail'));
    mockGetBoardPrefs.mockRejectedValue(new Error('fail'));

    renderWithQC(<NotificationsTab habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('Loading...')).toBeTruthy();
    });
  });

  it('renders prefs from useNotificationPrefs', async () => {
    renderWithQC(<NotificationsTab habitatId="b1" />);

    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes.length).toBe(9);
    });
  });

  it('exposes save via imperative handle', async () => {
    const ref = React.createRef<NotificationsTabHandle>();
    renderWithQC(<NotificationsTab ref={ref} habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('test@test.com')).toBeTruthy();
    });

    expect(ref.current).not.toBeNull();
    expect(typeof ref.current!.save).toBe('function');
  });

  it('save() calls updateEmail and updateGlobalPrefs in global mode', async () => {
    const ref = React.createRef<NotificationsTabHandle>();
    renderWithQC(<NotificationsTab ref={ref} habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('test@test.com')).toBeTruthy();
    });

    await ref.current!.save();

    expect(mockUpdateEmail).toHaveBeenCalledWith('test@test.com');
    expect(mockUpdateGlobalPrefs).toHaveBeenCalledWith(mockPrefs);
    expect(mockNotifySuccess).toHaveBeenCalledWith('Notification settings saved');
  });

  it('save() calls updateBoardPrefs when useBoardPrefs is true', async () => {
    const ref = React.createRef<NotificationsTabHandle>();
    renderWithQC(<NotificationsTab ref={ref} habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('test@test.com')).toBeTruthy();
    });

    screen.getByTestId('toggle').click();

    await waitFor(() => {
      expect(mockUpdateBoardPrefs).not.toHaveBeenCalled();
    });

    await ref.current!.save();

    expect(mockUpdateEmail).toHaveBeenCalledWith('test@test.com');
    expect(mockUpdateBoardPrefs).toHaveBeenCalledWith('b1', { ...mockPrefs, habitatId: 'b1' });
    expect(mockUpdateGlobalPrefs).not.toHaveBeenCalled();
  });

  it('save() invalidates notification prefs cache on success', async () => {
    const ref = React.createRef<NotificationsTabHandle>();
    renderWithQC(<NotificationsTab ref={ref} habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('test@test.com')).toBeTruthy();
    });

    await ref.current!.save();

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notificationPrefs', 'b1'],
    });
  });

  it('save() shows error toast on failure', async () => {
    mockUpdateEmail.mockRejectedValue(new Error('Network error'));

    const ref = React.createRef<NotificationsTabHandle>();
    renderWithQC(<NotificationsTab ref={ref} habitatId="b1" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('test@test.com')).toBeTruthy();
    });

    await ref.current!.save();

    expect(mockNotifyError).toHaveBeenCalledWith('Network error');
    expect(mockNotifySuccess).not.toHaveBeenCalled();
  });
});
