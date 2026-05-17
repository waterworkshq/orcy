import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { NotificationDropdown } from './NotificationDropdown.js';
import type { Notification } from '../../types/index.js';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const mockMarkRead = vi.fn();
const mockClearNotifications = vi.fn();

let notificationsState: Notification[] = [];

const useBoardStoreMock = vi.fn((selector?: any) => {
  const state = {
    notifications: notificationsState,
    markNotificationRead: mockMarkRead,
    clearNotifications: mockClearNotifications,
  };
  if (selector) return selector(state);
  return state;
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

describe('NotificationDropdown', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    notificationsState = [];
    mockNavigate.mockClear();
    mockMarkRead.mockClear();
    mockClearNotifications.mockClear();
    mockOnClose.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders notification list when open', () => {
    notificationsState = [
      makeNotification({ id: 'n1', taskTitle: 'Task A' }),
      makeNotification({ id: 'n2', taskTitle: 'Task B' }),
    ];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId('notification-dropdown')).toBeTruthy();
    expect(screen.getByText('Task A')).toBeTruthy();
    expect(screen.getByText('Task B')).toBeTruthy();
  });

  it('returns null when closed', () => {
    render(<NotificationDropdown isOpen={false} onClose={mockOnClose} />);
    expect(screen.queryByTestId('notification-dropdown')).toBeNull();
  });

  it('shows empty state when no notifications', () => {
    notificationsState = [];
    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId('empty-state')).toBeTruthy();
    expect(screen.getByText('No notifications yet')).toBeTruthy();
  });

  it('calls markNotificationRead when unread notification clicked', () => {
    const notif = makeNotification({ id: 'n1', read: false });
    notificationsState = [notif];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId('notification-item-n1'));
    expect(mockMarkRead).toHaveBeenCalledWith('n1');
  });

  it('does not call markNotificationRead for already-read notifications', () => {
    const notif = makeNotification({ id: 'n1', read: true });
    notificationsState = [notif];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId('notification-item-n1'));
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it('navigates to task when notification clicked', () => {
    const notif = makeNotification({ id: 'n1', taskId: 'task-42' });
    notificationsState = [notif];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId('notification-item-n1'));
    expect(mockNavigate).toHaveBeenCalledWith('/features/task-42');
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('calls clearNotifications when Clear all clicked', () => {
    notificationsState = [makeNotification()];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByTestId('clear-all-btn'));
    expect(mockClearNotifications).toHaveBeenCalled();
  });

  it('does not show Clear all button when no notifications', () => {
    notificationsState = [];
    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);
    expect(screen.queryByTestId('clear-all-btn')).toBeNull();
  });

  it('closes on Escape key press', () => {
    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('does not listen for Escape when closed', () => {
    render(<NotificationDropdown isOpen={false} onClose={mockOnClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('closes on outside click', () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <NotificationDropdown isOpen={true} onClose={mockOnClose} />
      </div>,
    );

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside dropdown', () => {
    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    fireEvent.mouseDown(screen.getByTestId('notification-dropdown'));
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('shows unread count badge when there are unread notifications', () => {
    notificationsState = [
      makeNotification({ id: 'n1', read: false }),
      makeNotification({ id: 'n2', read: true }),
    ];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByTestId('unread-count')).toBeTruthy();
    expect(screen.getByTestId('unread-count').textContent).toBe('1');
  });

  it('shows unread dot for unread notifications', () => {
    notificationsState = [
      makeNotification({ id: 'n1', read: false }),
    ];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByTestId('unread-dot-n1')).toBeTruthy();
  });

  it('hides unread dot for read notifications', () => {
    notificationsState = [
      makeNotification({ id: 'n1', read: true }),
    ];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);
    expect(screen.queryByTestId('unread-dot-n1')).toBeNull();
  });

  it('shows agent name in notification', () => {
    notificationsState = [
      makeNotification({ id: 'n1', agentName: 'Bot-42', message: 'Done' }),
    ];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByText(/Bot-42 — Done/)).toBeTruthy();
  });

  it('omits agent prefix when agentName is undefined', () => {
    notificationsState = [
      makeNotification({ id: 'n1', agentName: undefined, message: 'System alert' }),
    ];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);
    expect(screen.getByText('System alert')).toBeTruthy();
  });

  it('displays notifications in reverse chronological order', () => {
    notificationsState = [
      makeNotification({ id: 'new', taskTitle: 'Newest', timestamp: new Date('2026-01-02').toISOString() }),
      makeNotification({ id: 'old', taskTitle: 'Oldest', timestamp: new Date('2026-01-01').toISOString() }),
    ];

    render(<NotificationDropdown isOpen={true} onClose={mockOnClose} />);
    const items = screen.getAllByTestId(/^notification-item-/);
    expect(items[0].textContent).toContain('Newest');
    expect(items[1].textContent).toContain('Oldest');
  });
});
