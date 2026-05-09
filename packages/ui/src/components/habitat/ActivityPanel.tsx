import React, { useState, useEffect, useCallback } from 'react';
import { Drawer } from '../ui/Drawer.js';
import { Button } from '../ui/Button.js';
import { api } from '../../api/index.js';
import { useBoardStore } from '../../store/habitatStore.js';
import { useModalStore } from '../../store/modalStore.js';
import { CheckCircle, XCircle, User, Circle, ArrowRight, Clock, AlertTriangle } from 'lucide-react';
import type { EnrichedBoardEvent, EventAction, Anomaly } from '../../types/index.js';

interface ActivityPanelProps {
  onClose: () => void;
}

type FilterType = 'all' | 'claims' | 'submissions' | 'approvals' | 'rejections';

const actionFilters: Record<FilterType, EventAction[]> = {
  all: [],
  claims: ['claimed'],
  submissions: ['submitted'],
  approvals: ['approved'],
  rejections: ['rejected'],
};

function formatRelativeTime(timestamp: string): string {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
}

function getActionIcon(action: EventAction) {
  switch (action) {
    case 'approved':
    case 'completed':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'rejected':
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'claimed':
    case 'started':
      return <User className="h-4 w-4 text-blue-500" />;
    case 'created':
      return <Circle className="h-4 w-4 text-primary" />;
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" />;
  }
}

function getActionVerb(action: EventAction): string {
  switch (action) {
    case 'created': return 'created';
    case 'claimed': return 'claimed';
    case 'started': return 'started';
    case 'submitted': return 'submitted';
    case 'approved': return 'approved';
    case 'rejected': return 'rejected';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'moved': return 'moved';
    case 'released': return 'released';
    case 'dependency_resolved': return 'resolved dependency for';
    case 'updated': return 'updated';
    default: return action;
  }
}

function EventRow({ event, onTaskClick }: { event: EnrichedBoardEvent; onTaskClick: (taskId: string) => void }) {
  const actorName = event.actorName ?? (event.actorType === 'human' ? 'Human' : event.actorType === 'system' ? 'System' : event.actorId.substring(0, 8));
  const verb = getActionVerb(event.action);

  let detail = '';
  if (event.fromColumnName && event.toColumnName) {
    detail = `${event.fromColumnName} → ${event.toColumnName}`;
  } else if (event.fromColumnName) {
    detail = `from ${event.fromColumnName}`;
  } else if (event.toColumnName) {
    detail = `to ${event.toColumnName}`;
  } else if (event.metadata && typeof event.metadata === 'object' && 'reason' in event.metadata) {
    detail = String((event.metadata as { reason: string }).reason);
  }

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors border-b"
      onClick={() => onTaskClick(event.taskId)}
    >
      <div className="mt-0.5">{getActionIcon(event.action)}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm">
          <span className="font-medium">{actorName}</span>
          {' '}
          <span className="text-muted-foreground">{verb}</span>
          {' '}
          <span
            className="font-medium text-primary hover:underline"
            onClick={(e) => { e.stopPropagation(); onTaskClick(event.taskId); }}
          >
            "{event.taskTitle}"
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatRelativeTime(event.timestamp)}
          </span>
          {detail && (
            <>
              <span>·</span>
              <span>{detail}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ActivityPanel({ onClose }: ActivityPanelProps) {
  const { board, boardEvents, setBoardEvents, prependBoardEvent, agents, tasks } = useBoardStore();
  const openModal = useModalStore((s) => s.openModal);
  const [filter, setFilter] = useState<FilterType>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);

  const boardId = board?.id;
  const limit = 50;

  useEffect(() => {
    if (boardId) {
      api.boards.anomalies(boardId).then(({ anomalies: a }) => setAnomalies(a)).catch(() => {});
    }
  }, [boardId]);

  const loadEvents = useCallback(async (reset = false) => {
    if (!boardId) return;
    setIsLoading(true);
    try {
      const newOffset = reset ? 0 : offset;
      const actions = actionFilters[filter];
      const { events, total: totalCount } = await api.boards.events(boardId, {
        limit,
        offset: newOffset,
        action: actions.length === 1 ? actions[0] : undefined,
        ...(actions.length > 1 && { actions: actions.join(',') }),
      });
      if (reset) {
        setBoardEvents(events);
        setOffset(limit);
      } else {
        setBoardEvents([...boardEvents, ...events]);
        setOffset(newOffset + limit);
      }
      setTotal(totalCount);
      setHasMore(newOffset + events.length < totalCount);
    } catch (err) {
      console.warn('Failed to load board events:', err);
    } finally {
      setIsLoading(false);
    }
  }, [boardId, filter, offset, boardEvents, setBoardEvents]);

  useEffect(() => {
    if (boardId) {
      loadEvents(true);
    }
  }, [boardId, filter]);

  useEffect(() => {
    if (!boardId) return;

    const timeout = setTimeout(() => {
      api.boards.events(boardId, { limit: 1 }).then(({ events }) => {
        if (events.length > 0 && boardEvents.length > 0 && events[0].id !== boardEvents[0].id) {
          const task = tasks.find(t => t.id === events[0].taskId);
          const agent = agents.find(a => a.id === events[0].actorId);
          const enrichedEvent: EnrichedBoardEvent = {
            ...events[0],
            taskTitle: task?.title ?? events[0].taskTitle,
            actorName: agent?.name ?? events[0].actorName,
          };
          prependBoardEvent(enrichedEvent);
        }
      }).catch(() => {});
    }, 500);

    return () => clearTimeout(timeout);
  }, [boardId, tasks, agents, boardEvents, prependBoardEvent]);

  const handleTaskClick = (taskId: string) => {
    openModal(taskId);
    onClose();
  };

  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter);
    setOffset(0);
  };

  const filteredEvents = filter === 'all'
    ? boardEvents
    : boardEvents.filter(e => actionFilters[filter].includes(e.action));

  return (
    <Drawer open={true} onClose={onClose} className="w-full max-w-md flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h2 className="font-semibold">Activity Feed</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      <div className="flex items-center gap-2 px-4 py-2 border-b overflow-x-auto">
        {(['all', 'claims', 'submissions', 'approvals', 'rejections'] as FilterType[]).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => handleFilterChange(f)}
            className="capitalize text-xs"
          >
            {f}
          </Button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {anomalies.length > 0 && (
          <div className="border-b border-border">
            <div className="px-4 py-2 bg-destructive/5">
              <h3 className="text-xs font-semibold text-destructive uppercase tracking-wide flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Active Anomalies ({anomalies.length})
              </h3>
            </div>
            {anomalies.map((anomaly, i) => {
              const severityColors: Record<string, string> = { low: 'glass-badge glass-badge-low', medium: 'glass-badge glass-badge-medium', high: 'glass-badge glass-badge-high', critical: 'glass-badge glass-badge-critical' };
              return (
                <div key={i} className="flex items-start gap-3 px-4 py-3 border-b bg-destructive/5">
                  <AlertTriangle className={`h-4 w-4 mt-0.5 ${anomaly.severity === 'critical' ? 'text-red-500' : anomaly.severity === 'high' ? 'text-orange-500' : anomaly.severity === 'medium' ? 'text-amber-500' : 'text-blue-500'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${severityColors[anomaly.severity] ?? ''}`}>
                        {anomaly.severity}
                      </span>
                      <span className="text-xs text-muted-foreground">{anomaly.type.replace(/_/g, ' ')}</span>
                    </div>
                    <p className="text-sm mt-1">{anomaly.message}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {filteredEvents.length === 0 && !isLoading && anomalies.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            No activity yet
          </div>
        ) : (
          <>
            {filteredEvents.map((event) => (
              <EventRow key={event.id} event={event} onTaskClick={handleTaskClick} />
            ))}
            {hasMore && (
              <div className="flex justify-center py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadEvents(false)}
                  disabled={isLoading}
                >
                  {isLoading ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
