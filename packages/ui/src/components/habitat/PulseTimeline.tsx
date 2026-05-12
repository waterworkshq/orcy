import React from 'react';
import { Radio } from 'lucide-react';
import { PulseSignalCard } from './PulseSignalCard.js';
import { PulseReplyThread } from './PulseReplyThread.js';
import type { Pulse } from '../../types/index.js';

interface PulseTimelineProps {
  pulses: Pulse[];
  isLoading: boolean;
  missionId: string;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
}

export function PulseTimeline({ pulses, isLoading, missionId, hasMore, onLoadMore, loadingMore }: PulseTimelineProps) {
  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)]/60 p-3 space-y-2 animate-pulse">
            <div className="flex gap-2">
              <div className="h-4 w-16 bg-[var(--surface-container-high)] rounded" />
              <div className="h-4 w-20 bg-[var(--surface-container-high)] rounded" />
            </div>
            <div className="h-4 w-3/4 bg-[var(--surface-container-high)] rounded" />
            <div className="h-3 w-1/2 bg-[var(--surface-container-high)] rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (pulses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-[var(--on-surface-variant)] gap-3">
        <Radio className="h-10 w-10 opacity-30" />
        <p className="text-sm">No signals yet</p>
        <p className="text-[11px] opacity-60">Post a signal to start the conversation</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {pulses.map((pulse) => (
        <div key={pulse.id} className="space-y-1">
          <PulseSignalCard pulse={pulse} missionId={missionId} />
          {!pulse.replyToId && (
            <PulseReplyThread pulse={pulse} missionId={missionId} />
          )}
        </div>
      ))}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="px-4 py-2 text-xs font-medium text-[var(--on-surface-variant)] bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded-lg hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
