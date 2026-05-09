import * as React from 'react';
import { clsx } from 'clsx';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, Trash2, X } from 'lucide-react';
import { useBoardStore } from '../../store/habitatStore.js';
import type { Notification } from '../../types/index.js';

interface NotificationDropdownProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString();
}

function NotificationItem({
  notification,
  onRead,
  onNavigate,
}: {
  notification: Notification;
  onRead: (id: string) => void;
  onNavigate: (taskId: string) => void;
}) {
  const handleClick = () => {
    if (!notification.read) onRead(notification.id);
    onNavigate(notification.taskId);
  };

  return (
    <button
      type="button"
      className={clsx(
        'w-full text-left px-3 py-2.5 rounded-lg transition-colors hover:bg-surface-container-high',
        !notification.read && 'bg-primary-container/20',
      )}
      onClick={handleClick}
      data-testid={`notification-item-${notification.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-on-surface truncate">
            {notification.taskTitle}
          </p>
          <p className="text-xs text-on-surface-variant mt-0.5 truncate">
            {notification.agentName ? `${notification.agentName} — ` : ''}
            {notification.message}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!notification.read && (
            <span className="h-2 w-2 rounded-full bg-primary" data-testid={`unread-dot-${notification.id}`} />
          )}
          <span className="text-[10px] text-on-surface-variant">
            {formatTimestamp(notification.timestamp)}
          </span>
        </div>
      </div>
    </button>
  );
}

export function NotificationDropdown({ isOpen, onClose }: NotificationDropdownProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const notifications = useBoardStore((s) => s.notifications);
  const markNotificationRead = useBoardStore((s) => s.markNotificationRead);
  const clearNotifications = useBoardStore((s) => s.clearNotifications);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleNavigate = (taskId: string) => {
    onClose();
    navigate(`/features/${taskId}`);
  };

  return (
    <div ref={containerRef} className="absolute right-0 top-full mt-2 z-50" data-testid="notification-dropdown">
      <div className="glass-card w-80 sm:w-96 rounded-xl shadow-xl border border-outline-variant/15 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant/15">
          <div className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 text-on-surface-variant" />
            <span className="text-xs font-headline font-bold uppercase tracking-wide text-on-surface">
              Notifications
            </span>
            {unreadCount > 0 && (
              <span className="glass-badge glass-badge-active rounded-full px-1.5 py-0.5 text-[10px] font-bold" data-testid="unread-count">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={clearNotifications}
                className="rounded-full p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
                title="Clear all"
                data-testid="clear-all-btn"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 px-4" data-testid="empty-state">
              <Bell className="h-8 w-8 text-on-surface-variant/40 mb-2" />
              <p className="text-xs text-on-surface-variant">No notifications yet</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1 p-2">
              {notifications.map((n) => (
                <NotificationItem
                  key={n.id}
                  notification={n}
                  onRead={markNotificationRead}
                  onNavigate={handleNavigate}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
