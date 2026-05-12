import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { api } from '../../api/index.js';
import { PulseSignalCard } from './PulseSignalCard.js';
import type { Pulse } from '../../types/index.js';

interface PulseReplyThreadProps {
  pulse: Pulse;
  missionId: string;
  replyCount?: number;
}

export function PulseReplyThread({ pulse, missionId, replyCount }: PulseReplyThreadProps) {
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['pulse-replies', pulse.id],
    queryFn: () => api.pulse.replies(pulse.id),
    enabled: expanded,
  });

  const replies = data?.replies ?? [];
  const count = replyCount ?? replies.length;

  if (count === 0 && !expanded) return null;

  return (
    <div className="pl-4 border-l border-[var(--outline-variant)] ml-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-[var(--on-surface-variant)] hover:text-[var(--on-surface)] transition-colors py-1"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <MessageSquare className="h-3 w-3" />
        <span>{count} {count === 1 ? 'reply' : 'replies'}</span>
      </button>

      {expanded && (
        <div className="space-y-2 mt-1">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: Math.min(count, 3) }).map((_, i) => (
                <div key={i} className="h-16 bg-[var(--surface-container-high)] rounded animate-pulse" />
              ))}
            </div>
          ) : (
            replies.map((reply) => (
              <PulseSignalCard
                key={reply.id}
                pulse={reply}
                missionId={missionId}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
