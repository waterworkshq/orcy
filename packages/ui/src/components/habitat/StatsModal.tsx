import React from 'react';
import type { HabitatTimeMetrics, MissionWithProgress } from '../../types/index.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { StatCard } from '../ui/StatCard.js';
import { X, Clock, TrendingUp, AlertTriangle, CheckCircle, AlertCircle, Layers, Timer } from 'lucide-react';
import { formatMinutes } from '../../lib/formatting.js';
import { useBoardStats, useMissions, useBoardTimeMetrics } from '../../lib/useHabitatData.js';

interface StatsModalProps {
  habitatId: string;
  onClose: () => void;
}

function FeatureStatusBar({ features }: { features: MissionWithProgress[] }) {
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

export function StatsModal({ habitatId, onClose }: StatsModalProps) {
  const { data: stats, isLoading: statsLoading } = useBoardStats(habitatId);
  const { data: featuresData, isLoading: featuresLoading } = useMissions(habitatId);
  const { data: timeMetrics } = useBoardTimeMetrics(habitatId);

  const loading = statsLoading || featuresLoading;
  const features = featuresData?.features ?? [];

  const totalFeatures = features.length;
  const doneFeatures = features.filter((f) => f.status === 'done').length;
  const inProgressFeatures = features.filter((f) => f.status === 'in_progress').length;
  const blockedFeatures = features.filter((f) =>
    f.dependsOn.length > 0 && f.dependsOn.every((depId: string) => {
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
              <StatCard
                icon={Layers}
                label="Missions"
                value={totalFeatures}
                subtitle={`${doneFeatures} done · ${inProgressFeatures} in progress`}
              />
              <StatCard
                icon={CheckCircle}
                label="Completion"
                value={totalFeatures > 0 ? `${Math.round((doneFeatures / totalFeatures) * 100)}%` : '0%'}
                subtitle={`${doneFeatures}/${totalFeatures} missions`}
              />
              <StatCard
                icon={AlertTriangle}
                label="Blocked"
                value={blockedFeatures}
                subtitle={`${totalFeatures - blockedFeatures} dependencies met`}
              />
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
              <StatCard
                icon={Clock}
                label="Avg Cycle"
                value={stats.cycleTime.averageMinutes > 0 ? formatMinutes(stats.cycleTime.averageMinutes) : '—'}
                subtitle={`median ${formatMinutes(stats.cycleTime.medianMinutes)} · ${stats.cycleTime.count} tasks`}
              />
              <StatCard
                icon={TrendingUp}
                label="Throughput"
                value={stats.throughput.thisWeek}
                subtitle={`this week · ${stats.throughput.thisMonth} this month`}
              />
              <StatCard
                icon={CheckCircle}
                label="Today"
                value={stats.throughput.today}
                subtitle="completed"
              />
            </div>

            <Card>
              <CardHeader className="p-3">
                <CardTitle className="text-sm">WIP Health</CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                {stats.wipHealth.map((col: { columnId: string; columnName: string; habitatId: string; habitatName: string; current: number; limit: number | null; health: string }) => (
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
