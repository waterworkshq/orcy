import { clsx } from 'clsx';

export interface SkeletonCardProps {
  className?: string;
  hasPriority?: boolean;
  hasBadges?: boolean;
  hasProgress?: boolean;
}

export function SkeletonCard({
  className,
  hasPriority = true,
  hasBadges = true,
  hasProgress = true,
}: SkeletonCardProps) {
  return (
    <div
      data-testid="skeleton-card"
      className={clsx(
        'glass-card p-3 border-l-[3px] border-l-[var(--surface-container-highest)]',
        className
      )}
    >
      <div className="skeleton h-4 w-3/4 rounded" />
      {hasPriority && hasBadges && (
        <div className="flex items-center gap-1.5 mt-2">
          <div className="skeleton h-5 w-16 rounded-full" />
          <div className="skeleton h-5 w-20 rounded-full" />
        </div>
      )}
      {hasProgress && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-1">
            <div className="skeleton h-3 w-16 rounded" />
            <div className="skeleton h-3 w-8 rounded" />
          </div>
          <div className="skeleton h-1.5 w-full rounded-full" />
        </div>
      )}
    </div>
  );
}
