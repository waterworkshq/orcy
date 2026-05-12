import React, { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/index.js';
import { queryKeys } from '../../lib/queryKeys.js';
import type { PulseReactionCounts } from '../../types/index.js';

const REACTIONS = [
  { key: 'seen', emoji: '👁', label: 'Seen' },
  { key: 'ack', emoji: '👍', label: 'Acknowledge' },
  { key: 'question', emoji: '❓', label: 'Question' },
] as const;

interface PulseReactionsProps {
  pulseId: string;
  counts: PulseReactionCounts;
  missionId: string;
  boardId?: string;
}

export function PulseReactions({ pulseId, counts, missionId, boardId }: PulseReactionsProps) {
  const queryClient = useQueryClient();

  const reactMutation = useMutation({
    mutationFn: (reaction: string) => api.pulse.react(pulseId, reaction),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pulse.byMission(missionId) });
      if (boardId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.pulse.byBoard(boardId) });
      }
    },
    onError: (err: Error) => {
      console.error('Reaction failed:', err.message);
    },
  });

  const handleReact = useCallback((reaction: string) => {
    if (reactMutation.isPending) return;
    reactMutation.mutate(reaction);
  }, [reactMutation]);

  return (
    <div className="flex items-center gap-1">
      {REACTIONS.map(({ key, emoji }) => {
        const count = counts[key as keyof PulseReactionCounts] ?? 0;
        return (
          <button
            key={key}
            onClick={() => handleReact(key)}
            disabled={reactMutation.isPending}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] transition-colors disabled:opacity-50 ${
              count > 0
                ? 'bg-[var(--primary-container)] text-[var(--on-primary-container)]'
                : 'bg-[var(--surface-container-high)] text-[var(--on-surface-variant)] hover:bg-[var(--surface-container)]'
            }`}
          >
            <span>{emoji}</span>
            {count > 0 && <span>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
