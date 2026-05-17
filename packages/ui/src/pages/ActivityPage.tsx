import React, { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useHabitatStore } from '../store/habitatStore.js';
import { useModalStore } from '../store/modalStore.js';
import { useBoardAnomalies, useBoardEvents } from '../lib/useHabitatData.js';
import { Button } from '../components/ui/Button.js';
import { CheckCircle, XCircle, User, Circle, Clock, AlertTriangle, ArrowLeft, Activity, Loader2 } from 'lucide-react';
import { formatRelativeTime } from '../lib/formatting.js';
import type { EnrichedHabitatEvent, EventAction, Anomaly } from '../types/index.js';

type FilterType = 'all' | 'claims' | 'submissions' | 'approvals' | 'rejections';

const actionFilters: Record<FilterType, EventAction[]> = {
  all: [],
  claims: ['claimed'],
  submissions: ['submitted'],
  approvals: ['approved'],
  rejections: ['rejected'],
};

const filterLabels: Record<FilterType, string> = {
  all: 'All',
  claims: 'Claims',
  submissions: 'Submissions',
  approvals: 'Approvals',
  rejections: 'Rejections',
};



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

function EventRow({ event, onTaskClick }: { event: EnrichedHabitatEvent; onTaskClick: (taskId: string) => void }) {
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
      data-testid={`event-row-${event.id}`}
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
            &quot;{event.taskTitle}&quot;
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

export function ActivityPage() {
  const board = useHabitatStore((s) => s.board);
  const openModal = useModalStore((s) => s.openModal);
  const [filter, setFilter] = useState<FilterType>('all');
  const [pageOffset, setPageOffset] = useState(0);
  const [accumulatedEvents, setAccumulatedEvents] = useState<EnrichedHabitatEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const habitatId = board?.id;
  const limit = 50;

  const anomaliesQuery = useBoardAnomalies(habitatId);
  const anomalies = anomaliesQuery.data?.anomalies ?? [];

  const actions = actionFilters[filter];
  const eventsParams = useMemo(() => {
    const params: { limit: number; offset: number; action?: string } = { limit, offset: pageOffset };
    if (actions.length === 1) {
      params.action = actions[0];
    }
    return params;
  }, [limit, pageOffset, actions]);

  const eventsQuery = useBoardEvents(habitatId, eventsParams);

  useEffect(() => {
    if (!eventsQuery.data) return;
    const fetched = eventsQuery.data.events ?? [];
    const filtered = actions.length > 1 ? fetched.filter((e) => actions.includes(e.action)) : fetched;
    setTotal(eventsQuery.data.total);
    setHasMore(pageOffset + fetched.length < eventsQuery.data.total);

    if (pageOffset === 0) {
      setAccumulatedEvents(filtered);
    } else {
      setAccumulatedEvents((prev) => [...prev, ...filtered]);
    }
  }, [eventsQuery.data, pageOffset, actions]);

  const events = accumulatedEvents;
  const isLoading = eventsQuery.isLoading || eventsQuery.isFetching;
  const error = eventsQuery.error?.message ?? null;

  const handleTaskClick = (taskId: string) => {
    openModal(taskId);
  };

  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter);
    setPageOffset(0);
    setAccumulatedEvents([]);
    setHasMore(true);
  };

  const handleLoadMore = () => {
    setPageOffset((prev) => prev + limit);
  };

  const severityColors: Record<string, string> = {
    low: 'glass-badge',
    medium: 'glass-badge glass-badge-medium',
    high: 'glass-badge glass-badge-high',
    critical: 'glass-badge glass-badge-critical',
  };

  if (!habitatId) {
    return (
      <div className="min-h-screen bg-background">
        <header className="glass-panel ghost-border-b sticky top-0 z-10">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <div className="flex items-center gap-4">
              <Link to="/">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
              </Link>
              <div className="flex items-center gap-2">
                <Activity className="h-6 w-6 text-primary" />
                <h1 className="text-xl font-bold text-on-surface">Activity</h1>
              </div>
            </div>
          </div>
        </header>
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Activity className="h-16 w-16 text-on-surface-variant/30 mb-4" />
            <h2 className="text-lg font-semibold text-on-surface mb-2">
              No board selected
            </h2>
            <p className="text-sm text-on-surface-variant">
              Select a board from the workspace to view its activity.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="glass-panel ghost-border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
              </Link>
              <div className="flex items-center gap-2">
                <Activity className="h-6 w-6 text-primary" />
                <h1 className="text-xl font-bold text-on-surface">Activity</h1>
              </div>
            </div>
            {total > 0 && (
              <span className="text-sm text-muted-foreground">{total} events</span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex items-center gap-2 mb-4 overflow-x-auto">
          {(['all', 'claims', 'submissions', 'approvals', 'rejections'] as FilterType[]).map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => handleFilterChange(f)}
              data-testid={`filter-${f}`}
            >
              {filterLabels[f]}
            </Button>
          ))}
        </div>

        {anomalies.length > 0 && (
          <div className="mb-4 border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-destructive/5">
              <h3 className="text-xs font-semibold text-destructive uppercase tracking-wide flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Active Anomalies ({anomalies.length})
              </h3>
            </div>
            {anomalies.map((anomaly, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3 border-t bg-destructive/5">
                <AlertTriangle className={`h-4 w-4 mt-0.5 ${anomaly.severity === 'critical' ? 'text-destructive' : anomaly.severity === 'high' ? 'text-orange-500' : anomaly.severity === 'medium' ? 'text-amber-500' : 'text-primary'}`} />
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
            ))}
          </div>
        )}

        {isLoading && events.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-3 text-on-surface-variant">Loading activity...</span>
          </div>
        ) : error ? (
          <div className="glass-card rounded-lg border border-border p-12 text-center text-destructive">
            {error}
          </div>
        ) : events.length === 0 && anomalies.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Activity className="h-16 w-16 text-on-surface-variant/30 mb-4" />
            <h2 className="text-lg font-semibold text-on-surface mb-2">
              No activity yet
            </h2>
            <p className="text-sm text-on-surface-variant">
              Events will appear here as work happens on the board.
            </p>
          </div>
        ) : (
          <div className="glass-card rounded-lg border border-border overflow-hidden">
            {events.map((event) => (
              <EventRow key={event.id} event={event} onTaskClick={handleTaskClick} />
            ))}
            {hasMore && (
              <div className="flex justify-center py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLoadMore}
                  disabled={isLoading}
                  data-testid="load-more"
                >
                  {isLoading ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
