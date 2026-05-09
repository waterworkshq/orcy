import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/index.js';
import type { BoardStats, BoardTimeMetrics, FeatureWithProgress } from '../../types/index.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { X, Clock, TrendingUp, AlertTriangle, CheckCircle, AlertCircle, Layers, Timer } from 'lucide-react';

interface StatsModalProps {
  boardId: string;
  onClose: () => void;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function FeatureStatusBar({ features }: { features: FeatureWithProgress[] }) {
  const total = features.length;
  if (total === 0) return null;

  const counts = {
    not_started: features.filter((f) => f.status === 'not_started').length,
    in_progress: features.filter((f) => f.status === 'in_progress').length,
    review: features.filter((f) => f.status === 'review').length,
    done: features.filter((f) => f.status === 'done').length,
    failed: features.filter((f) => f.status === 'failed').length,
  };

  const colors: Record<string, string> = {
    not_started: 'bg-[var(--badge-low)]',
    in_progress: 'bg-[var(--badge-active)]',
    review: 'bg-[var(--badge-review)]',
    done: 'bg-[var(--badge-done)]',
    failed: 'bg-[var(--badge-blocked)]',
  };

  return (
    <div className="space-y-1.5">
      <div className="flex h-2 rounded-full overflow-hidden bg-muted">
        {Object.entries(counts).map(([status, count]) => (
          count > 0 && (
            <div
              key={status}
              className={colors[status]}
              style={{ width: `${(count / total) * 100}%` }}
              title={`${status}: ${count}`}
            />
          )
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {Object.entries(counts).map(([status, count]) => (
          count > 0 && (
            <span key={status} className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${colors[status]}`} />
              {status.replace('_', ' ')}: {count}
            </span>
          )
        ))}
      </div>
    </div>
  );
}

export function StatsModal({ boardId, onClose }: StatsModalProps) {
  const [stats, setStats] = useState<BoardStats | null>(null);
  const [features, setFeatures] = useState<FeatureWithProgress[]>([]);
  const [loading, setLoading] = useState(true);

  const { data: timeMetrics } = useQuery<BoardTimeMetrics>({
    queryKey: ['board', boardId, 'timeMetrics'],
    queryFn: () => api.timeTracking.getBoardMetrics(boardId),
    enabled: !!boardId,
  });

  useEffect(() => {
    Promise.all([
      api.boards.stats(boardId),
      api.features.list(boardId),
    ])
      .then(([statsData, featuresData]) => {
        setStats(statsData);
        setFeatures(featuresData.features);
      })
      .catch((err) => console.warn('Failed to load stats:', err))
      .finally(() => setLoading(false));
  }, [boardId]);

  const totalFeatures = features.length;
  const doneFeatures = features.filter((f) => f.status === 'done').length;
  const inProgressFeatures = features.filter((f) => f.status === 'in_progress').length;
  const blockedFeatures = features.filter((f) =>
    f.dependsOn.length > 0 && f.dependsOn.every((depId) => {
      const dep = features.find((f) => f.id === depId);
      return !dep || dep.status !== 'done';
    })
  ).length;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-t-xl md:rounded-xl bg-surface-container/85 backdrop-blur-2xl p-4 md:p-6 shadow-xl animate-fade-in max-h-[85vh] md:max-h-none overflow-y-auto mobile-dialog-full border border-outline-variant/15">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Habitat Statistics</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}

        {!loading && stats && (
          <div className="space-y-4">
            {/* Feature-level stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Layers className="h-3 w-3" />
                    Missions
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-2xl font-bold">{totalFeatures}</p>
                  <p className="text-xs text-muted-foreground">
                    {doneFeatures} done · {inProgressFeatures} in progress
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle className="h-3 w-3" />
                    Completion
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-2xl font-bold">
                    {totalFeatures > 0 ? Math.round((doneFeatures / totalFeatures) * 100) : 0}%
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {doneFeatures}/{totalFeatures} missions
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3 w-3" />
                    Blocked
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-2xl font-bold">{blockedFeatures}</p>
                  <p className="text-xs text-muted-foreground">
                    {totalFeatures - blockedFeatures} dependencies met
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Feature status distribution */}
            {totalFeatures > 0 && (
              <Card>
                <CardHeader className="p-3">
                  <CardTitle className="text-sm">Mission Status Distribution</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <FeatureStatusBar features={features} />
                </CardContent>
              </Card>
            )}

            {/* Task-level stats (existing) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Avg Cycle
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-2xl font-bold">
                    {stats.cycleTime.averageMinutes > 0
                      ? formatMinutes(stats.cycleTime.averageMinutes)
                      : '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    median {formatMinutes(stats.cycleTime.medianMinutes)} · {stats.cycleTime.count} tasks
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <TrendingUp className="h-3 w-3" />
                    Throughput
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-2xl font-bold">{stats.throughput.thisWeek}</p>
                  <p className="text-xs text-muted-foreground">
                    this week · {stats.throughput.thisMonth} this month
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle className="h-3 w-3" />
                    Today
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-2xl font-bold">{stats.throughput.today}</p>
                  <p className="text-xs text-muted-foreground">completed</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="p-3">
                <CardTitle className="text-sm">WIP Health</CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                {stats.wipHealth.map((col) => (
                  <div key={col.columnId} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {col.health === 'ok' && <CheckCircle className="h-3.5 w-3.5 text-green-600" />}
                      {col.health === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                      {col.health === 'exceeded' && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
                      <span className="text-sm">{col.columnName}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {col.limit !== null ? (
                        <>
                          <span className={`text-sm font-medium ${
                            col.health === 'ok' ? 'text-green-600' :
                            col.health === 'warning' ? 'text-amber-600' : 'text-red-600'
                          }`}>
                            {col.current}/{col.limit}
                          </span>
                          {col.health === 'exceeded' && (
                            <span className="text-xs text-red-600">at limit</span>
                          )}
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {col.current} tasks
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {stats.wipHealth.length === 0 && (
                  <p className="text-sm text-muted-foreground">No columns found.</p>
                )}
              </CardContent>
            </Card>

            {timeMetrics && (
              <Card>
                <CardHeader className="p-3">
                  <CardTitle className="flex items-center gap-1.5 text-sm">
                    <Timer className="h-3.5 w-3.5" />
                    Time Metrics
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Avg Cycle Time</p>
                      <p className="text-lg font-bold">{formatMinutes(timeMetrics.averageCycleTime)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Avg Lead Time</p>
                      <p className="text-lg font-bold">{formatMinutes(timeMetrics.averageLeadTime)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Estimation Accuracy</p>
                      <p className="text-lg font-bold">{Math.round(timeMetrics.averageEstimationAccuracy * 100)}%</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">On-time Rate</p>
                      <p className="text-lg font-bold">{Math.round(timeMetrics.onTimeCompletionRate * 100)}%</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Planned vs Actual</p>
                      <p className="text-lg font-bold">
                        {formatMinutes(timeMetrics.totalPlannedMinutes)} / {formatMinutes(timeMetrics.totalActualMinutes)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Overdue Tasks</p>
                      <p className={`text-lg font-bold ${timeMetrics.overdueTasks > 0 ? 'text-red-600' : ''}`}>
                        {timeMetrics.overdueTasks}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
