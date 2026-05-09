import { clsx } from 'clsx';

export interface SkeletonHeaderProps {
  className?: string;
}

export function SkeletonHeader({ className }: SkeletonHeaderProps) {
  return (
    <div
      data-testid="skeleton-header"
      className={clsx(
        'flex items-center justify-between px-4 py-3 border-b border-[var(--outline-variant)]',
        className
      )}
    >
      <div className="flex items-center gap-3">
        <div className="skeleton h-6 w-48 rounded" />
        <div className="skeleton h-5 w-16 rounded-full" />
        <div className="skeleton h-5 w-20 rounded-full" />
      </div>
      <div className="flex items-center gap-3">
        <div className="skeleton h-4 w-20 rounded" />
        <div className="skeleton h-4 w-20 rounded" />
        <div className="skeleton h-4 w-20 rounded" />
        <div className="skeleton h-8 w-24 rounded-md" />
      </div>
    </div>
  );
}
