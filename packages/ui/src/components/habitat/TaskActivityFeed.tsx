import React from 'react';
import {
  ArrowRight,
  MessageSquare,
  UserPlus,
  PlusCircle,
  Link2,
  CheckSquare,
  User,
} from 'lucide-react';

export interface ActivityEvent {
  id: string;
  type:
    | 'status_change'
    | 'comment'
    | 'assignment'
    | 'creation'
    | 'dependency_added'
    | 'subtask_completed';
  description: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface TaskActivityFeedProps {
  events: ActivityEvent[];
}

const EVENT_ICON_MAP: Record<ActivityEvent['type'], React.ReactNode> = {
  status_change: <ArrowRight className="h-3.5 w-3.5 text-primary" />,
  comment: <MessageSquare className="h-3.5 w-3.5 text-blue-400" />,
  assignment: <UserPlus className="h-3.5 w-3.5 text-green-400" />,
  creation: <PlusCircle className="h-3.5 w-3.5 text-primary" />,
  dependency_added: <Link2 className="h-3.5 w-3.5 text-amber-400" />,
  subtask_completed: (
    <CheckSquare className="h-3.5 w-3.5 text-green-400" />
  ),
};

function formatRelativeTimestamp(timestamp: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - timestamp.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  return timestamp.toLocaleDateString();
}

function Avatar({
  userName,
  userAvatar,
}: {
  userName: string;
  userAvatar?: string;
}) {
  const initials = userName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (userAvatar) {
    return (
      <img
        src={userAvatar}
        alt={userName}
        className="w-7 h-7 rounded-full object-cover border border-outline-variant/30"
      />
    );
  }

  return (
    <div className="w-7 h-7 rounded-full bg-surface-container-high border border-outline-variant/30 flex items-center justify-center">
      {initials ? (
        <span className="text-[10px] font-bold text-on-surface-variant">
          {initials}
        </span>
      ) : (
        <User className="h-3.5 w-3.5 text-on-surface-variant" />
      )}
    </div>
  );
}

export function TaskActivityFeed({ events }: TaskActivityFeedProps) {
  const sorted = [...events].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
        <Activity className="h-8 w-8 mb-3 opacity-40" />
        <p className="text-sm">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {sorted.map((event, index) => (
        <div key={event.id} className="relative flex gap-3 pb-6 last:pb-0">
          {index < sorted.length - 1 && (
            <div className="absolute left-[13px] top-7 bottom-0 w-px bg-outline-variant/20" />
          )}

          <div className="flex-shrink-0 mt-0.5 z-10">
            <Avatar
              userName={event.userName}
              userAvatar={event.userAvatar}
            />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2">
              <div className="flex-shrink-0 mt-0.5 w-6 h-6 rounded-full bg-surface-container/80 flex items-center justify-center">
                {EVENT_ICON_MAP[event.type] ?? (
                  <div className="h-2 w-2 rounded-full bg-on-surface-variant" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm text-on-surface leading-snug">
                  <span className="font-medium">{event.userName}</span>{' '}
                  {event.description}
                </p>
                <p className="text-[11px] text-on-surface-variant mt-0.5">
                  {formatRelativeTimestamp(event.timestamp)}
                </p>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Activity({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
