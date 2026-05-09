import { clsx } from 'clsx';

export interface SkeletonModalProps {
  className?: string;
}

export function SkeletonModal({ className }: SkeletonModalProps) {
  return (
    <div
      data-testid="skeleton-modal"
      className={clsx(
        'glass-modal p-6 max-w-3xl mx-auto',
        className
      )}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="skeleton h-6 w-2/3 rounded" />
        <div className="skeleton h-8 w-8 rounded-full" />
      </div>

      <div className="flex items-center gap-4 mb-6">
        <div className="skeleton h-5 w-24 rounded-full" />
        <div className="skeleton h-5 w-20 rounded-full" />
        <div className="skeleton h-5 w-28 rounded" />
      </div>

      <div className="grid grid-cols-7 gap-6 mb-6">
        <div className="col-span-4 space-y-3">
          <div className="skeleton h-4 w-full rounded" />
          <div className="skeleton h-4 w-5/6 rounded" />
          <div className="skeleton h-4 w-4/6 rounded" />
          <div className="skeleton h-4 w-full rounded" />
          <div className="skeleton h-4 w-3/4 rounded" />
        </div>
        <div className="col-span-3 space-y-3">
          <div className="skeleton h-4 w-full rounded" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="skeleton h-8 w-8 rounded-full shrink-0" />
              <div className="flex-1 space-y-1">
                <div className="skeleton h-3 w-3/4 rounded" />
                <div className="skeleton h-3 w-1/2 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-4 border-t border-[var(--outline-variant)]">
        <div className="skeleton h-9 w-24 rounded-md" />
        <div className="skeleton h-9 w-28 rounded-md" />
      </div>
    </div>
  );
}
