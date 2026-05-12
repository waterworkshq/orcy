import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/index.js';

interface PulseUnreadBadgeProps {
  missionId: string;
}

export function PulseUnreadBadge({ missionId }: PulseUnreadBadgeProps) {
  const { data } = useQuery({
    queryKey: ['pulse', 'digest', missionId],
    queryFn: () => api.pulse.digest(missionId),
    staleTime: 60 * 1000,
  });

  if (!data || data.newSinceLastCheck === 0) return null;

  return (
    <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--primary)] text-[var(--on-primary)] text-[10px] font-bold">
      {data.newSinceLastCheck > 99 ? '99+' : data.newSinceLastCheck}
    </span>
  );
}
