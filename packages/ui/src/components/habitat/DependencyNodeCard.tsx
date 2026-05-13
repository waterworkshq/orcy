import { clsx } from 'clsx';
import type { FeatureStatus } from '../../types/index.js';
import { FEATURE_STATUS_DOT } from '../../lib/status-maps.js';

const statusDotColor: Record<FeatureStatus, string> = {
  not_started: FEATURE_STATUS_DOT.not_started,
  in_progress: FEATURE_STATUS_DOT.in_progress,
  review: FEATURE_STATUS_DOT.review,
  done: FEATURE_STATUS_DOT.done,
  failed: FEATURE_STATUS_DOT.failed,
};

export interface DependencyNodeCardProps {
  title: string;
  status: FeatureStatus;
  dependencyCount: number;
  blockerCount: number;
  onClick?: () => void;
}

export function DependencyNodeCard({
  title,
  status,
  dependencyCount,
  blockerCount,
  onClick,
}: DependencyNodeCardProps) {
  return (
    <div
      className={clsx(
        'glass-card p-2.5 cursor-pointer transition-all duration-200 hover:ring-1 hover:ring-primary/40',
        onClick && 'select-none',
      )}
      style={{ width: 220, minHeight: 56 }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <div
          className={clsx('h-2 w-2 rounded-full flex-shrink-0', statusDotColor[status] ?? 'bg-[var(--badge-low)]')}
          data-testid="status-dot"
          aria-label={`Status: ${status.replace('_', ' ')}`}
        />
        <span className="text-sm font-medium truncate flex-1 text-on-surface">{title}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-on-surface-variant">
        <span data-testid="dependency-count">Dep: {dependencyCount}</span>
        {blockerCount > 0 && (
          <span data-testid="blocker-count" className="text-[var(--badge-review-text)]">
            Blocking: {blockerCount}
          </span>
        )}
      </div>
    </div>
  );
}
