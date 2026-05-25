import { SkeletonCard } from './SkeletonCard.js';

export interface SkeletonColumnProps {
  cardCount?: number;
  className?: string;
}

export function SkeletonColumn({ cardCount = 4, className }: SkeletonColumnProps) {
  return (
    <div
      data-testid="skeleton-column"
      className={`flex flex-col gap-3 ${className ?? ''}`}
    >
      <div className="flex items-center justify-between px-1 mb-1">
        <div className="skeleton h-5 w-24 rounded" />
        <div className="skeleton h-5 w-8 rounded-full" />
      </div>
      {Array.from({ length: cardCount }, (_, i) => (
        <SkeletonCard
          key={i}
          hasProgress={i % 2 === 0}
          hasBadges={i % 3 !== 0}
        />
      ))}
    </div>
  );
}
