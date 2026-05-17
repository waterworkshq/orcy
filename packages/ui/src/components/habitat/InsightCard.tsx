import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeOff, Tag } from 'lucide-react';
import { api } from '../../api/index.js';
import { queryKeys } from '../../lib/queryKeys.js';
import type { ProjectInsight } from '../../types/index.js';
import { SIGNAL_LABELS, SIGNAL_COLORS } from '../../lib/signalConfig.js';

interface InsightCardProps {
  insight: ProjectInsight;
  habitatId: string;
}

export function InsightCard({ insight, habitatId }: InsightCardProps) {
  const queryClient = useQueryClient();

  const deactivateMutation = useMutation({
    mutationFn: () => api.insights.deactivate(habitatId, insight.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.insights.byBoard(habitatId) });
    },
    onError: (err: Error) => {
      console.error('Failed to deactivate insight:', err.message);
    },
  });

  const color = SIGNAL_COLORS[insight.signalType];

  return (
    <div
      className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)]/60 p-3 space-y-2 transition-colors hover:bg-[var(--surface-container)]"
      style={{ borderLeftWidth: '3px', borderLeftColor: color }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
        >
          {SIGNAL_LABELS[insight.signalType]}
        </span>
        {insight.sourceMission && (
          <span className="text-[10px] text-[var(--on-surface-variant)] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
            {insight.sourceMission}
          </span>
        )}
      </div>

      <p className="text-sm font-semibold text-[var(--on-surface)]">{insight.subject}</p>
      {insight.body && (
        <p className="text-xs text-[var(--on-surface-variant)] line-clamp-2">
          {insight.body}
        </p>
      )}

      {insight.relevanceTags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <Tag className="h-3 w-3 text-[var(--on-surface-variant)] opacity-50" />
          {insight.relevanceTags.map((tag) => (
            <span
              key={tag}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--surface-container-high)] text-[var(--on-surface-variant)]"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={() => deactivateMutation.mutate()}
          disabled={deactivateMutation.isPending}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--on-surface-variant)] hover:text-[var(--error)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
        >
          <EyeOff className="h-3 w-3" />
          {deactivateMutation.isPending ? 'Removing...' : 'Deactivate'}
        </button>
      </div>
    </div>
  );
}
