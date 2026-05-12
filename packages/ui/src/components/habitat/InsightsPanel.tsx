import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Lightbulb, Loader2 } from 'lucide-react';
import { api } from '../../api/index.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { InsightCard } from './InsightCard.js';

interface InsightsPanelProps {
  boardId: string;
}

export function InsightsPanel({ boardId }: InsightsPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.insights.byBoard(boardId),
    queryFn: () => api.insights.list(boardId),
    staleTime: 30 * 1000,
  });

  const insights = data?.items ?? [];

  return (
    <div className="glass-panel rounded-lg border border-[var(--outline-variant)] overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-[var(--surface-container)]/60 hover:bg-[var(--surface-container)] transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-[var(--on-surface-variant)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--on-surface-variant)]" />
        )}
        <Lightbulb className="h-4 w-4 text-[var(--tertiary)]" />
        <span className="text-xs font-semibold text-[var(--on-surface)] uppercase tracking-wider">
          Insights
        </span>
        <span className="text-[10px] text-[var(--on-surface-variant)] ml-auto">
          {insights.length} insight{insights.length !== 1 ? 's' : ''}
        </span>
      </button>

      {!collapsed && (
        <div className="max-h-80 overflow-y-auto p-3 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
            </div>
          ) : insights.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-[var(--on-surface-variant)] gap-2">
              <Lightbulb className="h-6 w-6 opacity-30" />
              <span className="text-xs">No insights yet. Promote signals from the Pulse tab.</span>
            </div>
          ) : (
            insights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} boardId={boardId} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
