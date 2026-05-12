import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/index.js';
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
}

export function PulseReactions({ pulseId, counts, missionId }: PulseReactionsProps) {
  const queryClient = useQueryClient();
  const [activeReaction, setActiveReaction] = useState<string | null>(null);

  const reactMutation = useMutation({
    mutationFn: (reaction: string) => api.pulse.react(pulseId, reaction),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pulses', missionId] });
    },
  });

  function handleReact(reaction: string) {
    setActiveReaction(activeReaction === reaction ? null : reaction);
    reactMutation.mutate(reaction);
  }

  return (
    <div className="flex items-center gap-1">
      {REACTIONS.map(({ key, emoji }) => {
        const count = counts[key as keyof PulseReactionCounts] ?? 0;
        const isActive = activeReaction === key;
        return (
          <button
            key={key}
            onClick={() => handleReact(key)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] transition-colors ${
              isActive
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
